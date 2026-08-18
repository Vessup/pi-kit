import { existsSync } from "node:fs";

/**
 * Ownership decisions about the machine-wide Pi web daemon. A daemon is only
 * "the" daemon when the shared state file points at it, so a second process
 * must never blindly steal the port, the state file, or the Tailscale Serve
 * route. These helpers probe and (with process-identity verification) stop a
 * daemon that is provably broken, e.g. one whose checkout directory was
 * deleted out from under it.
 */

/** The subset of /api/health used for ownership decisions. */
export type DaemonHealth = {
  ok: true;
  pid: number;
  port: number;
  /** Whether the daemon can serve the web app shell from its own checkout. */
  assets: boolean;
  /** The checkout root the daemon serves from; empty when unreported. */
  root: string;
  /** Raw tailscale status echoed back when restoring discovery state. */
  tailscale?: unknown;
};

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function processCommand(pid: number): Promise<string | undefined> {
  try {
    const child = Bun.spawn({
      cmd: ["ps", "-p", String(pid), "-o", "command="],
      stdout: "pipe",
      stderr: "ignore",
    });
    const [output, code] = await Promise.all([
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      child.exited,
    ]);
    return code === 0 ? output.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Verify a pid still belongs to a Pi web daemon before signaling it. */
export async function isPiWebDaemonPid(pid: number): Promise<boolean> {
  const command = await processCommand(pid);
  if (!command) return false;
  // Match both the direct entrypoint and the package "webServer" script so a
  // daemon started either way is recognized as ours.
  return (
    command.includes("web/server/index.ts") || /\bwebServer\b/.test(command)
  );
}

export async function probeDaemonHealth(
  port: number,
  timeoutMs = 1_500,
): Promise<DaemonHealth | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!response.ok) return undefined;
    const value = (await response.json()) as Partial<DaemonHealth>;
    if (
      !value ||
      value.ok !== true ||
      typeof value.pid !== "number" ||
      typeof value.port !== "number"
    )
      return undefined;
    return {
      ok: true,
      pid: value.pid,
      port: value.port,
      assets: value.assets === true,
      root: typeof value.root === "string" ? value.root : "",
      tailscale: value.tailscale,
    };
  } catch {
    return undefined;
  }
}

/** Poll until the daemon answers health with the expected pid, or give up. */
export async function waitForDaemonHealth(
  port: number,
  expectedPid: number | undefined,
  budgetMs: number,
): Promise<DaemonHealth | undefined> {
  const deadline = Date.now() + budgetMs;
  do {
    const health = await probeDaemonHealth(port);
    if (health && (!expectedPid || health.pid === expectedPid)) return health;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  return undefined;
}

/** A daemon that fully serves web apps must be deferred to, never replaced. */
export function daemonServesWebApps(health: DaemonHealth): boolean {
  return health.assets === true;
}

/**
 * A daemon is evictable when its own checkout no longer exists, so it can
 * never serve the app shell again. Daemons that predate asset reporting
 * cannot prove they serve the web app either; a newer spawn replaces them
 * once, after which the replacement reports its own assets. A daemon that
 * reports a missing build over an existing checkout is NOT evictable —
 * respawning from the same checkout would fail the same way.
 */
export function daemonIsEvictable(health: DaemonHealth): boolean {
  if (health.root) return !existsSync(health.root);
  return health.assets !== true;
}

async function waitForPidExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await Bun.sleep(100);
  }
  return !isPidAlive(pid);
}

/**
 * Stop a Pi web daemon after verifying the pid still names one. Returns false
 * when the pid could not be verified or did not exit; callers must then leave
 * shared discovery state untouched rather than steal it.
 */
export async function terminatePiWebDaemon(
  pid: number,
  timeoutMs = 5_000,
): Promise<boolean> {
  if (!isPidAlive(pid)) return true;
  if (!(await isPiWebDaemonPid(pid))) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isPidAlive(pid);
  }
  if (await waitForPidExit(pid, timeoutMs)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  await Bun.sleep(200);
  return !isPidAlive(pid);
}
