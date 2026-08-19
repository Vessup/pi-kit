import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  CreateSessionRequest,
  ResumeSessionRequest,
  WebSession,
} from "../protocol.js";
import type { TailscaleWebSettings } from "../tailscale.js";
import { readTailscaleWebSettings } from "../tailscale.js";
import type { DiscoveryState } from "./discoveryState.js";
import {
  badRequest,
  isTrustedBrowserOrigin,
  jsonResponse,
  notFound,
  textResponse,
} from "./http-utils.js";
import type { ManagedSessionLauncher } from "./managedSessionCreate.js";
import type { MissingSessions } from "./missingSessions.js";
import { resolveWebCwd } from "./paths.js";
import { resolveSessionProject } from "./projects.js";
import type { SessionFileCatalog, SessionRecord } from "./server-types.js";
import type { WebServerConfig } from "./serverConfig.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";
import type { SessionDeletion } from "./sessionDeletion.js";
import type { SessionRegistry } from "./sessionRegistry.js";
import { listDirectorySuggestions } from "./suggestions.js";
import {
  createWebWorktree,
  inheritManagedBranchOwnership,
  listRepositoryBranches,
  type RepositoryBranches,
  WORKTREE_SESSION_ENTRY,
} from "./worktrees.js";

/** REST API surface under `/api/*`. */
export function createHttpApi(options: {
  config: WebServerConfig;
  state: ServerRuntimeState;
  discovery: DiscoveryState;
  catalog: SessionFileCatalog;
  registry: SessionRegistry;
  missingSessions: MissingSessions;
  launcher: ManagedSessionLauncher;
  deletion: SessionDeletion;
}) {
  const {
    config,
    state: runtime,
    discovery,
    catalog,
    registry,
    missingSessions,
    launcher,
    deletion,
  } = options;
  const { rootDir, distDir, settingsPath } = config;
  const { sessionsDir } = config;
  const {
    normalizePath,
    canonicalSessionFile,
    persistInitialSession,
    parseSessionMetadataFile,
    scanSavedSessions,
    isRecord,
  } = catalog;
  const {
    sessionToClientPayload,
    sortSessions,
    upsertSession,
    activeSessionFiles,
  } = registry;
  const { isMissingInactiveSession } = missingSessions;
  const { configureTailscaleServe, removeTailscaleServe, getTailscaleStatus } =
    discovery;
  const { createManagedSession } = launcher;
  const {
    deleteSession,
    reconcileMissingSessionFiles,
    cleanupInitialSessionFile,
  } = deletion;

  function webAssetsServable(): boolean {
    try {
      return statSync(join(distDir, "index.html")).isFile();
    } catch {
      return false;
    }
  }

  async function handleApi(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const tailscaleStatus = getTailscaleStatus();
    if (
      url.pathname.startsWith("/api/") &&
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.method !== "OPTIONS" &&
      !isTrustedBrowserOrigin(
        request,
        tailscaleStatus.published ? tailscaleStatus.url : undefined,
      )
    ) {
      return textResponse("Forbidden origin", { status: 403 });
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      return jsonResponse({
        ok: true,
        pid: process.pid,
        port: runtime.port,
        stateFile: config.stateFilePath,
        capabilities: {
          commandHello: true,
          queueSteer: true,
          worktreeRefs: true,
          branchSuggestions: true,
        },
        assets: webAssetsServable(),
        root: rootDir,
        tailscale: tailscaleStatus,
      });
    }
    if (request.method === "GET" && url.pathname === "/api/directories") {
      return jsonResponse({
        directories: listDirectorySuggestions(url.searchParams.get("q") ?? "", {
          baseDir: rootDir,
        }),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/branches") {
      const requestedCwd = (url.searchParams.get("cwd") ?? "").trim();
      if (!requestedCwd) return badRequest("Missing cwd");
      let cwd: string;
      try {
        cwd = resolveWebCwd(requestedCwd, { baseDir: rootDir });
      } catch (error) {
        return badRequest(
          error instanceof Error ? error.message : String(error),
        );
      }
      try {
        if (!statSync(cwd).isDirectory())
          return badRequest(`cwd is not a directory: ${cwd}`);
      } catch {
        return badRequest(`cwd does not exist: ${cwd}`);
      }
      let branches: RepositoryBranches;
      try {
        branches = listRepositoryBranches(cwd);
      } catch (error) {
        // Not a Git repository (or Git is unavailable): the browser just shows
        // no suggestions instead of surfacing an error mid-typing.
        return jsonResponse({
          local: [],
          remote: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return jsonResponse(branches);
    }
    if (request.method === "POST" && url.pathname === "/api/tailscale") {
      const body = (await request.json().catch(() => undefined)) as
        | {
            enabled?: unknown;
            httpsPort?: unknown;
            serviceName?: unknown;
            current?: unknown;
          }
        | undefined;
      if (!body || typeof body.enabled !== "boolean")
        return badRequest("Missing enabled boolean");
      const persisted = await readTailscaleWebSettings(settingsPath);
      const suppliedCurrent = isRecord(body.current) ? body.current : undefined;
      const current: TailscaleWebSettings =
        suppliedCurrent && typeof suppliedCurrent.enabled === "boolean"
          ? {
              enabled: suppliedCurrent.enabled,
              httpsPort:
                typeof suppliedCurrent.httpsPort === "number" &&
                Number.isInteger(suppliedCurrent.httpsPort) &&
                suppliedCurrent.httpsPort >= 1 &&
                suppliedCurrent.httpsPort <= 65_535
                  ? suppliedCurrent.httpsPort
                  : persisted.httpsPort,
              // The persisted route identity is authoritative; a browser may report
              // the previously applied port, but cannot select another Service to remove.
              serviceName: persisted.serviceName,
            }
          : persisted;
      const settings: TailscaleWebSettings = {
        enabled: body.enabled,
        httpsPort:
          typeof body.httpsPort === "number" &&
          Number.isInteger(body.httpsPort) &&
          body.httpsPort >= 1 &&
          body.httpsPort <= 65_535
            ? body.httpsPort
            : persisted.httpsPort,
        serviceName:
          typeof body.serviceName === "string"
            ? body.serviceName.trim().replace(/^svc:/, "") || undefined
            : persisted.serviceName,
      };
      const status = settings.enabled
        ? await configureTailscaleServe(settings, current)
        : await removeTailscaleServe(current);
      return jsonResponse({ tailscale: status });
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      await reconcileMissingSessionFiles();
      const scans = scanSavedSessions(sessionsDir, activeSessionFiles());
      for (const scan of scans) {
        const existing =
          runtime.sessions.get(scan.session.id) ??
          runtime.sessionsByFile.get(normalizePath(scan.file));
        if (!existing || !existing.active || existing.status === "offline") {
          upsertSession(
            scan.session,
            "saved",
            scan.history,
            scan.managedWorktreeScanned,
          );
        }
      }
      const merged = new Map<string, WebSession>();
      for (const scan of scans) {
        const live =
          runtime.sessions.get(scan.session.id) ??
          runtime.sessionsByFile.get(normalizePath(scan.file));
        if (live?.catalogReady === false) continue;
        merged.set(
          scan.session.file
            ? normalizePath(scan.session.file)
            : scan.session.id,
          sessionToClientPayload(scan.session),
        );
      }
      for (const item of runtime.sessions.values()) {
        if (item.catalogReady === false || isMissingInactiveSession(item))
          continue;
        merged.set(
          item.file ? normalizePath(item.file) : item.id,
          sessionToClientPayload(item),
        );
      }
      return jsonResponse({
        sessions: sortSessions(Array.from(merged.values())),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const body = (await request.json().catch(() => undefined)) as
        | CreateSessionRequest
        | undefined;
      if (!body) return badRequest("Missing session request");
      const requestedCwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
      const worktreeName =
        typeof body.worktreeName === "string" ? body.worktreeName.trim() : "";
      const worktreeBranch =
        typeof body.worktreeBranch === "string"
          ? body.worktreeBranch.trim()
          : "";
      const worktreeStartPoint =
        typeof body.worktreeStartPoint === "string"
          ? body.worktreeStartPoint.trim()
          : "";
      if (!requestedCwd) return badRequest("Specify a repository or directory");
      if (!worktreeName && (worktreeBranch || worktreeStartPoint))
        return badRequest(
          "worktreeBranch and worktreeStartPoint require worktreeName",
        );

      let cwd: string;
      try {
        cwd = resolveWebCwd(requestedCwd, { baseDir: rootDir });
      } catch (error) {
        return badRequest(
          error instanceof Error ? error.message : String(error),
        );
      }
      try {
        if (!statSync(cwd).isDirectory())
          return badRequest(`cwd is not a directory: ${cwd}`);
      } catch {
        return badRequest(`cwd does not exist: ${cwd}`);
      }

      let worktree: Awaited<ReturnType<typeof createWebWorktree>> | undefined;
      if (worktreeName) {
        if (!resolveSessionProject(cwd).id.startsWith("git:"))
          return badRequest("Worktree repository is not a Git repository");
        try {
          worktree = await createWebWorktree(cwd, worktreeName, {
            branch: worktreeBranch || undefined,
            startPoint: worktreeStartPoint || undefined,
          });
          if (!worktree.existingCheckout) {
            worktree = inheritManagedBranchOwnership(
              worktree,
              [...runtime.sessions.values()].map(
                (candidate) => candidate.managedWorktree,
              ),
            );
          }
          cwd = worktree.path;
        } catch (error) {
          return badRequest(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      let session: SessionRecord;
      let initialSessionFile: string | undefined;
      try {
        const manager = SessionManager.create(cwd);
        if (worktree) {
          manager.appendCustomEntry(
            WORKTREE_SESSION_ENTRY,
            worktree.existingCheckout
              ? { managed: false }
              : {
                  path: worktree.path,
                  repoRoot: worktree.repoRoot,
                  name: worktree.name,
                  branch: worktree.branch,
                  branchCreated: worktree.branchCreated,
                },
          );
        }
        if (body.name?.trim()) manager.appendSessionInfo(body.name.trim());
        initialSessionFile = persistInitialSession(manager);
        session = await createManagedSession(
          cwd,
          body.name,
          initialSessionFile,
        );
        if (worktree && !worktree.existingCheckout)
          session.managedWorktree = worktree;
      } catch (error) {
        const startupMessage =
          error instanceof Error ? error.message : String(error);
        if (worktree) {
          // An entered pre-existing checkout was not created here; clean up the
          // stale initial session instead of retaining it for inspection.
          if (worktree.existingCheckout) {
            cleanupInitialSessionFile(initialSessionFile);
            return jsonResponse(
              { error: startupMessage },
              { status: 500 },
            );
          }
          return jsonResponse(
            {
              error: `${startupMessage}; initialized worktree retained at ${worktree.path} for inspection`,
            },
            { status: 500 },
          );
        }
        cleanupInitialSessionFile(initialSessionFile);
        return jsonResponse(
          { error: startupMessage },
          { status: 500 },
        );
      }
      return jsonResponse(
        { session: sessionToClientPayload(session), worktree },
        { status: 201 },
      );
    }
    if (request.method === "POST" && url.pathname === "/api/sessions/resume") {
      const body = (await request.json().catch(() => undefined)) as
        | ResumeSessionRequest
        | undefined;
      if (!body || typeof body.file !== "string" || !body.file.trim())
        return badRequest("Missing file");
      let file: string;
      try {
        file = canonicalSessionFile(resolve(rootDir, body.file));
      } catch (error) {
        return badRequest(
          error instanceof Error
            ? error.message
            : "Session file does not exist",
        );
      }
      const scan = parseSessionMetadataFile(file);
      if (!scan) return badRequest("Invalid session file");
      const existing = runtime.sessionsByFile.get(normalizePath(file));
      if (existing?.active && existing.status !== "offline") {
        return jsonResponse(
          { error: "Session is already active" },
          { status: 409 },
        );
      }
      const session = await createManagedSession(
        scan.session.cwd,
        scan.session.name,
        file,
      );
      return jsonResponse(
        { session: sessionToClientPayload(session) },
        { status: 201 },
      );
    }
    if (request.method === "DELETE") {
      const pathname = url.pathname;
      const match = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
      if (!match) return notFound();
      try {
        await deleteSession(decodeURIComponent(match[1]));
        return jsonResponse({ ok: true });
      } catch (error) {
        return jsonResponse(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
    }
    return notFound();
  }

  return { handleApi, webAssetsServable };
}

export type HttpApi = ReturnType<typeof createHttpApi>;
