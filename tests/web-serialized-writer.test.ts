import { expect, test } from "bun:test";
import {
  CommandDeliveryUncertainError,
  isUncertainRpcDeliveryCommand,
  rpcDeliveryError,
} from "../web/server/managed-rpc-session.ts";
import { SerializedWriter } from "../web/server/serialized-writer.ts";

test("prompts and compaction remain uncertain after transport acknowledgement loss", () => {
  expect(isUncertainRpcDeliveryCommand("prompt")).toBe(true);
  expect(isUncertainRpcDeliveryCommand("compact")).toBe(true);
  expect(isUncertainRpcDeliveryCommand("set_session_name")).toBe(false);
  expect(rpcDeliveryError("prompt", "timed out")).toBeInstanceOf(
    CommandDeliveryUncertainError,
  );
  expect(rpcDeliveryError("compact", "transport closed")).toBeInstanceOf(
    CommandDeliveryUncertainError,
  );
  expect(rpcDeliveryError("set_session_name", "timed out")).not.toBeInstanceOf(
    CommandDeliveryUncertainError,
  );
});

test("serialized writes acknowledge completion and preserve order", async () => {
  const releases: Array<() => void> = [];
  const started: string[] = [];
  const writer = new SerializedWriter<string>(async (value) => {
    started.push(value);
    await new Promise<void>((resolve) => releases.push(resolve));
  });
  let firstDelivered = false;
  let secondDelivered = false;
  const first = writer.write("first").then(() => {
    firstDelivered = true;
  });
  const second = writer.write("second").then(() => {
    secondDelivered = true;
  });
  await Bun.sleep(0);
  expect(started).toEqual(["first"]);
  expect(firstDelivered).toBe(false);
  expect(secondDelivered).toBe(false);
  releases.shift()?.();
  await first;
  await Bun.sleep(0);
  expect(started).toEqual(["first", "second"]);
  expect(secondDelivered).toBe(false);
  releases.shift()?.();
  await second;
  expect(secondDelivered).toBe(true);
});

test("serialized writes skip queued work that expires before delivery", async () => {
  let releaseFirst!: () => void;
  const started: string[] = [];
  const writer = new SerializedWriter<string>(async (value) => {
    started.push(value);
    if (value === "first")
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
  });
  let secondActive = true;
  const first = writer.write("first");
  const second = writer.write("expired", () => secondActive);
  await Bun.sleep(0);
  secondActive = false;
  releaseFirst();
  await Promise.all([first, second]);
  expect(started).toEqual(["first"]);
});

test("serialized writes report a delivery failure and recover for later writes", async () => {
  let attempts = 0;
  const writer = new SerializedWriter<string>(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("stdin write failed");
  });
  await expect(writer.write("abort")).rejects.toThrow("stdin write failed");
  await expect(writer.write("later command")).resolves.toBeUndefined();
  expect(attempts).toBe(2);
});
