export type SerializedMutationState = { queueMutationTail?: Promise<void>; queueMutationsQuiesced?: boolean };

/** Cancel an armed retry for a quiesced transaction and restore it after intake reopens. */
export function preserveRetryAroundQuiescence(options: {
	isArmed: () => boolean;
	cancel: () => void;
	reopen: () => void;
	resume: () => void;
}): () => void {
	const wasArmed = options.isArmed();
	if (wasArmed) options.cancel();
	return () => {
		options.reopen();
		if (wasArmed) options.resume();
	};
}

/** Serialize queue work per session without poisoning the tail when one task fails. */
export function serializeQueueMutation<T>(state: SerializedMutationState, task: () => Promise<T>): Promise<T> {
	if (state.queueMutationsQuiesced) return Promise.reject(new Error("Queue mutations are quiesced"));
	const run = (state.queueMutationTail ?? Promise.resolve()).catch(() => undefined).then(task);
	state.queueMutationTail = run.then(() => undefined, () => undefined);
	return run;
}

/** Stop intake and wait for all already-admitted mutations. */
export async function quiesceQueueMutations(state: SerializedMutationState): Promise<void> {
	state.queueMutationsQuiesced = true;
	await state.queueMutationTail?.catch(() => undefined);
}

/** Apply an in-memory mutation transactionally; a failed write restores only this task's snapshot. */
export async function transactionalQueueMutation<T>(options: {
	get: () => T;
	set: (value: T) => void;
	clone: (value: T) => T;
	mutate: (draft: T) => void;
	persist: () => Promise<void>;
}): Promise<void> {
	const previous = options.clone(options.get());
	const draft = options.clone(previous);
	options.mutate(draft);
	options.set(draft);
	try {
		await options.persist();
	} catch (error) {
		options.set(previous);
		throw error;
	}
}
