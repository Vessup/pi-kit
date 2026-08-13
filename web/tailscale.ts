import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5_000;
const TAILSCALE_CANDIDATES = [
	"tailscale",
	...(process.platform === "darwin" ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"] : []),
	"/usr/bin/tailscale",
	"/usr/local/bin/tailscale",
	"/opt/homebrew/bin/tailscale",
];

export type TailscaleWebSettings = {
	enabled: boolean;
	httpsPort: number;
	/** Named Tailscale Service. Requires a tagged host and admin approval. */
	serviceName?: string;
};

export type TailscaleStatus = {
	installed: boolean;
	enabled: boolean;
	available: boolean;
	published: boolean;
	url?: string;
	error?: string;
};

export type TailscaleRunner = (
	command: string,
	args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;
export type TailscaleProbe = (url: string) => Promise<boolean>;

type TailscaleCliStatus = {
	BackendState?: unknown;
	Self?: { DNSName?: unknown };
};

type WebSettingsFile = {
	web?: { tailscale?: { enabled?: unknown; httpsPort?: unknown; serviceName?: unknown } };
};

function integerPort(value: unknown, fallback = 8443): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535
		? value
		: fallback;
}

export function parseTailscaleWebSettings(value: unknown): TailscaleWebSettings {
	const file = value && typeof value === "object" ? value as WebSettingsFile : {};
	const serviceName = typeof file.web?.tailscale?.serviceName === "string"
		? file.web.tailscale.serviceName.trim().replace(/^svc:/, "")
		: "";
	return {
		enabled: file.web?.tailscale?.enabled === true,
		httpsPort: integerPort(file.web?.tailscale?.httpsPort),
		serviceName: serviceName || undefined,
	};
}

export async function readTailscaleWebSettings(settingsPath: string): Promise<TailscaleWebSettings> {
	try {
		return parseTailscaleWebSettings(JSON.parse(await readFile(settingsPath, "utf8")) as unknown);
	} catch {
		return parseTailscaleWebSettings(undefined);
	}
}

export async function findTailscaleCli(candidates = TAILSCALE_CANDIDATES): Promise<string | undefined> {
	for (const candidate of candidates) {
		if (candidate === "tailscale") {
			try {
				await execFileAsync(candidate, ["version"], { timeout: DEFAULT_TIMEOUT_MS });
				return candidate;
			} catch {
				continue;
			}
		}
		try {
			await access(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Keep looking in standard installation locations.
		}
	}
	return undefined;
}

export async function defaultTailscaleRunner(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
	const result = await execFileAsync(command, [...args], {
		timeout: DEFAULT_TIMEOUT_MS,
		maxBuffer: 4 * 1024 * 1024,
	});
	return { stdout: result.stdout, stderr: result.stderr };
}

function parseCliStatus(stdout: string): TailscaleCliStatus {
	const parsed: unknown = JSON.parse(stdout);
	if (!parsed || typeof parsed !== "object") throw new Error("Tailscale returned an invalid status response");
	return parsed as TailscaleCliStatus;
}

function publishedUrl(dnsName: string, httpsPort: number, serviceName?: string): string {
	const hostname = dnsName.replace(/\.+$/, "");
	const serviceHostname = serviceName
		? `${serviceName}.${hostname.split(".").slice(1).join(".")}`
		: hostname;
	return `https://${serviceHostname}${httpsPort === 443 ? "" : `:${httpsPort}`}/`;
}

function commandError(error: unknown): string {
	if (!error || typeof error !== "object") return String(error);
	const record = error as { stderr?: unknown; message?: unknown };
	const stderr = typeof record.stderr === "string" ? record.stderr.trim() : "";
	return stderr || (typeof record.message === "string" ? record.message : String(error));
}

export async function probeTailscaleUrl(url: string): Promise<boolean> {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		try {
			// Any HTTP response proves DNS, TLS, Serve routing, and the localhost
			// proxy are operational.
			await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1_500) });
			return true;
		} catch {
			if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	return false;
}

export async function disableTailscaleServe(options: {
	settings: TailscaleWebSettings;
	localPort: number;
	command?: string;
	run?: TailscaleRunner;
}): Promise<TailscaleStatus> {
	const command = options.command ?? await findTailscaleCli();
	if (!command) return { installed: false, enabled: false, available: false, published: false };
	const run = options.run ?? defaultTailscaleRunner;
	try {
		await run(command, [
			"serve",
			"--yes",
			...(options.settings.serviceName ? [`--service=svc:${options.settings.serviceName}`] : []),
			`--https=${options.settings.httpsPort}`,
			"off",
		]);
		return { installed: true, enabled: false, available: false, published: false };
	} catch (error) {
		return {
			installed: true,
			enabled: false,
			available: false,
			published: false,
			error: commandError(error),
		};
	}
}

/** Publish the localhost-only Pi server through tailnet-only Tailscale Serve. */
export async function ensureTailscaleServe(options: {
	settings: TailscaleWebSettings;
	localPort: number;
	command?: string;
	run?: TailscaleRunner;
	probe?: TailscaleProbe;
}): Promise<TailscaleStatus> {
	const command = options.command ?? await findTailscaleCli();
	if (!command) {
		return {
			installed: false,
			enabled: options.settings.enabled,
			available: false,
			published: false,
			error: options.settings.enabled ? "Tailscale is enabled for Pi web, but the Tailscale CLI is not installed." : undefined,
		};
	}
	if (!options.settings.enabled) {
		return { installed: true, enabled: false, available: false, published: false };
	}

	const run = options.run ?? defaultTailscaleRunner;
	try {
		const status = parseCliStatus((await run(command, ["status", "--json"])).stdout);
		if (status.BackendState !== "Running") {
			throw new Error(`Tailscale is not connected (state: ${String(status.BackendState ?? "unknown")})`);
		}
		const dnsName = typeof status.Self?.DNSName === "string" ? status.Self.DNSName : "";
		if (!dnsName) throw new Error("Tailscale did not report a MagicDNS name for this device");
		await run(command, [
			"serve",
			"--bg",
			"--yes",
			...(options.settings.serviceName ? [`--service=svc:${options.settings.serviceName}`] : []),
			`--https=${options.settings.httpsPort}`,
			`http://127.0.0.1:${options.localPort}`,
		]);
		const url = publishedUrl(dnsName, options.settings.httpsPort, options.settings.serviceName);
		const reachable = await (options.probe ?? probeTailscaleUrl)(url);
		if (!reachable) {
			throw new Error(options.settings.serviceName
				? `Tailscale Service svc:${options.settings.serviceName} is configured but not reachable. Approve its host advertisement and add an access grant in the Tailscale admin console.`
				: `Tailscale Serve configured ${url}, but its HTTPS endpoint is not reachable.`);
		}
		return {
			installed: true,
			enabled: true,
			available: true,
			published: true,
			url,
		};
	} catch (error) {
		return {
			installed: true,
			enabled: true,
			available: false,
			published: false,
			error: commandError(error),
		};
	}
}

function isSameServeRoute(left: TailscaleWebSettings, right: TailscaleWebSettings): boolean {
	return left.httpsPort === right.httpsPort && left.serviceName === right.serviceName;
}

/** Configure and verify a replacement route before removing the previously published route. */
export async function replaceTailscaleServe(options: {
	currentSettings: TailscaleWebSettings;
	nextSettings: TailscaleWebSettings;
	localPort: number;
	command?: string;
	run?: TailscaleRunner;
	probe?: TailscaleProbe;
}): Promise<TailscaleStatus> {
	const shared = {
		localPort: options.localPort,
		...(options.command ? { command: options.command } : {}),
		...(options.run ? { run: options.run } : {}),
	};
	const routeChanged = !isSameServeRoute(options.currentSettings, options.nextSettings);
	const status = await ensureTailscaleServe({
		...shared,
		settings: options.nextSettings,
		...(options.probe ? { probe: options.probe } : {}),
	});

	if (!status.published) {
		// A failed replacement can still leave `tailscale serve` configured. Do not
		// tear down an unchanged pre-existing route, but remove every new route.
		if (!options.currentSettings.enabled || routeChanged) {
			const cleanup = await disableTailscaleServe({ ...shared, settings: options.nextSettings });
			if (cleanup.error) {
				return { ...status, error: `${status.error ?? "Replacement route failed"}; replacement cleanup failed: ${cleanup.error}` };
			}
		}
		return status;
	}

	if (!options.currentSettings.enabled || !routeChanged) return status;
	const removed = await disableTailscaleServe({ ...shared, settings: options.currentSettings });
	if (!removed.error) return status;

	const cleanup = await disableTailscaleServe({ ...shared, settings: options.nextSettings });
	return {
		installed: status.installed,
		enabled: true,
		available: false,
		published: false,
		error: `Could not remove the previous Tailscale Serve route: ${removed.error}${cleanup.error ? `; replacement cleanup failed: ${cleanup.error}` : "; replacement route was removed"}`,
	};
}
