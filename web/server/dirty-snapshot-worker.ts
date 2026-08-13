export type DirtySnapshotRetryWorkerOptions = {
	persist: () => Promise<void>;
	delay?: (milliseconds: number) => Promise<void>;
	onError?: (error: unknown) => void;
	baseDelayMs?: number;
	maxDelayMs?: number;
};

/** A single coalescing retry loop for snapshots whose foreground mutation already succeeded. */
export class DirtySnapshotRetryWorker {
	private revision = 0;
	private persistedRevision = 0;
	private running?: Promise<void>;
	private cancelled = false;
	private cancelDelay?: () => void;

	constructor(private readonly options: DirtySnapshotRetryWorkerOptions) {}

	markDirty(): void {
		if (this.cancelled) return;
		this.revision++;
		if (!this.running) this.start();
	}

	cancel(): void {
		this.cancelled = true;
		this.cancelDelay?.();
		this.cancelDelay = undefined;
	}

	/** Stop retries and wait for an already-started persistence attempt to finish. */
	async cancelAndDrain(): Promise<void> {
		this.cancel();
		await this.running;
	}

	/** Drain an existing write, then make one final snapshot attempt within one deadline. */
	async flushAndCancel(timeoutMs: number): Promise<boolean> {
		this.cancel();
		const deadline = Date.now() + Math.max(0, timeoutMs);
		if (this.running && !(await this.withinDeadline(this.running.then(() => true), deadline))) return false;
		return this.withinDeadline(this.options.persist().then(() => true, (error) => {
			this.options.onError?.(error);
			return false;
		}), deadline);
	}

	private async withinDeadline(operation: Promise<boolean>, deadline: number): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const remaining = Math.max(0, deadline - Date.now());
		const timeout = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), remaining);
			timer.unref?.();
		});
		try {
			return await Promise.race([operation, timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	isRunning(): boolean {
		return this.running !== undefined;
	}

	private start(): void {
		this.running = this.run().finally(() => {
			this.running = undefined;
			// markDirty can interleave after run observes a clean revision but before
			// this finalizer clears running. Recheck after clearing so that revision
			// cannot be stranded without an owner.
			if (!this.cancelled && this.persistedRevision < this.revision) this.start();
		});
	}

	private async wait(milliseconds: number): Promise<void> {
		let cancel!: () => void;
		const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
		this.cancelDelay = cancel;
		try {
			const delay = this.options.delay
				? this.options.delay(milliseconds)
				: new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, milliseconds);
					timer.unref?.();
					cancelled.then(() => clearTimeout(timer));
				});
			await Promise.race([delay, cancelled]);
		} finally {
			if (this.cancelDelay === cancel) this.cancelDelay = undefined;
		}
	}

	private async run(): Promise<void> {
		let failures = 0;
		while (!this.cancelled) {
			const targetRevision = this.revision;
			try {
				await this.options.persist();
				this.persistedRevision = Math.max(this.persistedRevision, targetRevision);
				failures = 0;
				if (targetRevision === this.revision) return;
			} catch (error) {
				if (this.cancelled) return;
				this.options.onError?.(error);
				failures++;
				const base = this.options.baseDelayMs ?? 250;
				const maximum = this.options.maxDelayMs ?? 30_000;
				const milliseconds = Math.min(maximum, base * 2 ** Math.min(failures - 1, 16));
				await this.wait(milliseconds);
			}
		}
	}
}
