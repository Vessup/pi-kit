import type { WebSession } from "../protocol.js";
import type { ClientBroadcast } from "./clientBroadcast.js";
import type { SessionFileCatalog, SessionRecord } from "./server-types.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";

/** Best-effort branch and PR metadata hydration via `git`/`gh`. */
export function createGitMetadata(options: {
  state: ServerRuntimeState;
  catalog: SessionFileCatalog;
  broadcast: ClientBroadcast;
}) {
  const { state: runtime, catalog, broadcast } = options;
  const { isRecord } = catalog;

  async function commandOutput(
    command: string[],
    cwd: string,
    timeoutMs = 10_000,
  ): Promise<string | undefined> {
    let process: Bun.Subprocess | undefined;
    try {
      process = Bun.spawn({
        cmd: command,
        cwd,
        stdout: "pipe",
        stderr: "ignore",
      });
      const stdout = process.stdout;
      if (!stdout || typeof stdout === "number") return undefined;
      const timeout = setTimeout(() => process?.kill(), timeoutMs);
      try {
        const [output, code] = await Promise.all([
          new Response(stdout as ReadableStream<Uint8Array>).text(),
          process.exited,
        ]);
        return code === 0 ? output.trim() : undefined;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return undefined;
    }
  }

  async function hydrateGitMetadata(record: SessionRecord): Promise<void> {
    const generation = (record.gitMetadataGeneration ?? 0) + 1;
    record.gitMetadataGeneration = generation;
    const cwd = record.cwd;
    const branch = await commandOutput(
      ["git", "branch", "--show-current"],
      cwd,
    );
    const raw = await commandOutput(
      ["gh", "pr", "view", "--json", "number,url"],
      cwd,
    );
    let pullRequest: WebSession["pullRequest"];
    if (raw) {
      try {
        const value: unknown = JSON.parse(raw);
        if (
          isRecord(value) &&
          Number.isInteger(value.number) &&
          typeof value.url === "string"
        ) {
          const url = new URL(value.url);
          if (url.protocol === "https:" || url.protocol === "http:") {
            pullRequest = {
              number: value.number as number,
              url: url.toString(),
            };
          }
        }
      } catch {
        // A branch without an open PR is expected.
      }
    }
    if (
      record.gitMetadataGeneration !== generation ||
      record.cwd !== cwd ||
      runtime.sessions.get(record.id) !== record
    )
      return;
    if (branch) record.branch = branch;
    // A failed/no-match `gh pr view` is authoritative for the current branch and
    // must clear a PR cached before the TUI changed branches.
    record.pullRequest = pullRequest;
    broadcast.broadcastSessionToAll(record);
  }

  return { hydrateGitMetadata };
}

export type GitMetadata = ReturnType<typeof createGitMetadata>;
