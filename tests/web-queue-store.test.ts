import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CoalescedQueueStoreWriter,
  readQueueStore,
  writeQueueStore,
} from "../web/server/queue-store.ts";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

test("web follow-up queues survive daemon restarts with attachments", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-queue-store-"));
  const path = join(tempDir, "web", "queues.json");
  await writeQueueStore(
    path,
    new Map([
      [
        "session-1",
        [
          {
            id: "queued-1",
            message: "do this next",
            images: [
              {
                type: "image",
                data: "aGVsbG8=",
                mimeType: "image/png",
                name: "image.png",
              },
            ],
          },
        ],
      ],
    ]),
  );

  expect(readQueueStore(path).get("session-1")).toEqual([
    {
      id: "queued-1",
      message: "do this next",
      images: [
        {
          type: "image",
          data: "aGVsbG8=",
          mimeType: "image/png",
          name: "image.png",
        },
      ],
    },
  ]);
  expect(JSON.parse((await readFile(path)).toString()).version).toBe(2);
});

test("daemon restart preserves an in-flight item as blocked instead of redelivering or erasing it", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-queue-store-"));
  const path = join(tempDir, "queues.json");
  const item = {
    id: "queued-crash",
    message: "perform once",
    deliveryState: "delivering" as const,
  };
  await writeQueueStore(path, new Map([["session-1", [item]]]));

  const restarted = readQueueStore(path).get("session-1");
  expect(restarted).toEqual([item]);
  expect(restarted?.[0]?.deliveryState).toBe("delivering");
});

test("a missing queue store starts empty, but malformed JSON fails closed", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-queue-store-"));
  const path = join(tempDir, "queues.json");
  expect(readQueueStore(path).size).toBe(0);

  const corruptContents = '{"version":2,"queues":';
  await Bun.write(path, corruptContents);
  expect(() => readQueueStore(path)).toThrow();
  expect(await readFile(path, "utf8")).toBe(corruptContents);
});

test("queue store corruption is propagated instead of dropping malformed entries", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-queue-store-"));
  const path = join(tempDir, "queues.json");
  await Bun.write(
    path,
    JSON.stringify({
      version: 1,
      queues: { session: [{ id: 7, message: "bad" }] },
    }),
  );
  expect(() => readQueueStore(path)).toThrow("contains an invalid item");
});

test("shared queue-map mutations roll back globally before a later session snapshots", async () => {
  const queues = new Map<string, Array<{ id: string; message: string }>>();
  let rejectFirst!: (error: Error) => void;
  let markStarted!: () => void;
  const firstWriteStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const firstWrite = new Promise<void>((_resolve, reject) => {
    rejectFirst = reject;
  });
  let writes = 0;
  let durable = "";
  const writer = new CoalescedQueueStoreWriter("unused", async (contents) => {
    writes += 1;
    if (writes === 1) {
      markStarted();
      await firstWrite;
    }
    durable = contents;
  });

  const rejected = writer.mutate(queues, (shared) => {
    shared.set("session-a", [{ id: "a", message: "must roll back" }]);
  });
  await firstWriteStarted;
  const accepted = writer.mutate(queues, (shared) => {
    shared.set("session-b", [{ id: "b", message: "accepted" }]);
  });
  rejectFirst(new Error("disk failed"));
  await expect(rejected).rejects.toThrow("disk failed");
  await accepted;

  expect(Array.from(queues.keys())).toEqual(["session-b"]);
  expect(JSON.parse(durable).queues).toEqual({
    "session-b": [{ id: "b", message: "accepted" }],
  });
});

test("failed atomic queue-store renames clean up temporary files", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-queue-store-"));
  const directPath = join(tempDir, "direct.json");
  await mkdir(directPath);
  await expect(
    writeQueueStore(
      directPath,
      new Map([["session", [{ id: "one", message: "first" }]]]),
    ),
  ).rejects.toThrow();
  expect(
    (await readdir(tempDir)).filter((name) => name.endsWith(".tmp")),
  ).toEqual([]);

  const coalescedPath = join(tempDir, "coalesced.json");
  await mkdir(coalescedPath);
  const writer = new CoalescedQueueStoreWriter(coalescedPath);
  await expect(
    writer.write(new Map([["session", [{ id: "two", message: "second" }]]])),
  ).rejects.toThrow();
  expect(
    (await readdir(tempDir)).filter((name) => name.endsWith(".tmp")),
  ).toEqual([]);
});

test("coalesced queue writes durably preserve the newest snapshot", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-queue-store-"));
  const path = join(tempDir, "queues.json");
  const writer = new CoalescedQueueStoreWriter(path);
  const first = writer.write(
    new Map([["session", [{ id: "one", message: "first" }]]]),
  );
  const second = writer.write(
    new Map([
      [
        "session",
        [
          { id: "one", message: "first" },
          {
            id: "two",
            message: "newest",
            images: [
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
          },
        ],
      ],
    ]),
  );
  await Promise.all([first, second]);
  expect(readQueueStore(path).get("session")).toEqual([
    { id: "one", message: "first" },
    {
      id: "two",
      message: "newest",
      images: [
        {
          type: "image",
          data: "aGVsbG8=",
          mimeType: "image/png",
          name: undefined,
        },
      ],
    },
  ]);
});
