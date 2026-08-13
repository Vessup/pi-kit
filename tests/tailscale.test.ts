import { describe, expect, test } from "bun:test";
import { disableTailscaleServe, ensureTailscaleServe, parseTailscaleWebSettings, replaceTailscaleServe, type TailscaleRunner } from "../web/tailscale";

describe("Tailscale web publishing", () => {
	test("is opt-in and defaults to HTTPS 8443", () => {
		expect(parseTailscaleWebSettings({})).toEqual({ enabled: false, httpsPort: 8443, serviceName: undefined });
		expect(parseTailscaleWebSettings({ web: { tailscale: { enabled: true, httpsPort: 443, serviceName: "svc:pi-web" } } })).toEqual({
			enabled: true,
			httpsPort: 443,
			serviceName: "pi-web",
		});
	});

	test("publishes the localhost server with background Tailscale Serve", async () => {
		const calls: Array<{ command: string; args: readonly string[] }> = [];
		const run: TailscaleRunner = async (command, args) => {
			calls.push({ command, args });
			if (args[0] === "status") {
				return {
					stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "dev.tail123.ts.net." } }),
					stderr: "",
				};
			}
			return { stdout: "Available within your tailnet:\nhttps://dev.tail123.ts.net", stderr: "" };
		};
		const status = await ensureTailscaleServe({
			settings: { enabled: true, httpsPort: 443 },
			localPort: 31_415,
			command: "/mock/tailscale",
			run,
			probe: async () => true,
		});
		expect(status).toEqual({
			installed: true,
			enabled: true,
			available: true,
			published: true,
			url: "https://dev.tail123.ts.net/",
		});
		expect(calls).toEqual([
			{ command: "/mock/tailscale", args: ["status", "--json"] },
			{
				command: "/mock/tailscale",
				args: ["serve", "--bg", "--yes", "--https=443", "http://127.0.0.1:31415"],
			},
		]);
	});

	test("removes the configured Pi route immediately when disabled", async () => {
		const calls: string[][] = [];
		const status = await disableTailscaleServe({
			settings: { enabled: false, httpsPort: 443 },
			localPort: 31_415,
			command: "/mock/tailscale",
			run: async (_command, args) => {
				calls.push([...args]);
				return { stdout: "", stderr: "" };
			},
		});
		expect(status.published).toBe(false);
		expect(calls).toEqual([["serve", "--yes", "--https=443", "off"]]);
	});

	test("publishes a named service at its service MagicDNS name", async () => {
		const calls: string[][] = [];
		const status = await ensureTailscaleServe({
			settings: { enabled: true, httpsPort: 443, serviceName: "pi-web" },
			localPort: 31_415,
			command: "/mock/tailscale",
			probe: async () => true,
			run: async (_command, args) => {
				calls.push([...args]);
				return args[0] === "status"
					? { stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "dev.tail123.ts.net." } }), stderr: "" }
					: { stdout: "", stderr: "" };
			},
		});
		expect(status.url).toBe("https://pi-web.tail123.ts.net/");
		expect(calls[1]).toEqual(["serve", "--bg", "--yes", "--service=svc:pi-web", "--https=443", "http://127.0.0.1:31415"]);
	});

	test("replaces a previous Serve identity only after the new route is reachable", async () => {
		const calls: string[][] = [];
		const status = await replaceTailscaleServe({
			currentSettings: { enabled: true, httpsPort: 443 },
			nextSettings: { enabled: true, httpsPort: 443, serviceName: "pi-web" },
			localPort: 31_415,
			command: "/mock/tailscale",
			probe: async () => true,
			run: async (_command, args) => {
				calls.push([...args]);
				return args[0] === "status"
					? { stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "dev.tail123.ts.net." } }), stderr: "" }
					: { stdout: "", stderr: "" };
			},
		});
		expect(status.published).toBe(true);
		expect(calls).toEqual([
			["status", "--json"],
			["serve", "--bg", "--yes", "--service=svc:pi-web", "--https=443", "http://127.0.0.1:31415"],
			["serve", "--yes", "--https=443", "off"],
		]);
	});

	test("removes an unreachable replacement without removing the previous route", async () => {
		const calls: string[][] = [];
		const status = await replaceTailscaleServe({
			currentSettings: { enabled: true, httpsPort: 443 },
			nextSettings: { enabled: true, httpsPort: 443, serviceName: "pi-web" },
			localPort: 31_415,
			command: "/mock/tailscale",
			probe: async () => false,
			run: async (_command, args) => {
				calls.push([...args]);
				return args[0] === "status"
					? { stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "dev.tail123.ts.net." } }), stderr: "" }
					: { stdout: "", stderr: "" };
			},
		});
		expect(status.published).toBe(false);
		expect(calls.at(-1)).toEqual(["serve", "--yes", "--service=svc:pi-web", "--https=443", "off"]);
		expect(calls).not.toContainEqual(["serve", "--yes", "--https=443", "off"]);
	});

	test("does not claim publication until the HTTPS route is reachable", async () => {
		const status = await ensureTailscaleServe({
			settings: { enabled: true, httpsPort: 443 },
			localPort: 31_415,
			command: "/mock/tailscale",
			run: async (_command, args) => args[0] === "status"
				? { stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "dev.tail123.ts.net." } }), stderr: "" }
				: { stdout: "", stderr: "" },
			probe: async () => false,
		});
		expect(status.published).toBe(false);
		expect(status.error).toContain("not reachable");
	});

	test("reports disconnected Tailscale without preventing localhost startup", async () => {
		const status = await ensureTailscaleServe({
			settings: { enabled: true, httpsPort: 443 },
			localPort: 31_415,
			command: "/mock/tailscale",
			run: async () => ({ stdout: JSON.stringify({ BackendState: "Stopped" }), stderr: "" }),
		});
		expect(status.published).toBe(false);
		expect(status.error).toContain("not connected");
	});
});
