import type { ClientCommandMessage, ServerEventMessage, ServerSessionMessage, ServerToClientMessage, WebQueuedMessage, WebSession } from "../protocol.js";
import { hasActiveWebSubagents } from "../protocol.js";
import { parseWebCompactCommand } from "../compact-command.js";
import { isWebReloadCommand } from "../reload-command.js";
import { DirtySnapshotRetryWorker } from "./dirty-snapshot-worker.js";
import { CommandDeliveryUncertainError } from "./managed-rpc-session.js";
import { persistPreDeliveryTransition, queueDeliveryFailureDisposition } from "./queue-delivery.js";
import { serializeQueueMutation, transactionalQueueMutation, quiesceQueueMutations } from "./queue-mutation.js";
import type { CoalescedQueueStoreWriter } from "./queue-store.js";
import type { ClientSocketData, SessionRecord } from "./server-types.js";

type QueueCoordinatorOptions = {
	persistedQueues: Map<string, WebQueuedMessage[]>;
	queueStoreWriter: CoalescedQueueStoreWriter;
	currentRecord: (id: string) => SessionRecord | undefined;
	isShutdownStarted: () => boolean;
	broadcast: (sessionId: string, message: ServerToClientMessage) => void;
	deliverCommand: (record: SessionRecord, command: ClientCommandMessage["command"]) => Promise<unknown>;
	projectSession: (record: SessionRecord, includeSubagentTranscripts?: boolean) => WebSession;
};

export function createSessionQueueCoordinator(options: QueueCoordinatorOptions) {
	const { persistedQueues, queueStoreWriter, currentRecord, isShutdownStarted, broadcast, deliverCommand, projectSession } = options;

	function webQueueEvent(record: SessionRecord): ServerEventMessage {
		return { type: "server.event", sessionId: record.id, event: { type: "web_queue_update", queue: record.queue } };
	}

	function cloneWebQueue(queue: WebQueuedMessage[]): WebQueuedMessage[] {
		return queue.map((item) => ({ ...item, images: item.images?.map((image) => ({ ...image })) }));
	}

	function setWebQueueState(record: SessionRecord, queue: WebQueuedMessage[]): void {
		record.queue = queue;
	}

	function persistWebQueue(record: SessionRecord): Promise<void> {
		const sessionId = record.id;
		const queue = cloneWebQueue(record.queue);
		return queueStoreWriter.mutate(persistedQueues, (queues) => {
			if (queue.length > 0) queues.set(sessionId, queue);
			else queues.delete(sessionId);
		});
	}

	async function enqueueWebFollowUp(record: SessionRecord, item: WebQueuedMessage): Promise<void> {
		await serializeQueueMutation(record, async () => {
			await transactionalQueueMutation({
				get: () => record.queue,
				set: (queue) => setWebQueueState(record, queue),
				clone: cloneWebQueue,
				mutate: (queue) => { queue.push(item); },
				persist: () => persistWebQueue(record),
			});
			broadcast(record.id, webQueueEvent(record));
			if (record.status === "idle" && record.agentRunning !== true) scheduleQueueSettleFallback(record);
		});
	}

	async function migratePersistedQueue(record: SessionRecord, oldId: string, newId: string): Promise<void> {
		await quiesceQueueMutations(record);
		if (record.queueDirtyWorker) {
			await record.queueDirtyWorker.cancelAndDrain();
			record.queueDirtyWorker = undefined;
		}
		const queue = cloneWebQueue(record.queue);
		await queueStoreWriter.mutate(persistedQueues, (queues) => {
			queues.delete(oldId);
			if (queue.length > 0) queues.set(newId, queue);
			else queues.delete(newId);
		});
	}

	function scheduleWebQueueRetry(record: SessionRecord): void {
		if (record.queueRetryTimer || record.queue.length === 0) return;
		// Re-enter through the normal serialized flush only after intake has reopened.
		record.queueRetryTimer = setTimeout(() => {
			record.queueRetryTimer = undefined;
			if (currentRecord(record.id) === record) void flushWebQueue(record);
		}, 0);
		record.queueRetryTimer.unref?.();
	}

	function markWebQueueSnapshotDirty(record: SessionRecord): void {
		record.queueDirtyWorker ??= new DirtySnapshotRetryWorker({
			persist: () => persistWebQueue(record),
			onError: (error) => console.error(`Could not persist queue snapshot for ${record.id}:`, error),
		});
		record.queueDirtyWorker.markDirty();
	}

	function markAgentActivity(record: SessionRecord): void {
		record.activityGeneration = (record.activityGeneration ?? 0) + 1;
	}

	function markAgentSettling(record: SessionRecord): void {
		record.settlingGeneration = record.activityGeneration ?? 0;
	}

	function isCurrentAgentSettlement(record: SessionRecord): boolean {
		return record.settlingGeneration === undefined || record.settlingGeneration === (record.activityGeneration ?? 0);
	}

	function cancelQueueSettleFallback(record: SessionRecord): void {
		if (record.queueSettleFallbackTimer) clearTimeout(record.queueSettleFallbackTimer);
		record.queueSettleFallbackTimer = undefined;
	}

	function scheduleQueueSettleFallback(record: SessionRecord): void {
		if (record.queueSettleFallbackTimer || record.queue.length === 0) return;
		// Older native bridges did not forward agent_settled. Give Pi's extension
		// hooks time to finish, then advance the queue when no newer run has started.
		record.queueSettleFallbackTimer = setTimeout(() => {
			record.queueSettleFallbackTimer = undefined;
			if (currentRecord(record.id) !== record || record.agentRunning !== false) return;
			void flushWebQueue(record);
		}, 100);
		record.queueSettleFallbackTimer.unref?.();
	}

	function cancelWebQueueWork(record: SessionRecord): void {
		if (record.queueRetryTimer) clearTimeout(record.queueRetryTimer);
		record.queueRetryTimer = undefined;
		cancelQueueSettleFallback(record);
		record.queueDirtyWorker?.cancel();
		record.queueDirtyWorker = undefined;
	}

	async function broadcastWebQueue(record: SessionRecord): Promise<void> {
		await persistWebQueue(record);
		broadcast(record.id, webQueueEvent(record));
	}

	function broadcastQueueDelivery(record: SessionRecord, item: WebQueuedMessage, phase: "started" | "failed" | "uncertain", error?: string): void {
		broadcast(record.id, {
			type: "server.event",
			sessionId: record.id,
			event: { type: "web_queue_delivery", phase, item, error },
		} satisfies ServerEventMessage);
	}

	function broadcastReloadComplete(record: SessionRecord): void {
		broadcast(record.id, {
			type: "server.event",
			sessionId: record.id,
			event: {
				type: "message_end",
				message: {
					role: "assistant",
					timestamp: Date.now(),
					content: [{ type: "text", text: "Reload complete." }],
				},
			},
		} satisfies ServerEventMessage);
	}

	function sendSessionState(socket: Bun.ServerWebSocket<ClientSocketData>, record: SessionRecord): void {
		// A newly subscribed client receives one bounded full transcript snapshot;
		// subsequent subagent updates arrive as deltas.
		const payload: ServerSessionMessage = { type: "server.session", session: projectSession(record, true) };
		socket.send(JSON.stringify(payload));
		socket.send(JSON.stringify(webQueueEvent(record)));
		const uncertain = record.queue.find((item) => item.deliveryState === "delivering");
		if (uncertain) socket.send(JSON.stringify({ type: "server.event", sessionId: record.id, event: { type: "web_queue_delivery", phase: "uncertain", item: uncertain, error: "Delivery may already have been accepted; explicitly discard or confirm resubmission." } } satisfies ServerEventMessage));
	}

	async function flushWebQueue(record: SessionRecord): Promise<void> {
		if (isShutdownStarted()) return;
		return serializeQueueMutation(record, () => flushWebQueueLocked(record));
	}

	async function flushWebQueueLocked(record: SessionRecord): Promise<void> {
		if (record.queue.length === 0 || record.queueDeliveryActive || record.status !== "idle" || hasActiveWebSubagents(record.subagents)) return;
		let item = record.queue[0];
		if (!item || item.deliveryState === "delivering") return;
		// Persist the in-flight state before handing the prompt to Pi. A transient
		// storage failure is published and retried with a bounded policy; Pi is not
		// called until this transition is durable.
		const transitioned = await persistPreDeliveryTransition({
			persist: () => transactionalQueueMutation({
				get: () => record.queue, set: (queue) => setWebQueueState(record, queue), clone: cloneWebQueue,
				mutate: (queue) => { queue[0]!.deliveryState = "delivering"; },
				persist: () => persistWebQueue(record),
			}),
			previousAttempts: record.queueTransitionAttempts?.itemId === item.id ? record.queueTransitionAttempts.count : 0,
			publishError: (error, attempts, exhausted) => {
				record.queueTransitionAttempts = { itemId: item!.id, count: attempts };
				const message = error instanceof Error ? error.message : String(error);
				if (exhausted) {
					// Keep the cap terminal across every later flush trigger. This server-owned
					// uncertain state blocks delivery until explicit discard/resubmit, while the
					// coalesced worker keeps trying to make that disposition durable.
					// transactionalQueueMutation replaces the live queue when it rolls back;
					// mark that restored head, not the stale object captured before the write.
					const liveItem = record.queue.find((queued) => queued.id === item!.id);
					if (!liveItem) return;
					liveItem.deliveryState = "delivering";
					setWebQueueState(record, record.queue);
					item = liveItem;
					broadcastQueueDelivery(record, liveItem, "uncertain", `Could not persist delivery transition after ${attempts} attempts: ${message}; explicitly discard or confirm resubmission.`);
					broadcast(record.id, webQueueEvent(record));
					markWebQueueSnapshotDirty(record);
				} else {
					broadcastQueueDelivery(record, item!, "failed", `Could not persist delivery transition: ${message} (attempt ${attempts}; retrying)`);
				}
			},
			scheduleRetry: (delayMs) => {
				if (record.queueRetryTimer) return;
				record.queueRetryTimer = setTimeout(() => {
					record.queueRetryTimer = undefined;
					if (currentRecord(record.id) === record && record.queue[0]?.id === item!.id) void flushWebQueue(record);
				}, delayMs);
				record.queueRetryTimer.unref?.();
			},
		});
		if (!transitioned) return;
		record.queueTransitionAttempts = undefined;
		item = record.queue[0]!;
		record.queueDeliveryActive = item.id;
		let retryDelayMs: number | undefined;
		let persistenceError: unknown;
		let accepted = false;
		// Promote the follow-up into the transcript before asking Pi to start the
		// turn. The browser renders this as an optimistic user message and later
		// reconciles it with Pi's authoritative message_end event.
		broadcastQueueDelivery(record, item, "started");
		try {
			const compact = parseWebCompactCommand(item.message);
			if (isWebReloadCommand(item.message)) {
				if (item.images?.length) throw new Error("/reload does not accept image attachments");
				// Queued control commands execute through their dedicated route only after
				// the current run reaches idle; never turn /reload into an ordinary prompt.
				await deliverCommand(record, { type: "reload" });
				broadcastReloadComplete(record);
			} else if (compact) {
				if (item.images?.length) throw new Error("/compact does not accept image attachments");
				await deliverCommand(record, { type: "compact", customInstructions: compact.customInstructions });
			} else {
				await deliverCommand(record, {
					type: "prompt",
					message: item.message,
					images: item.images,
					// If an older bridge reports agent_end before Pi fully settles, keep this
					// as a safe Pi follow-up rather than accidentally steering the completed run.
					streamingBehavior: "followUp",
				});
			}
			accepted = true;
		} catch (error) {
			if (error instanceof CommandDeliveryUncertainError) {
				const message = error.message;
				broadcastQueueDelivery(record, item, "uncertain", `${message}; delivery may already have been accepted, so explicitly discard or confirm resubmission.`);
				broadcast(record.id, webQueueEvent(record));
				return;
			}
			// A normal rejection proves Pi did not accept the command, so this item may
			// return to the retryable queued state. Process death between send/response
			// is represented by the durable delivering state across daemon restart.
			const uncertainSnapshot = cloneWebQueue(record.queue);
			delete item.deliveryState;
			const message = error instanceof Error ? error.message : String(error);
			const previousAttempts = record.queueDeliveryAttempts?.itemId === item.id
				? record.queueDeliveryAttempts.count
				: 0;
			const disposition = queueDeliveryFailureDisposition(previousAttempts);
			const attempts = disposition.attempts;
			record.queueDeliveryAttempts = { itemId: item.id, count: attempts };
			const exhausted = disposition.discard;
			broadcastQueueDelivery(
				record,
				item,
				"failed",
				exhausted ? `${message} (discarded after ${attempts} attempts)` : `${message} (attempt ${attempts}; retrying)`,
			);
			if (exhausted) {
				// Do not retain a poisoned queue head that can be submitted much later by
				// an unrelated settled/reconnect event. The failed delivery event is the
				// explicit disposition presented to subscribed clients.
				record.queue = record.queue.filter((queued) => queued.id !== item.id);
				record.queueDeliveryAttempts = undefined;
			} else if (!record.queueRetryTimer) {
				retryDelayMs = disposition.retryDelayMs!;
			}
			try {
				await broadcastWebQueue(record);
			} catch (error) {
				// The failed discard/retry-state write has unknown durability. Restore the
				// pre-mutation delivering snapshot so neither memory nor a later write can
				// silently authorize redelivery.
				setWebQueueState(record, uncertainSnapshot);
				persistenceError = error;
			}
			console.error(`Could not deliver queued message for ${record.id}:`, error);
		} finally {
			record.queueDeliveryActive = undefined;
		}
		if (persistenceError) {
			// Durable state may still say "delivering". Surface that uncertainty rather
			// than silently losing cleanup or retrying a prompt after a storage failure.
			const message = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
			const uncertain = record.queue.find((queued) => queued.id === item.id);
			if (uncertain) {
				uncertain.deliveryState = "delivering";
				broadcastQueueDelivery(record, uncertain, "uncertain", `Could not persist delivery failure: ${message}; explicitly discard or confirm resubmission.`);
				broadcast(record.id, webQueueEvent(record));
			}
			return;
		}
		if (accepted) {
			// routeCommand accepted the prompt. From this point onward it must never be
			// retried, even when durable removal fails: retry only the persistence write.
			record.queue = record.queue.filter((queued) => queued.id !== item.id);
			record.queueDeliveryAttempts = undefined;
			broadcast(record.id, webQueueEvent(record));
			// One cancellable worker coalesces accepted removals and every later queue
			// mutation into current snapshots; accepted prompts are never redelivered.
			markWebQueueSnapshotDirty(record);
			return;
		}
		// Arm the retry only after durable persistence and active-delivery cleanup.
		// Otherwise a slow write can let the timer fire against the active guard and
		// consume the sole retry without another trigger.
		if (retryDelayMs !== undefined && !record.queueRetryTimer) {
			record.queueRetryTimer = setTimeout(() => {
				record.queueRetryTimer = undefined;
				if (currentRecord(record.id) === record && record.queue[0]?.id === item.id) {
					void flushWebQueue(record);
				}
			}, retryDelayMs);
			record.queueRetryTimer.unref?.();
		}
	}


	async function routeQueueCommand(
		record: SessionRecord,
		command: Extract<ClientCommandMessage["command"], { type: "steer_queue_item" | "replace_queue" | "reconcile_queue" }>,
	): Promise<unknown> {
		if (command.type === "steer_queue_item") {
			return serializeQueueMutation(record, async () => {
				if (record.queueDeliveryActive) throw new Error("Another queued message is already being delivered");
				const queued = record.queue.find((item) => item.id === command.itemId);
				if (!queued) throw new Error(`Unknown queue item ${command.itemId}`);
				if (queued.deliveryState === "delivering") throw new Error(`Queue item ${command.itemId} has uncertain delivery`);

				// Make the in-flight disposition durable before handing the item to Pi. If
				// the daemon exits after acceptance but before cleanup, restart recovery
				// leaves the item uncertain rather than silently sending it twice.
				await transactionalQueueMutation({
					get: () => record.queue,
					set: (queue) => setWebQueueState(record, queue),
					clone: cloneWebQueue,
					mutate: (queue) => {
						const item = queue.find((candidate) => candidate.id === command.itemId);
						if (!item) throw new Error(`Unknown queue item ${command.itemId}`);
						item.deliveryState = "delivering";
					},
					persist: () => persistWebQueue(record),
				});
				const item = record.queue.find((candidate) => candidate.id === command.itemId)!;
				record.queueDeliveryActive = item.id;
				broadcast(record.id, webQueueEvent(record));
				broadcastQueueDelivery(record, item, "started");
				try {
					await deliverCommand(record, {
						type: "prompt",
						message: item.message,
						images: item.images,
						// If the previous run settled during the durable transition, start the
						// queued prompt immediately instead of steering a run that no longer exists.
						streamingBehavior: record.status === "working" ? "steer" : undefined,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (error instanceof CommandDeliveryUncertainError) {
						broadcastQueueDelivery(record, item, "uncertain", `${message}; delivery may already have been accepted, so explicitly discard or confirm resubmission.`);
						broadcast(record.id, webQueueEvent(record));
						throw error;
					}
					broadcastQueueDelivery(record, item, "failed", message);
					try {
						await transactionalQueueMutation({
							get: () => record.queue,
							set: (queue) => setWebQueueState(record, queue),
							clone: cloneWebQueue,
							mutate: (queue) => {
								const retryable = queue.find((candidate) => candidate.id === item.id);
								if (retryable) delete retryable.deliveryState;
							},
							persist: () => persistWebQueue(record),
						});
						broadcast(record.id, webQueueEvent(record));
					} catch (persistenceError) {
						const persistenceMessage = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
						const uncertain = record.queue.find((candidate) => candidate.id === item.id);
						if (uncertain) {
							uncertain.deliveryState = "delivering";
							broadcastQueueDelivery(record, uncertain, "uncertain", `Could not persist steer failure: ${persistenceMessage}; explicitly discard or confirm resubmission.`);
							broadcast(record.id, webQueueEvent(record));
						}
						throw new Error(`${message}; could not persist queued-message recovery: ${persistenceMessage}`);
					}
					throw error;
				} finally {
					record.queueDeliveryActive = undefined;
				}

				// Pi accepted the steer. Remove it from memory immediately and persist the
				// accepted-removal snapshot in the bounded dirty worker; it is never retried.
				record.queue = record.queue.filter((candidate) => candidate.id !== item.id);
				broadcast(record.id, webQueueEvent(record));
				markWebQueueSnapshotDirty(record);
			});
		}
		if (command.type === "replace_queue") {
			return serializeQueueMutation(record, async () => {
			const uncertainById = new Map(record.queue
				.filter((item) => item.deliveryState === "delivering")
				.map((item) => [item.id, item]));
			const seenIds = new Set<string>();
			for (const replacement of command.queue) {
				if (seenIds.has(replacement.id)) throw new Error(`Duplicate queue item ${replacement.id}`);
				if (isWebReloadCommand(replacement.message) && replacement.images?.length) throw new Error("/reload does not accept image attachments");
				if (parseWebCompactCommand(replacement.message) && replacement.images?.length) throw new Error("/compact does not accept image attachments");
				seenIds.add(replacement.id);
				const uncertain = uncertainById.get(replacement.id);
				if ("deliveryState" in replacement && replacement.deliveryState !== undefined && !uncertain) {
					throw new Error(`Queue item ${replacement.id} cannot set server-owned delivery state`);
				}
				if (uncertain && (replacement.message !== uncertain.message || JSON.stringify(replacement.images ?? []) !== JSON.stringify(uncertain.images ?? []))) {
					throw new Error(`Uncertain queue item ${uncertain.id} requires explicit discard or resubmit`);
				}
			}
			for (const uncertain of uncertainById.values()) {
				if (!seenIds.has(uncertain.id)) throw new Error(`Uncertain queue item ${uncertain.id} requires explicit discard or resubmit`);
			}
			await transactionalQueueMutation({
				get: () => record.queue,
				set: (queue) => setWebQueueState(record, queue),
				clone: cloneWebQueue,
				mutate: (queue) => { queue.splice(0, queue.length, ...command.queue.map((replacement) => ({
					...replacement,
					images: replacement.images?.map((image) => ({ ...image })),
					...(uncertainById.has(replacement.id) ? { deliveryState: "delivering" as const } : {}),
				}))); },
				persist: () => persistWebQueue(record),
			});
			broadcast(record.id, webQueueEvent(record));
			if (record.status === "idle" && record.agentRunning !== true && record.queue.length > 0) scheduleQueueSettleFallback(record);
			});
		}
		if (command.type === "reconcile_queue") {
			return serializeQueueMutation(record, async () => {
			const item = record.queue.find((queued) => queued.id === command.itemId);
			if (!item || item.deliveryState !== "delivering") throw new Error(`Queue item ${command.itemId} is not uncertain`);
			await transactionalQueueMutation({
				get: () => record.queue,
				set: (queue) => setWebQueueState(record, queue),
				clone: cloneWebQueue,
				mutate: (queue) => {
					const index = queue.findIndex((queued) => queued.id === item.id);
					if (command.action === "discard") queue.splice(index, 1);
					else delete queue[index]!.deliveryState;
				},
				persist: () => persistWebQueue(record),
			});
			broadcast(record.id, webQueueEvent(record));
			if (command.action === "resubmit") setTimeout(() => void flushWebQueue(record), 0);
			});
		}
		throw new Error("Unsupported queue command");
	}

	return {
		webQueueEvent, cloneWebQueue, setWebQueueState, persistWebQueue, enqueueWebFollowUp, migratePersistedQueue,
		scheduleWebQueueRetry, markWebQueueSnapshotDirty, markAgentActivity, markAgentSettling,
		isCurrentAgentSettlement, cancelQueueSettleFallback, scheduleQueueSettleFallback, cancelWebQueueWork,
		broadcastWebQueue, broadcastQueueDelivery, broadcastReloadComplete, sendSessionState, flushWebQueue, routeQueueCommand,
	};
}
