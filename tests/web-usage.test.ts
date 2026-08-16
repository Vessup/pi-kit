import { expect, test } from "bun:test";
import { totalSubagentUsage } from "../web/client/usage.ts";
import type { WebSubagent, WebUsage } from "../web/protocol.ts";

function usage(
  input: number,
  output: number,
  cacheRead: number,
  total: number,
  cost: number,
): WebUsage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: total,
    cost: {
      input: cost / 4,
      output: cost / 4,
      cacheRead: cost / 2,
      cacheWrite: 0,
      total: cost,
    },
  };
}

function agent(id: string, value?: WebUsage): WebSubagent {
  return {
    id,
    status: "completed",
    model: "provider/model",
    effort: "high",
    turns: 1,
    queued: 0,
    createdAt: 1,
    updatedAt: 2,
    usage: value,
  };
}

test("subagent header usage equals the cumulative usage displayed by its rows", () => {
  const first = usage(10, 5, 100, 115, 1.5);
  const second = usage(20, 7, 200, 227, 2.25);
  expect(
    totalSubagentUsage([
      agent("first", first),
      agent("second", second),
      agent("pending"),
    ]),
  ).toEqual({
    input: 30,
    output: 12,
    cacheRead: 300,
    cacheWrite: 0,
    totalTokens: 342,
    cost: {
      input: 0.9375,
      output: 0.9375,
      cacheRead: 1.875,
      cacheWrite: 0,
      total: 3.75,
    },
  });
});
