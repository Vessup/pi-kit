import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type ResolveWebCwdOptions = {
	baseDir?: string;
	homeDir?: string;
};

/** Resolve a cwd entered in the browser using ordinary shell-style home shorthand. */
export function resolveWebCwd(input: string, options: ResolveWebCwdOptions = {}): string {
	const value = input.trim();
	if (!value) throw new Error("Missing cwd");
	const home = resolve(options.homeDir ?? homedir());
	if (value === "~") return home;
	if (value.startsWith("~/")) return resolve(join(home, value.slice(2)));
	if (value.startsWith("~")) throw new Error("Only ~ and ~/path home-directory shortcuts are supported");
	if (isAbsolute(value)) return resolve(value);
	return resolve(options.baseDir ?? process.cwd(), value);
}
