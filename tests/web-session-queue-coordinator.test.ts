import { expect, test } from "bun:test";
import type {
  ClientCommandMessage,
  ServerToClientMessage,
  WebSession,
} from "../web/protocol";
import { CoalescedQueueStoreWriter } from "../web/server/queue-store";
import type {
  ClientSocketData,
  SessionRecord,
} from "../web/server/server-types";
import { createSessionQueueCoordinator } from "../web/server/session-queue-coordinator";

function record(
  queue: SessionRecord["queue"],
  status: SessionRecord["status"] = "idle",
): SessionRecord {
  return {
    id: "session",
    cwd: "/repo",
    status,
    source: "web",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    kind: "managed",
    history: [],
    active: true,
    agentSockets: new Set(),
    clientSockets: new Set(),
    externalRequestTargets: new Map(),
    externalPending: new Map(),
    queue,
  };
}

function setup(target: SessionRecord) {
  const deliveries: ClientCommandMessage["command"][] = [];
  const broadcasts: ServerToClientMessage[] = [];
  let current: SessionRecord | undefined = target;
  const coordinator = createSessionQueueCoordinator({
    persistedQueues: new Map(),
    queueStoreWriter: new CoalescedQueueStoreWriter("/unused", async () => {}),
    currentRecord: () => current,
    isShutdownStarted: () => false,
    broadcast: (_id, message) => {
      broadcasts.push(message);
    },
    deliverCommand: async (_record, command) => {
      deliveries.push(command);
    },
    projectSession: (item) => item as unknown as WebSession,
  });
  return {
    coordinator,
    deliveries,
    broadcasts,
    replace: (next?: SessionRecord) => {
      current = next;
    },
  };
}

async function settleTimers(): Promise<void> {
  await Bun.sleep(150);
}

test("settle fallback advances queues when agent activity is initially unknown", async () => {
  const target = record([{ id: "queued", message: "run me" }]);
  const { coordinator, deliveries } = setup(target);
  coordinator.scheduleQueueSettleFallback(target);
  await settleTimers();
  expect(deliveries).toHaveLength(1);
  coordinator.cancelWebQueueWork(target);
});

test("uncertain deliveries block steering and all are reported on subscribe", async () => {
  const target = record(
    [
      { id: "uncertain-1", message: "first", deliveryState: "delivering" },
      { id: "uncertain-2", message: "second", deliveryState: "delivering" },
      { id: "ordinary", message: "third" },
    ],
    "working",
  );
  const { coordinator, deliveries } = setup(target);
  await expect(
    coordinator.routeQueueCommand(target, {
      type: "steer_queue_item",
      itemId: "ordinary",
    }),
  ).rejects.toThrow("uncertain delivery");
  expect(deliveries).toEqual([]);

  const frames: Array<{ event?: { type?: string; item?: { id?: string } } }> =
    [];
  coordinator.sendSessionState(
    {
      send: (value: string) => {
        frames.push(JSON.parse(value));
      },
    } as unknown as Bun.ServerWebSocket<ClientSocketData>,
    target,
  );
  expect(
    frames
      .filter((frame) => frame.event?.type === "web_queue_delivery")
      .map((frame) => frame.event?.item?.id),
  ).toEqual(["uncertain-1", "uncertain-2"]);
});

test("reordering an uncertain delivery behind an ordinary item still blocks flushing", async () => {
  const target = record([
    {
      id: "uncertain",
      message: "possibly accepted",
      deliveryState: "delivering",
    },
    { id: "ordinary", message: "must wait" },
  ]);
  const { coordinator, deliveries } = setup(target);

  await coordinator.routeQueueCommand(target, {
    type: "replace_queue",
    queue: [
      { id: "ordinary", message: "must wait" },
      { id: "uncertain", message: "possibly accepted" },
    ],
  });
  await coordinator.flushWebQueue(target);

  expect(target.queue[1]?.deliveryState).toBe("delivering");
  expect(deliveries).toEqual([]);
  coordinator.cancelWebQueueWork(target);
});

test("queued control commands cannot be converted into steering prompts", async () => {
  const target = record(
    [{ id: "compact", message: "/compact preserve names" }],
    "working",
  );
  const { coordinator, deliveries } = setup(target);
  await expect(
    coordinator.routeQueueCommand(target, {
      type: "steer_queue_item",
      itemId: "compact",
    }),
  ).rejects.toThrow("must remain queued");
  expect(target.queue).toEqual([
    { id: "compact", message: "/compact preserve names" },
  ]);
  expect(deliveries).toEqual([]);
});

test("settled failures advance queues without erasing the visible error", async () => {
  const target = record([{ id: "queued", message: "continue" }], "error");
  target.agentRunning = false;
  const { coordinator, deliveries } = setup(target);
  await coordinator.flushWebQueue(target);
  expect(deliveries).toHaveLength(1);
  expect(target.status).toBe("error");
  coordinator.cancelWebQueueWork(target);
});

test("resubmit retry is cancellable and cannot flush a stale record", async () => {
  const target = record([
    { id: "uncertain", message: "retry", deliveryState: "delivering" },
  ]);
  const { coordinator, deliveries, replace } = setup(target);
  await coordinator.routeQueueCommand(target, {
    type: "reconcile_queue",
    itemId: "uncertain",
    action: "resubmit",
  });
  replace(undefined);
  coordinator.cancelWebQueueWork(target);
  await Bun.sleep(20);
  expect(deliveries).toEqual([]);
});
