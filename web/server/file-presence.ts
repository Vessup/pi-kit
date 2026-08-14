import { statSync } from "node:fs";

export function errorConfirmsMissingPath(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Return true only when the filesystem explicitly reports that the path is absent. */
export function isConfirmedMissingPath(path: string): boolean {
	try {
		statSync(path);
		return false;
	} catch (error) {
		return errorConfirmsMissingPath(error);
	}
}
