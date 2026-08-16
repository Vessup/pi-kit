import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const MANAGED_SESSION_STORE_VERSION = 1;

type ManagedSessionStoreFile = {
  version: number;
  files: string[];
};

function fileKey(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return resolve(file);
  }
}

function readFiles(path: string): Set<string> {
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<ManagedSessionStoreFile>;
    if (
      parsed.version !== MANAGED_SESSION_STORE_VERSION ||
      !Array.isArray(parsed.files) ||
      parsed.files.some((file) => typeof file !== "string")
    ) {
      throw new Error("invalid managed session store");
    }
    return new Set(parsed.files.map(fileKey));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

export class ManagedSessionStore {
  readonly #path: string;
  readonly #files: Set<string>;

  constructor(path: string) {
    this.#path = path;
    this.#files = readFiles(path);
  }

  has(file: string): boolean {
    return this.#files.has(fileKey(file));
  }

  list(): string[] {
    return [...this.#files];
  }

  add(file: string): void {
    const normalized = fileKey(file);
    if (this.#files.has(normalized)) return;
    this.#files.add(normalized);
    try {
      this.#persist();
    } catch (error) {
      this.#files.delete(normalized);
      throw error;
    }
  }

  delete(file: string): void {
    const normalized = fileKey(file);
    if (!this.#files.delete(normalized)) return;
    try {
      this.#persist();
    } catch (error) {
      this.#files.add(normalized);
      throw error;
    }
  }

  recanonicalize(): void {
    const normalized = new Set([...this.#files].map(fileKey));
    if (
      normalized.size === this.#files.size &&
      [...normalized].every((file) => this.#files.has(file))
    )
      return;
    const snapshot = new Set(this.#files);
    this.#files.clear();
    for (const file of normalized) this.#files.add(file);
    try {
      this.#persist();
    } catch (error) {
      this.#files.clear();
      for (const file of snapshot) this.#files.add(file);
      throw error;
    }
  }

  replace(previousFile: string | undefined, nextFile: string): void {
    const previous = previousFile ? fileKey(previousFile) : undefined;
    const next = fileKey(nextFile);
    if ((previous === next || !previous) && this.#files.has(next)) return;
    const snapshot = new Set(this.#files);
    if (previous) this.#files.delete(previous);
    this.#files.add(next);
    try {
      this.#persist();
    } catch (error) {
      this.#files.clear();
      for (const file of snapshot) this.#files.add(file);
      throw error;
    }
  }

  #persist(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporary,
        `${JSON.stringify({ version: MANAGED_SESSION_STORE_VERSION, files: this.list() }, null, 2)}\n`,
        { mode: 0o600 },
      );
      renameSync(temporary, this.#path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}
