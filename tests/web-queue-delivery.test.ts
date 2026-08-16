import assert from "node:assert/strict";
import test from "node:test";
import { DirtySnapshotRetryWorker } from "../web/server/dirty-snapshot-worker.ts";
import {
  MAX_WEB_QUEUE_DELIVERY_ATTEMPTS,
  persistPreDeliveryTransition,
  queueDeliveryFailureDisposition,
} from "../web/server/queue-delivery.ts";

test("queued delivery failures back off and reach a bounded discard disposition", () => {
  const first = queueDeliveryFailureDisposition(0);
  const second = queueDeliveryFailureDisposition(first.attempts);
  const final = queueDeliveryFailureDisposition(second.attempts);

  assert.deepEqual(first, { attempts: 1, discard: false, retryDelayMs: 250 });
  assert.deepEqual(second, { attempts: 2, discard: false, retryDelayMs: 500 });
  assert.deepEqual(final, {
    attempts: MAX_WEB_QUEUE_DELIVERY_ATTEMPTS,
    discard: true,
  });
});

test("pre-delivery persistence publishes bounded retries and gates exactly-once delivery", async () => {
  let writes = 0;
  let deliveries = 0;
  const errors: Array<{ attempts: number; exhausted: boolean }> = [];
  const scheduled: Array<() => Promise<void>> = [];
  let attempts = 0;
  const run = async (): Promise<void> => {
    const transitioned = await persistPreDeliveryTransition({
      persist: async () => {
        if (++writes < 3) throw new Error("disk unavailable");
      },
      previousAttempts: attempts,
      publishError: (_error, next, exhausted) => {
        attempts = next;
        errors.push({ attempts: next, exhausted });
      },
      scheduleRetry: () => {
        scheduled.push(run);
      },
    });
    if (transitioned) deliveries++;
  };
  await run();
  assert.equal(deliveries, 0);
  await scheduled.shift()?.();
  assert.equal(deliveries, 0);
  await scheduled.shift()?.();
  assert.equal(deliveries, 1);
  assert.deepEqual(errors, [
    { attempts: 1, exhausted: false },
    { attempts: 2, exhausted: false },
  ]);
});

test("pre-delivery persistence retry is bounded", async () => {
  const scheduled: Array<() => Promise<void>> = [];
  const exhausted: boolean[] = [];
  let attempts = 0;
  const run = async (): Promise<void> => {
    await persistPreDeliveryTransition({
      persist: async () => {
        throw new Error("disk unavailable");
      },
      previousAttempts: attempts,
      publishError: (_error, next, final) => {
        attempts = next;
        exhausted.push(final);
      },
      scheduleRetry: () => {
        scheduled.push(run);
      },
    });
  };
  await run();
  await scheduled.shift()?.();
  await scheduled.shift()?.();
  assert.deepEqual(exhausted, [false, false, true]);
  assert.equal(scheduled.length, 0);
});

test("dirty snapshot worker keeps one retry loop during permanent failure", async () => {
  let attempts = 0;
  const delays: Array<() => void> = [];
  const worker = new DirtySnapshotRetryWorker({
    persist: async () => {
      attempts++;
      throw new Error("disk unavailable");
    },
    delay: () => new Promise<void>((resolve) => delays.push(resolve)),
  });
  worker.markDirty();
  worker.markDirty();
  await Bun.sleep(0);
  assert.equal(attempts, 1);
  assert.equal(delays.length, 1);
  worker.cancel();
  delays.shift()?.();
  await Bun.sleep(0);
  assert.equal(attempts, 1);
});

test("dirty snapshot worker coalesces multiple accepted removals without losing later state", async () => {
  let snapshot = "first";
  const persisted: string[] = [];
  let release!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const worker = new DirtySnapshotRetryWorker({
    persist: async () => {
      persisted.push(snapshot);
      if (++writes === 1) await firstWrite;
    },
  });
  worker.markDirty();
  await Bun.sleep(0);
  snapshot = "second";
  worker.markDirty();
  release();
  while (worker.isRunning()) await Bun.sleep(0);
  assert.deepEqual(persisted, ["first", "second"]);
});

test("dirty snapshot worker restarts when markDirty interleaves with finalization", async () => {
  let writes = 0;
  let worker!: DirtySnapshotRetryWorker;
  let injected = false;
  worker = new DirtySnapshotRetryWorker({
    persist: async () => {
      writes++;
      if (!injected) {
        injected = true;
        // Queue after run's continuation but before its promise finalizer.
        queueMicrotask(() => worker.markDirty());
      }
    },
  });
  worker.markDirty();
  while (worker.isRunning() || writes < 2) await Bun.sleep(0);
  assert.equal(writes, 2);
});

test("dirty snapshot worker performs one bounded final shutdown snapshot", async () => {
  let attempts = 0;
  let releaseFinal!: () => void;
  const finalWrite = new Promise<void>((resolve) => {
    releaseFinal = resolve;
  });
  const worker = new DirtySnapshotRetryWorker({
    persist: async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
      await finalWrite;
    },
    delay: () => new Promise<void>(() => undefined),
  });
  worker.markDirty();
  while (attempts < 1) await Bun.sleep(0);
  const draining = worker.flushAndCancel(1_000);
  while (attempts < 2) await Bun.sleep(0);
  releaseFinal();
  assert.equal(await draining, true);
  assert.equal(attempts, 2);

  const snapshots: string[] = [];
  let current = "old";
  let releaseOld!: () => void;
  const oldWrite = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let orderedAttempts = 0;
  const ordered = new DirtySnapshotRetryWorker({
    persist: async () => {
      const captured = current;
      if (++orderedAttempts === 1) await oldWrite;
      snapshots.push(captured);
    },
  });
  ordered.markDirty();
  while (orderedAttempts < 1) await Bun.sleep(0);
  current = "final";
  const orderedDrain = ordered.flushAndCancel(1_000);
  await Bun.sleep(0);
  assert.equal(
    orderedAttempts,
    1,
    "final persist must wait for the in-flight persist",
  );
  releaseOld();
  assert.equal(await orderedDrain, true);
  assert.deepEqual(snapshots, ["old", "final"]);

  const wedged = new DirtySnapshotRetryWorker({
    persist: () => new Promise<void>(() => undefined),
  });
  assert.equal(await wedged.flushAndCancel(0), false);
});

test("dirty snapshot worker cancellation drains an in-flight old-identity write", async () => {
  const writes: string[] = [];
  let identity = "old";
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new DirtySnapshotRetryWorker({
    persist: async () => {
      const capturedIdentity = identity;
      await blocked;
      writes.push(capturedIdentity);
    },
  });
  worker.markDirty();
  await Bun.sleep(0);
  let drained = false;
  const drain = worker.cancelAndDrain().then(() => {
    drained = true;
  });
  identity = "new";
  await Bun.sleep(0);
  assert.equal(drained, false);
  release();
  await drain;
  writes.push(identity);
  await Bun.sleep(0);
  assert.deepEqual(writes, ["old", "new"]);
});

test("dirty snapshot worker cancellation interrupts a custom delay", async () => {
  let attempts = 0;
  let delayStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    delayStarted = resolve;
  });
  const worker = new DirtySnapshotRetryWorker({
    persist: async () => {
      attempts++;
      throw new Error("permanent");
    },
    delay: () => {
      delayStarted();
      return new Promise<void>(() => undefined);
    },
  });
  worker.markDirty();
  await started;
  worker.cancel();
  while (worker.isRunning()) await Bun.sleep(0);
  assert.equal(attempts, 1);
});
