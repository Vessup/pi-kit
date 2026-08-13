import assert from "node:assert/strict";
import test from "node:test";
import { preserveRetryAroundQuiescence, quiesceQueueMutations, serializeQueueMutation, transactionalQueueMutation } from "../web/server/queue-mutation.ts";

test("session queue mutations are deterministic and serialized", async () => {
	const state: { queueMutationTail?: Promise<void> } = {};
	const order: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const first = serializeQueueMutation(state, async () => { order.push("first:start"); await gate; order.push("first:end"); });
	const second = serializeQueueMutation(state, async () => { order.push("second"); });
	await Bun.sleep(0);
	assert.deepEqual(order, ["first:start"]);
	release();
	await Promise.all([first, second]);
	assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("queue mutation quiescing drains admitted work and rejects late intake", async () => {
	const state: { queueMutationTail?: Promise<void>; queueMutationsQuiesced?: boolean } = {};
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const admitted = serializeQueueMutation(state, () => gate);
	let drained = false;
	const quiesced = quiesceQueueMutations(state).then(() => { drained = true; });
	await Bun.sleep(0);
	assert.equal(drained, false);
	await assert.rejects(serializeQueueMutation(state, async () => undefined), /quiesced/);
	release();
	await Promise.all([admitted, quiesced]);
	assert.equal(drained, true);
});

test("armed queue retry is cancelled during migration and resumed only after intake reopens", () => {
	let armed = true;
	let intakeOpen = true;
	const order: string[] = [];
	const finish = preserveRetryAroundQuiescence({
		isArmed: () => armed,
		cancel: () => { armed = false; order.push("cancel"); },
		reopen: () => { intakeOpen = true; order.push("reopen"); },
		resume: () => { assert.equal(intakeOpen, true); armed = true; order.push("resume"); },
	});
	intakeOpen = false;
	assert.equal(armed, false);
	finish();
	assert.deepEqual(order, ["cancel", "reopen", "resume"]);
	assert.equal(armed, true);
});

test("unarmed queue retry is not spuriously scheduled after migration", () => {
	let resumed = false;
	const finish = preserveRetryAroundQuiescence({
		isArmed: () => false,
		cancel: () => assert.fail("unarmed timer cancelled"),
		reopen: () => undefined,
		resume: () => { resumed = true; },
	});
	finish();
	assert.equal(resumed, false);
});

test("exhausted discard persistence failure restores the uncertain snapshot", async () => {
	let queue = [{ id: "uncertain", deliveryState: "delivering" as const }];
	await assert.rejects(transactionalQueueMutation({
		get: () => queue,
		set: (next) => { queue = next; },
		clone: (value) => value.map((item) => ({ ...item })),
		mutate: (draft) => { draft.splice(0, 1); },
		persist: async () => { throw new Error("disk failed"); },
	}), /disk failed/);
	assert.deepEqual(queue, [{ id: "uncertain", deliveryState: "delivering" }]);
});

test("failed persistence rolls back only its serialized mutation", async () => {
	const state: { queueMutationTail?: Promise<void> } = {};
	let queue = ["original"];
	let rejectWrite!: (error: Error) => void;
	const failedWrite = new Promise<void>((_, reject) => { rejectWrite = reject; });
	const failed = serializeQueueMutation(state, () => transactionalQueueMutation({
		get: () => queue, set: (next) => { queue = next; }, clone: (value) => [...value],
		mutate: (draft) => { draft.push("failed"); }, persist: () => failedWrite,
	}));
	const later = serializeQueueMutation(state, () => transactionalQueueMutation({
		get: () => queue, set: (next) => { queue = next; }, clone: (value) => [...value],
		mutate: (draft) => { draft.push("later"); }, persist: async () => undefined,
	}));
	rejectWrite(new Error("disk failed"));
	await assert.rejects(failed, /disk failed/);
	await later;
	assert.deepEqual(queue, ["original", "later"]);
});

test("background accepted-removal retry does not retain the mutation tail", async () => {
	const state: { queueMutationTail?: Promise<void> } = {};
	let release!: () => void;
	const retry = new Promise<void>((resolve) => { release = resolve; });
	const accepted = serializeQueueMutation(state, async () => { void retry; });
	await accepted;
	let laterRan = false;
	await serializeQueueMutation(state, async () => { laterRan = true; });
	assert.equal(laterRan, true);
	release();
});
