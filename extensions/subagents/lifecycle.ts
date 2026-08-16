import type { SubagentStatus } from "./types.js";

export function isFailedStopReason(stopReason: string | undefined): boolean {
  return stopReason === "error" || stopReason === "aborted";
}

export function countsAgainstSubagentLimit(agent: {
  status: SubagentStatus;
  session?: unknown;
}): boolean {
  return agent.status === "creating" || agent.session !== undefined;
}

export function isTerminalSubagentStatus(status: SubagentStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "terminated"
  );
}

export function shouldArchiveTerminalSubagent(agent: {
  status: SubagentStatus;
  lastReadActivity: number;
  activity: readonly unknown[];
}): boolean {
  return (
    isTerminalSubagentStatus(agent.status) &&
    agent.lastReadActivity < agent.activity.length
  );
}

export async function abortRunningSubagentSessions<
  T extends { status: SubagentStatus; session?: { abort(): Promise<unknown> } },
>(agents: readonly T[]): Promise<Array<{ agent: T; error?: Error }>> {
  const running = agents.filter(
    (agent) =>
      agent.session &&
      (agent.status === "creating" || agent.status === "working"),
  );
  return await Promise.all(
    running.map(async (agent) => {
      try {
        await agent.session?.abort();
        return { agent };
      } catch (error) {
        return {
          agent,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    }),
  );
}
