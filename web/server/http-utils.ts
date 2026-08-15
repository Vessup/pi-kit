export function jsonResponse(value: unknown, init?: ResponseInit): Response {
	const headers = new Headers(init?.headers);
	if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
	return new Response(JSON.stringify(value), { ...init, status: init?.status ?? 200, headers });
}

export function textResponse(value: string, init?: ResponseInit): Response {
	return new Response(value, { status: init?.status ?? 200, headers: init?.headers });
}

export function notFound(): Response {
	return textResponse("Not found", { status: 404 });
}

export function badRequest(message: string): Response {
	return jsonResponse({ error: message }, { status: 400 });
}

export function internalError(message: string): Response {
	return jsonResponse({ error: message }, { status: 500 });
}

export function isTrustedBrowserOrigin(request: Request, publishedUrl?: string): boolean {
	const rawOrigin = request.headers.get("origin");
	if (!rawOrigin) return false;
	try {
		const origin = new URL(rawOrigin);
		if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
		const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
		if (forwardedHost) {
			if (!publishedUrl) return false;
			const published = new URL(publishedUrl);
			return origin.origin === published.origin && forwardedHost === published.host.toLowerCase();
		}
		const hostname = origin.hostname.toLowerCase();
		if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") return false;
		const requestHost = (request.headers.get("host") || new URL(request.url).host).toLowerCase();
		return origin.host.toLowerCase() === requestHost;
	} catch {
		return false;
	}
}
