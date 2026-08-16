import type { WebSubagent, WebUsage } from "../protocol";

export function zeroWebUsage(): WebUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addWebUsage(
  target: WebUsage,
  usage: WebUsage | undefined,
): void {
  if (!usage) return;
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.totalTokens += usage.totalTokens;
  target.cost.input += usage.cost.input;
  target.cost.output += usage.cost.output;
  target.cost.cacheRead += usage.cost.cacheRead;
  target.cost.cacheWrite += usage.cost.cacheWrite;
  target.cost.total += usage.cost.total;
}

/** Sum the same cumulative snapshots shown in each subagent row. */
export function totalSubagentUsage(agents: readonly WebSubagent[]): WebUsage {
  const total = zeroWebUsage();
  for (const agent of agents) addWebUsage(total, agent.usage);
  return total;
}
