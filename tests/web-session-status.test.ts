import { expect, test } from "bun:test";
import {
  displaySessionStatus,
  hasActiveSessionWork,
} from "../web/client/session-status.ts";

const subagent = {
  id: "worker",
  model: "test/model",
  effort: "high",
  turns: 1,
  queued: 0,
  createdAt: 1,
  updatedAt: 2,
};

test("offline sessions are labeled inactive regardless of their origin", () => {
  expect(displaySessionStatus({ source: "web", status: "offline" })).toBe(
    "inactive",
  );
  expect(displaySessionStatus({ source: "saved", status: "offline" })).toBe(
    "inactive",
  );
  expect(displaySessionStatus({ source: "tui", status: "offline" })).toBe(
    "inactive",
  );
  expect(displaySessionStatus({ source: "web", status: "starting" })).toBe(
    "starting",
  );
});

test("active subagents keep an idle main session working and stoppable", () => {
  expect(hasActiveSessionWork({ status: "working" })).toBe(true);
  for (const status of ["creating", "working", "terminating"] as const) {
    const session = {
      source: "web" as const,
      status: "idle" as const,
      subagents: [{ ...subagent, status }],
    };
    expect(hasActiveSessionWork(session)).toBe(true);
    expect(displaySessionStatus(session)).toBe("working");
  }
  for (const status of ["completed", "failed", "terminated"] as const) {
    const session = {
      source: "web" as const,
      status: "idle" as const,
      subagents: [{ ...subagent, status }],
    };
    expect(hasActiveSessionWork(session)).toBe(false);
    expect(displaySessionStatus(session)).toBe("idle");
  }
});
