import assert from "node:assert/strict";
import test from "node:test";
import {
  runManagedRefresh,
  serializeManagedRefresh,
} from "../web/server/refresh-policy.ts";

test("foreground managed refresh propagates migration failures", async () => {
  const failure = new Error("queue identity migration failed");
  await assert.rejects(
    runManagedRefresh(async () => {
      throw failure;
    }),
    failure,
  );
});

test("complete managed refreshes serialize per record across foreground and background callers", async () => {
  const state: { managedRefreshTail?: Promise<void> } = {};
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const foreground = serializeManagedRefresh(state, async () => {
    order.push("foreground:get-state");
    await gate;
    order.push("foreground:rekey");
  });
  const background = serializeManagedRefresh(state, async () => {
    order.push("background:refresh");
  });
  await Bun.sleep(0);
  assert.deepEqual(order, ["foreground:get-state"]);
  release();
  await Promise.all([foreground, background]);
  assert.deepEqual(order, [
    "foreground:get-state",
    "foreground:rekey",
    "background:refresh",
  ]);
});

test("failed foreground refresh does not poison serialized background refresh", async () => {
  const state: { managedRefreshTail?: Promise<void> } = {};
  const failure = new Error("migration failed");
  const foreground = serializeManagedRefresh(state, async () => {
    throw failure;
  });
  const observed: string[] = [];
  const background = serializeManagedRefresh(state, async () => {
    observed.push("resumed");
  });
  await assert.rejects(foreground, failure);
  await background;
  assert.deepEqual(observed, ["resumed"]);
});

test("background managed refresh suppresses failures only when explicitly requested", async () => {
  const failure = new Error("managed process exited");
  const observed: unknown[] = [];
  await runManagedRefresh(
    async () => {
      throw failure;
    },
    {
      suppressErrors: true,
      onBackgroundError: (error) => observed.push(error),
    },
  );
  assert.deepEqual(observed, [failure]);
});
