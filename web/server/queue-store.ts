import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WebQueuedMessage } from "../protocol.js";

const QUEUE_STORE_VERSION = 2;
type QueueStoreFile = { version: 2; queues: Record<string, WebQueuedMessage[]> };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseQueuedMessage(value: unknown): WebQueuedMessage | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.message !== "string") return undefined;
	if (value.deliveryState !== undefined && value.deliveryState !== "delivering") return undefined;
	let images: NonNullable<WebQueuedMessage["images"]> | undefined;
	if (value.images !== undefined) {
		if (!Array.isArray(value.images)) return undefined;
		images = [];
		for (const image of value.images) {
			if (
				!isRecord(image)
				|| image.type !== "image"
				|| typeof image.data !== "string"
				|| typeof image.mimeType !== "string"
				|| (image.name !== undefined && typeof image.name !== "string")
			) return undefined;
			images.push({
				type: "image",
				data: image.data,
				mimeType: image.mimeType,
				name: image.name,
			});
		}
	}
	return {
		id: value.id,
		message: value.message,
		...(images?.length ? { images } : {}),
		...(value.deliveryState === "delivering" ? { deliveryState: "delivering" as const } : {}),
	};
}

function invalidQueueStore(path: string, detail: string): Error {
	return new Error(`Invalid queue store ${path}: ${detail}`);
}

export function readQueueStore(path: string): Map<string, WebQueuedMessage[]> {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return new Map();
		throw error;
	}

	const parsed: unknown = JSON.parse(contents);
	if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== QUEUE_STORE_VERSION) || !isRecord(parsed.queues)) {
		throw invalidQueueStore(path, "expected a supported version and queues object");
	}
	const queues = new Map<string, WebQueuedMessage[]>();
	for (const [sessionId, rawQueue] of Object.entries(parsed.queues)) {
		if (!Array.isArray(rawQueue)) throw invalidQueueStore(path, `queue ${JSON.stringify(sessionId)} is not an array`);
		const queue: WebQueuedMessage[] = [];
		for (const item of rawQueue) {
			const parsedItem = parseQueuedMessage(item);
			if (!parsedItem) throw invalidQueueStore(path, `queue ${JSON.stringify(sessionId)} contains an invalid item`);
			queue.push(parsedItem);
		}
		if (queue.length > 0) queues.set(sessionId, queue);
	}
	return queues;
}

function cloneQueues(queues: ReadonlyMap<string, readonly WebQueuedMessage[]>): Map<string, WebQueuedMessage[]> {
	return new Map(Array.from(queues, ([sessionId, queue]) => [sessionId, queue.map((item) => ({
		...item,
		images: item.images?.map((image) => ({ ...image })),
	}))]));
}

function snapshotQueueStore(queues: ReadonlyMap<string, readonly WebQueuedMessage[]>): QueueStoreFile {
	const serialized: QueueStoreFile = { version: QUEUE_STORE_VERSION, queues: {} };
	for (const [sessionId, queue] of cloneQueues(queues)) {
		if (queue.length > 0) serialized.queues[sessionId] = queue;
	}
	return serialized;
}

function restoreQueues(target: Map<string, WebQueuedMessage[]>, snapshot: ReadonlyMap<string, readonly WebQueuedMessage[]>): void {
	target.clear();
	for (const [sessionId, queue] of cloneQueues(snapshot)) target.set(sessionId, queue);
}

/** Atomically replace the queue store without blocking the server on filesystem I/O. */
export async function writeQueueStore(path: string, queues: ReadonlyMap<string, readonly WebQueuedMessage[]>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(tempPath, JSON.stringify(snapshotQueueStore(queues)), { mode: 0o600 });
		await rename(tempPath, path);
	} finally {
		await rm(tempPath, { force: true }).catch(() => undefined);
	}
}

type PendingWrite = {
	revision: number;
	snapshot: QueueStoreFile;
	resolve: () => void;
	reject: (error: unknown) => void;
};

export type QueueSnapshotWriter = (contents: string) => Promise<void>;

/** Serializes shared-map transactions and coalesces their atomic snapshots. */
export class CoalescedQueueStoreWriter {
	private revision = 0;
	private pending: PendingWrite[] = [];
	private running = false;
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(private readonly path: string, private readonly snapshotWriter?: QueueSnapshotWriter) {}

	write(queues: ReadonlyMap<string, readonly WebQueuedMessage[]>): Promise<void> {
		return this.serialize(() => this.enqueue(snapshotQueueStore(queues)));
	}

	/** Mutate, snapshot, persist, and (on failure) roll back the shared map under one global lock. */
	mutate(queues: Map<string, WebQueuedMessage[]>, mutation: (queues: Map<string, WebQueuedMessage[]>) => void): Promise<void> {
		return this.serialize(async () => {
			const previous = cloneQueues(queues);
			try {
				mutation(queues);
				await this.enqueue(snapshotQueueStore(queues));
			} catch (error) {
				restoreQueues(queues, previous);
				throw error;
			}
		});
	}

	private serialize<T>(task: () => Promise<T>): Promise<T> {
		const run = this.mutationTail.catch(() => undefined).then(task);
		this.mutationTail = run.then(() => undefined, () => undefined);
		return run;
	}

	private enqueue(snapshot: QueueStoreFile): Promise<void> {
		const revision = ++this.revision;
		const promise = new Promise<void>((resolve, reject) => this.pending.push({ revision, snapshot, resolve, reject }));
		if (!this.running) {
			this.running = true;
			setTimeout(() => void this.flush(), 0);
		}
		return promise;
	}

	private async persist(snapshot: QueueStoreFile): Promise<void> {
		const contents = JSON.stringify(snapshot);
		if (this.snapshotWriter) {
			await this.snapshotWriter(contents);
			return;
		}
		await mkdir(dirname(this.path), { recursive: true });
		const tempPath = `${this.path}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
		try {
			await writeFile(tempPath, contents, { mode: 0o600 });
			await rename(tempPath, this.path);
		} finally {
			await rm(tempPath, { force: true }).catch(() => undefined);
		}
	}

	private async flush(): Promise<void> {
		while (this.pending.length > 0) {
			const target = this.pending[this.pending.length - 1]!;
			try {
				await this.persist(target.snapshot);
				const completed = this.pending.filter((write) => write.revision <= target.revision);
				this.pending = this.pending.filter((write) => write.revision > target.revision);
				for (const write of completed) write.resolve();
			} catch (error) {
				const failed = this.pending.filter((write) => write.revision <= target.revision);
				this.pending = this.pending.filter((write) => write.revision > target.revision);
				for (const write of failed) write.reject(error);
			}
		}
		this.running = false;
		if (this.pending.length > 0) {
			this.running = true;
			setTimeout(() => void this.flush(), 0);
		}
	}
}
