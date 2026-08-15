import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { notFound } from "./http-utils.js";

function isWithinDir(child: string, parent: string): boolean {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function staticFileResponse(filePath: string, isAppShell = false): Response {
	const response = new Response(Bun.file(filePath));
	if (isAppShell) response.headers.set("cache-control", "no-cache");
	return response;
}

export function createStaticAssetResponder(distDir: string): (request: Request) => Response | undefined {
	const root = resolve(distDir);
	return (request) => {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return undefined;
		let pathname: string;
		try {
			pathname = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
		} catch {
			return new Response("Bad request", { status: 400 });
		}
		const filePath = resolve(root, pathname);
		if (!isWithinDir(filePath, root)) return new Response("Forbidden", { status: 403 });
		try {
			if (statSync(filePath).isFile()) return staticFileResponse(filePath, pathname === "index.html");
		} catch {
			// Fall through to the app shell.
		}
		try {
			const appShellPath = join(root, "index.html");
			if (!statSync(appShellPath).isFile()) return notFound();
			return staticFileResponse(appShellPath, true);
		} catch {
			return notFound();
		}
	};
}
