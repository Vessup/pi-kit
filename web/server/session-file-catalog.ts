import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { WebSession } from "../protocol.js";
import { lastAutoRoutedModelFromEntries } from "../model-status.js";
import {
  replacementFromEntries,
  WORKTREE_REPLACEMENT_ENTRY,
} from "../worktree-replacement.js";
import type { ManagedSessionStore } from "./managed-session-store.js";
import {
  managedWorktreeFromEntries,
  WORKTREE_SESSION_ENTRY,
} from "./worktrees.js";

export type SessionFileScan = {
  session: WebSession;
  file: string;
  history: unknown[];
  entries: unknown[];
  header?: Record<string, unknown>;
  managedWorktreeScanned?: boolean;
  replacement?: ReturnType<typeof replacementFromEntries>;
};

export function createSessionFileCatalog(options: {
  sessionsDir: string;
  managedSessionStore: ManagedSessionStore;
}) {
  const { sessionsDir, managedSessionStore } = options;
  const savedSessionMetadataCache = new Map<
    string,
    {
      ino: number;
      mtimeMs: number;
      size: number;
      parsedBytes: number;
      scan: SessionFileScan;
      metadataEntries: Record<string, unknown>[];
    }
  >();

  function normalizePath(path: string): string {
    const resolved = normalize(resolve(path));
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  }

  function sessionFileKey(path: string): string {
    return normalizePath(path);
  }

  function isManagedSessionFile(file: string): boolean {
    return managedSessionStore.has(sessionFileKey(file));
  }

  function replaceManagedSessionFile(
    previousFile: string | undefined,
    nextFile: string,
  ): void {
    managedSessionStore.replace(
      previousFile && sessionFileKey(previousFile),
      sessionFileKey(nextFile),
    );
    if (previousFile) {
      savedSessionMetadataCache.delete(previousFile);
      savedSessionMetadataCache.delete(sessionFileKey(previousFile));
    }
    savedSessionMetadataCache.delete(nextFile);
    savedSessionMetadataCache.delete(sessionFileKey(nextFile));
  }

  function deleteManagedSessionFile(file: string): void {
    managedSessionStore.delete(sessionFileKey(file));
    savedSessionMetadataCache.delete(file);
    savedSessionMetadataCache.delete(sessionFileKey(file));
  }

  function isWithinDir(child: string, parent: string): boolean {
    const normalizedChild = normalizePath(child);
    const normalizedParent = normalizePath(parent);
    if (normalizedChild === normalizedParent) return true;
    return normalizedChild.startsWith(`${normalizedParent}${sep}`);
  }

  function canonicalSessionFile(path: string): string {
    const canonicalRoot = realpathSync(sessionsDir);
    const canonicalFile = realpathSync(path);
    if (!isWithinDir(canonicalFile, canonicalRoot))
      throw new Error("Session file must be under ~/.pi/agent/sessions");
    if (!lstatSync(canonicalFile).isFile())
      throw new Error("Session path must be a regular file");
    return canonicalFile;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function persistInitialSession(manager: SessionManager): string {
    const file = manager.getSessionFile();
    if (!file) throw new Error("Pi did not allocate a session file");
    const header = manager.getHeader();
    if (!header) throw new Error("Pi did not initialize a session header");
    const entries = [header, ...manager.getEntries()];
    writeFileSync(
      file,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return file;
  }

  function toNumber(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : fallback;
  }

  function zeroWebUsage(): NonNullable<WebSession["usage"]> {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }

  function addWebUsage(
    target: NonNullable<WebSession["usage"]>,
    value: unknown,
  ): void {
    if (!isRecord(value)) return;
    for (const key of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "totalTokens",
    ] as const)
      target[key] += toNumber(value[key]);
    if (!isRecord(value.cost)) return;
    for (const key of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "total",
    ] as const)
      target.cost[key] += toNumber(value.cost[key]);
  }

  function usageFromEntries(
    entries: readonly unknown[],
  ): NonNullable<WebSession["usage"]> {
    const usage = zeroWebUsage();
    for (const raw of entries) {
      if (!isRecord(raw)) continue;
      if (
        raw.type === "message" &&
        isRecord(raw.message) &&
        (raw.message.role === "assistant" || raw.message.role === "toolResult")
      ) {
        addWebUsage(usage, raw.message.usage);
      } else if (raw.type === "branch_summary" || raw.type === "compaction") {
        addWebUsage(usage, raw.usage);
      }
    }
    return usage;
  }

  function extractTextContent(content: unknown): string | undefined {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;
    const parts: string[] = [];
    for (const item of content) {
      if (
        item &&
        typeof item === "object" &&
        "type" in item &&
        (item as { type?: string }).type === "text" &&
        typeof (item as { text?: string }).text === "string"
      ) {
        parts.push((item as { text: string }).text);
      }
    }
    return parts.length > 0 ? parts.join("") : undefined;
  }

  function compactionEntryFromEvent(
    event: Record<string, unknown>,
  ): unknown | undefined {
    if (event.type === "session_compact" && isRecord(event.compactionEntry))
      return event.compactionEntry;
    if (
      event.type !== "compaction_end" ||
      event.aborted === true ||
      !isRecord(event.result)
    )
      return undefined;
    return isRecord(event.result.compactionEntry)
      ? event.result.compactionEntry
      : undefined;
  }

  function extractPreviewFromHistory(entries: unknown[]): string | undefined {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i] as Record<string, unknown> | undefined;
      if (!entry) continue;
      if (entry.type === "message") {
        const message = entry.message as Record<string, unknown> | undefined;
        if (!message) continue;
        const role =
          typeof message.role === "string" ? message.role : undefined;
        if (role !== "user" && role !== "assistant") continue;
        const preview = extractTextContent(message.content);
        if (preview) return preview.slice(0, 180);
      }
    }
    return undefined;
  }

  function extractSessionMetadataFromEntries(
    entries: unknown[],
  ): Pick<
    WebSession,
    | "name"
    | "model"
    | "thinkingLevel"
    | "lastModel"
    | "parentSession"
    | "messageCount"
  > {
    let name: string | undefined;
    let model: string | undefined;
    let thinkingLevel: string | undefined;
    let parentSession: string | undefined;
    let messageCount = 0;
    for (const raw of entries) {
      const entry = raw as Record<string, unknown> | undefined;
      if (!entry || typeof entry.type !== "string") continue;
      if (entry.type === "message") messageCount += 1;
      if (entry.type === "session_info" && typeof entry.name === "string")
        name = entry.name;
      if (entry.type === "model_change" && typeof entry.modelId === "string")
        model =
          typeof entry.provider === "string" && entry.provider
            ? `${entry.provider}/${entry.modelId}`
            : entry.modelId;
      if (
        entry.type === "thinking_level_change" &&
        typeof entry.thinkingLevel === "string"
      )
        thinkingLevel = entry.thinkingLevel;
      if (entry.type === "session" && typeof entry.parentSession === "string")
        parentSession = entry.parentSession;
    }
    return {
      name,
      model,
      thinkingLevel,
      lastModel: lastAutoRoutedModelFromEntries(entries),
      parentSession,
      messageCount,
    };
  }

  function readManagedWorktreePrefix(
    file: string,
  ): ReturnType<typeof managedWorktreeFromEntries> {
    try {
      // Worktree ownership is written with the initial session entries. Deletion
      // must never deserialize a potentially hundreds-of-megabytes transcript
      // merely to discover that no ownership marker exists.
      const bytes = Math.min(statSync(file).size, 256 * 1024);
      const text = readFileSuffix(file, 0, bytes);
      const completeEnd = text.lastIndexOf("\n");
      if (completeEnd < 0) return undefined;
      const entries: unknown[] = [];
      for (const line of text
        .slice(0, completeEnd + 1)
        .split(/\n/)
        .slice(1)) {
        if (!line) continue;
        try {
          const entry: unknown = JSON.parse(
            line.endsWith("\r") ? line.slice(0, -1) : line,
          );
          if (
            isRecord(entry) &&
            entry.type === "custom" &&
            entry.customType === WORKTREE_SESSION_ENTRY
          )
            entries.push(entry);
        } catch {
          // Ignore malformed or partial metadata lines.
        }
      }
      return managedWorktreeFromEntries(entries);
    } catch {
      return undefined;
    }
  }

  function parseSessionFile(file: string): SessionFileScan | undefined {
    try {
      const text = readFileSync(file, "utf8");
      const lines = text
        .split(/\n/)
        .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
        .filter((line) => line.length > 0);
      if (lines.length === 0) return undefined;
      const header = JSON.parse(lines[0] ?? "null") as Record<
        string,
        unknown
      > | null;
      const rawEntries: unknown[] = [];
      for (const line of lines.slice(1)) {
        try {
          rawEntries.push(JSON.parse(line));
        } catch {
          // ignore malformed trailing lines
        }
      }
      const meta = extractSessionMetadataFromEntries(rawEntries);
      const stats = statSync(file);
      const id =
        typeof header?.id === "string" ? header.id : basename(file, ".jsonl");
      const cwd =
        typeof header?.cwd === "string" && header.cwd
          ? header.cwd
          : dirname(file);
      const session: WebSession = {
        id,
        file,
        cwd,
        name: meta.name,
        model: meta.model,
        thinkingLevel: meta.thinkingLevel,
        lastModel: meta.lastModel,
        status: "offline",
        source: isManagedSessionFile(file) ? "web" : "saved",
        createdAt:
          typeof header?.timestamp === "string"
            ? Date.parse(header.timestamp) || stats.birthtimeMs
            : stats.birthtimeMs,
        updatedAt: stats.mtimeMs,
        messageCount: meta.messageCount ?? 0,
        preview: extractPreviewFromHistory(rawEntries),
        parentSession:
          typeof header?.parentSession === "string"
            ? header.parentSession
            : undefined,
        managedWorktree: managedWorktreeFromEntries(rawEntries),
        usage: usageFromEntries(rawEntries),
      };
      return {
        session,
        file,
        history: rawEntries,
        entries: rawEntries,
        header: header ?? undefined,
        managedWorktreeScanned: true,
        replacement: replacementFromEntries(rawEntries),
      };
    } catch {
      return undefined;
    }
  }

  function readFileSuffix(file: string, start: number, end: number): string {
    const length = Math.max(0, end - start);
    if (length === 0) return "";
    const buffer = Buffer.allocUnsafe(length);
    const fd = openSync(file, "r");
    try {
      let offset = 0;
      while (offset < length) {
        const read = readSync(
          fd,
          buffer,
          offset,
          length - offset,
          start + offset,
        );
        if (read === 0) break;
        offset += read;
      }
      return buffer.subarray(0, offset).toString("utf8");
    } finally {
      closeSync(fd);
    }
  }

  function freshMetadataScan(
    scan: SessionFileScan,
    file: string,
  ): SessionFileScan {
    return {
      ...scan,
      session: {
        ...scan.session,
        source: isManagedSessionFile(file) ? "web" : "saved",
      },
      history: [...scan.history],
      entries: [...scan.entries],
    };
  }

  function parseSessionMetadataFile(file: string): SessionFileScan | undefined {
    try {
      const stats = statSync(file);
      const cached = savedSessionMetadataCache.get(file);
      if (
        cached?.ino === stats.ino &&
        cached.mtimeMs === stats.mtimeMs &&
        cached.size === stats.size
      ) {
        return freshMetadataScan(cached.scan, file);
      }
      const incremental =
        cached !== undefined &&
        cached.ino === stats.ino &&
        stats.size > cached.size;
      const start = incremental ? cached.parsedBytes : 0;
      const rawText = incremental
        ? readFileSuffix(file, start, stats.size)
        : readFileSync(file, "utf8");
      const completeEnd = rawText.lastIndexOf("\n");
      const text = completeEnd < 0 ? "" : rawText.slice(0, completeEnd + 1);
      const parsedBytes = start + Buffer.byteLength(text);
      const lines = text
        .split(/\n/)
        .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
        .filter(Boolean);
      if (!incremental && lines.length === 0) return undefined;
      const header = incremental
        ? cached.scan.header
        : (JSON.parse(lines.shift() ?? "null") as Record<
            string,
            unknown
          > | null);
      let name = incremental ? cached.scan.session.name : undefined;
      let model = incremental ? cached.scan.session.model : undefined;
      let thinkingLevel = incremental
        ? cached.scan.session.thinkingLevel
        : undefined;
      let messageCount = incremental ? cached.scan.session.messageCount : 0;
      let preview = incremental ? cached.scan.session.preview : undefined;
      const metadataEntries = incremental ? [...cached.metadataEntries] : [];
      const usage = zeroWebUsage();
      if (incremental) addWebUsage(usage, cached.scan.session.usage);
      for (const line of lines) {
        let entry: Record<string, unknown> | undefined;
        try {
          const parsed: unknown = JSON.parse(line);
          entry = isRecord(parsed) ? parsed : undefined;
        } catch {
          continue;
        }
        if (!entry || typeof entry.type !== "string") continue;
        if (entry.type === "session_info" && typeof entry.name === "string")
          name = entry.name;
        if (entry.type === "model_change" && typeof entry.modelId === "string") {
          model =
            typeof entry.provider === "string" && entry.provider
              ? `${entry.provider}/${entry.modelId}`
              : entry.modelId;
        }
        if (
          entry.type === "thinking_level_change" &&
          typeof entry.thinkingLevel === "string"
        )
          thinkingLevel = entry.thinkingLevel;
        if (
          (entry.type === "custom" &&
            (entry.customType === WORKTREE_SESSION_ENTRY ||
              entry.customType === WORKTREE_REPLACEMENT_ENTRY ||
              entry.customType === "vessup:auto-router:active")) ||
          entry.type === "model_change"
        ) {
          metadataEntries.push(entry);
        }
        if (entry.type === "message") {
          messageCount += 1;
          const message = isRecord(entry.message) ? entry.message : undefined;
          if (
            message &&
            (message.role === "assistant" || message.role === "toolResult")
          )
            addWebUsage(usage, message.usage);
          if (
            message &&
            (message.role === "user" || message.role === "assistant")
          ) {
            const textPreview = extractTextContent(message.content);
            if (textPreview) preview = textPreview.slice(0, 180);
          }
        }
        if (entry.type === "branch_summary" || entry.type === "compaction")
          addWebUsage(usage, entry.usage);
      }
      const id = incremental
        ? cached.scan.session.id
        : typeof header?.id === "string"
          ? header.id
          : basename(file, ".jsonl");
      const cwd = incremental
        ? cached.scan.session.cwd
        : typeof header?.cwd === "string" && header.cwd
          ? header.cwd
          : dirname(file);
      const managedWorktree = managedWorktreeFromEntries(metadataEntries);
      const session: WebSession = {
        id,
        file,
        cwd,
        name,
        model,
        thinkingLevel,
        lastModel: lastAutoRoutedModelFromEntries(metadataEntries),
        status: "offline",
        source: isManagedSessionFile(file) ? "web" : "saved",
        createdAt: incremental
          ? cached.scan.session.createdAt
          : typeof header?.timestamp === "string"
            ? Date.parse(header.timestamp) || stats.birthtimeMs
            : stats.birthtimeMs,
        updatedAt: stats.mtimeMs,
        messageCount,
        preview,
        parentSession: incremental
          ? cached.scan.session.parentSession
          : typeof header?.parentSession === "string"
            ? header.parentSession
            : undefined,
        managedWorktree,
        usage,
      };
      const scan: SessionFileScan = {
        session,
        file,
        history: [],
        entries: [],
        header: header ?? undefined,
        managedWorktreeScanned: true,
        replacement: replacementFromEntries(metadataEntries),
      };
      savedSessionMetadataCache.set(file, {
        ino: stats.ino,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        parsedBytes,
        scan,
        metadataEntries,
      });
      return freshMetadataScan(scan, file);
    } catch {
      return undefined;
    }
  }

  function parseSessionHistoryFile(
    file: string,
    maxBytes = 16 * 1024 * 1024,
  ): unknown[] {
    try {
      const stats = statSync(file);
      const start = Math.max(0, stats.size - maxBytes);
      let text = readFileSuffix(file, start, stats.size);
      if (start > 0) {
        const firstNewline = text.indexOf("\n");
        text = firstNewline < 0 ? "" : text.slice(firstNewline + 1);
      }
      const completeEnd = text.lastIndexOf("\n");
      if (completeEnd < 0) return [];
      return text
        .slice(0, completeEnd + 1)
        .split(/\n/)
        .flatMap((line) => {
          const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
          if (!normalized) return [];
          try {
            return [JSON.parse(normalized) as unknown];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  function listSavedSessionFiles(dir: string): string[] {
    const files: string[] = [];
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      let entries: Array<{
        isDirectory(): boolean;
        isFile(): boolean;
        name: string;
      }>;
      try {
        entries = readdirSync(current, { withFileTypes: true }) as Array<{
          isDirectory(): boolean;
          isFile(): boolean;
          name: string;
        }>;
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) stack.push(fullPath);
        else if (entry.isFile() && entry.name.endsWith(".jsonl"))
          files.push(fullPath);
      }
    }
    return files;
  }

  function removeMissingSessionMetadata(
    dir: string,
    files: readonly string[],
  ): void {
    const discovered = new Set(files);
    for (const file of savedSessionMetadataCache.keys()) {
      if (isWithinDir(file, dir) && !discovered.has(file))
        savedSessionMetadataCache.delete(file);
    }
  }

  function scanSavedSessions(
    dir: string,
    skippedFiles: ReadonlySet<string> = new Set(),
  ): SessionFileScan[] {
    const files = listSavedSessionFiles(dir);
    const scans: SessionFileScan[] = [];
    for (const file of files) {
      if (skippedFiles.has(normalizePath(file))) continue;
      const scan = parseSessionMetadataFile(file);
      if (scan) scans.push(scan);
    }
    removeMissingSessionMetadata(dir, files);
    return scans;
  }

  function deriveForkMessages(
    entries: unknown[],
  ): Array<{ entryId: string; text: string }> {
    const result: Array<{ entryId: string; text: string }> = [];
    for (const raw of entries) {
      const entry = raw as Record<string, unknown> | undefined;
      if (!entry || entry.type !== "message") continue;
      const id = typeof entry.id === "string" ? entry.id : undefined;
      const message = entry.message as Record<string, unknown> | undefined;
      if (!id || !message || message.role !== "user") continue;
      const text = extractTextContent(message.content);
      if (text) result.push({ entryId: id, text });
    }
    return result;
  }

  return {
    normalizePath,
    sessionFileKey,
    isManagedSessionFile,
    replaceManagedSessionFile,
    deleteManagedSessionFile,
    isWithinDir,
    canonicalSessionFile,
    isRecord,
    persistInitialSession,
    toNumber,
    zeroWebUsage,
    addWebUsage,
    usageFromEntries,
    extractTextContent,
    compactionEntryFromEvent,
    extractPreviewFromHistory,
    extractSessionMetadataFromEntries,
    readManagedWorktreePrefix,
    parseSessionFile,
    parseSessionMetadataFile,
    parseSessionHistoryFile,
    listSavedSessionFiles,
    removeMissingSessionMetadata,
    scanSavedSessions,
    deriveForkMessages,
  };
}
