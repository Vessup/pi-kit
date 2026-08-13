import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWebTailscaleSettingFile } from "../extensions/web-settings.ts";

let directory: string | undefined;

afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

async function settingsPath(): Promise<string> {
	directory = await mkdtemp(join(tmpdir(), "pi-kit-web-settings-"));
	return join(directory, "settings.json");
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test("web settings writes preserve unrelated Pi and extension keys", async () => {
	const path = await settingsPath();
	await writeFile(path, JSON.stringify({ theme: "dark", web: { other: { enabled: true } }, packageSetting: 42 }));
	await writeWebTailscaleSettingFile(path, { enabled: true, httpsPort: 443, serviceName: "svc:pi-web" });
	expect(await readSettings(path)).toEqual({
		theme: "dark",
		web: { other: { enabled: true }, tailscale: { enabled: true, httpsPort: 443, serviceName: "pi-web" } },
		packageSetting: 42,
	});
});

test("concurrent web settings updates remain valid and retain unrelated keys", async () => {
	const path = await settingsPath();
	await writeFile(path, JSON.stringify({ theme: "light", web: { other: "retained" } }));
	await Promise.all([
		writeWebTailscaleSettingFile(path, { enabled: true, httpsPort: 8443, serviceName: "first" }),
		writeWebTailscaleSettingFile(path, { enabled: false, httpsPort: 9443, serviceName: "second" }),
	]);
	const result = await readSettings(path) as { theme?: string; web?: { other?: string; tailscale?: { httpsPort?: number } } };
	expect(result.theme).toBe("light");
	expect(result.web?.other).toBe("retained");
	expect([8443, 9443]).toContain(result.web?.tailscale?.httpsPort);
});

test("malformed settings reject without leaking the cross-process lock", async () => {
	const path = await settingsPath();
	await writeFile(path, "{broken");
	await expect(writeWebTailscaleSettingFile(path, { enabled: true, httpsPort: 443 })).rejects.toThrow("Could not read");
	await writeFile(path, JSON.stringify({ recovered: true }));
	await writeWebTailscaleSettingFile(path, { enabled: false, httpsPort: 8443 });
	expect(await readSettings(path)).toEqual({ recovered: true, web: { tailscale: { enabled: false, httpsPort: 8443 } } });
});

test("write and rename failures clean temporary files and always release the lock", async () => {
	const path = await settingsPath();
	let releases = 0;
	const lock = async () => async () => { releases += 1; };
	await expect(writeWebTailscaleSettingFile(path, { enabled: true, httpsPort: 443 }, {
		lock,
		writeFile: async () => { throw new Error("write failed"); },
		randomUUID: () => "write-failure",
	})).rejects.toThrow("write failed");
	expect(releases).toBe(1);
	expect((await readdir(directory!)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

	await expect(writeWebTailscaleSettingFile(path, { enabled: true, httpsPort: 443 }, {
		lock,
		rename: async () => { throw new Error("rename failed"); },
		randomUUID: () => "rename-failure",
	})).rejects.toThrow("rename failed");
	expect(releases).toBe(2);
	expect((await readdir(directory!)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
