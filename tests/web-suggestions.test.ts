import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerStateFile } from "../web/protocol.ts";
import { listDirectorySuggestions } from "../web/server/suggestions.ts";
import { listRepositoryBranches } from "../web/server/worktrees.ts";

let child: Bun.Subprocess | undefined;
let tempDir: string | undefined;

afterEach(async () => {
  if (child) {
    child.kill("SIGTERM");
    await child.exited.catch(() => undefined);
    child = undefined;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

test("directory suggestions list home directories in ~ shorthand", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-suggestions-"));
  const home = join(tempDir, "home");
  for (const directory of ["alpha", "beta", "vessup", ".cache"]) {
    await mkdir(join(home, directory), { recursive: true });
  }
  await writeFile(join(home, "notes.txt"), "not a directory\n");

  const visible = listDirectorySuggestions("", { homeDir: home });
  expect(visible).toEqual(["~/alpha", "~/beta", "~/vessup"]);

  expect(listDirectorySuggestions("~", { homeDir: home })).toEqual(visible);
  expect(listDirectorySuggestions("~/", { homeDir: home })).toEqual(visible);

  expect(listDirectorySuggestions("~/ve", { homeDir: home })).toEqual([
    "~/vessup",
  ]);
  // Without a trailing slash the last segment stays a prefix filter, so a
  // complete directory name suggests itself rather than its children.
  expect(listDirectorySuggestions("~/vessup", { homeDir: home })).toEqual([
    "~/vessup",
  ]);
  expect(listDirectorySuggestions("~/vessup/", { homeDir: home })).toEqual([]);
  expect(listDirectorySuggestions("~/miss", { homeDir: home })).toEqual([]);

  // Hidden directories only appear when the prefix itself is hidden.
  expect(listDirectorySuggestions("~/.ca", { homeDir: home })).toEqual([
    "~/.cache",
  ]);
});

test("directory suggestions stop inside a Git repository", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-suggestions-repo-"));
  const home = join(tempDir, "home");
  await mkdir(join(home, "plain"), { recursive: true });
  const repository = join(home, "project");
  await Bun.$`git init -q -b main ${repository}`;

  // The repository itself still completes from its parent directory...
  expect(listDirectorySuggestions("~/pro", { homeDir: home })).toEqual([
    "~/project",
  ]);
  // ...but nothing beneath it is suggested.
  expect(listDirectorySuggestions("~/project/", { homeDir: home })).toEqual([]);
  expect(listDirectorySuggestions("~/project/s", { homeDir: home })).toEqual(
    [],
  );
  expect(listDirectorySuggestions("~/plain", { homeDir: home })).toEqual([
    "~/plain",
  ]);
});

test("directory suggestions keep absolute form outside home", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-suggestions-"));
  const home = join(tempDir, "home");
  const elsewhere = join(tempDir, "elsewhere");
  await mkdir(join(home, "inside"), { recursive: true });
  await mkdir(join(elsewhere, "project"), { recursive: true });

  expect(
    listDirectorySuggestions(`${elsewhere}/pro`, {
      baseDir: tempDir,
      homeDir: home,
    }),
  ).toEqual([join(elsewhere, "project")]);
  expect(
    listDirectorySuggestions(`${elsewhere}/`, {
      baseDir: tempDir,
      homeDir: home,
    }),
  ).toEqual([join(elsewhere, "project")]);
});

test("repository branches list local and remote refs", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-branches-"));
  const repository = join(tempDir, "project");
  await Bun.$`git init -q -b main ${repository}`;
  await Bun.$`git -C ${repository} config user.name test`;
  await Bun.$`git -C ${repository} config user.email test@example.com`;
  await Bun.write(join(repository, "README.md"), "test\n");
  await Bun.$`git -C ${repository} add README.md`;
  await Bun.$`git -C ${repository} commit -qm initial`;
  await Bun.$`git -C ${repository} branch owner/topic`;
  await Bun.$`git -C ${repository} update-ref refs/remotes/origin/feature-x refs/heads/main`;
  await Bun.$`git -C ${repository} symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`;

  const branches = listRepositoryBranches(repository);
  expect(branches.local).toEqual(["main", "owner/topic"]);
  expect(branches.remote).toEqual(["origin/feature-x"]);
});

test("branch listing fails outside a Git repository", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-branches-"));
  expect(() => listRepositoryBranches(tempDir)).toThrow();
});

test("web server serves directory and branch suggestions", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-kit-suggestions-http-"));
  const home = join(tempDir, "home");
  await mkdir(join(home, "vessup"), { recursive: true });
  const repository = join(tempDir, "project");
  await Bun.$`git init -q -b main ${repository}`;
  await Bun.$`git -C ${repository} config user.name test`;
  await Bun.$`git -C ${repository} config user.email test@example.com`;
  await Bun.write(join(repository, "README.md"), "test\n");
  await Bun.$`git -C ${repository} add README.md`;
  await Bun.$`git -C ${repository} commit -qm initial`;
  await Bun.$`git -C ${repository} branch feature`;

  const statePath = join(tempDir, "server.json");
  child = Bun.spawn({
    cmd: ["bun", "run", "web/server/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      PI_WEB_PORT: "0",
      PI_WEB_ROOT: process.cwd(),
      PI_WEB_STATE_FILE: statePath,
      PI_CODING_AGENT_DIR: join(tempDir, "pi-agent"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 8_000;
  let state: ServerStateFile | undefined;
  while (Date.now() < deadline) {
    try {
      state = JSON.parse(await Bun.file(statePath).text()) as ServerStateFile;
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
  if (!state) throw new Error("web server state file was not created");

  const directoryResponse = await fetch(
    `http://127.0.0.1:${state.port}/api/directories?q=${encodeURIComponent(`${home}/`)}`,
  );
  expect(directoryResponse.ok).toBe(true);
  const directories = (await directoryResponse.json()) as {
    directories: string[];
  };
  // Paths under the server's home render with the ~ shorthand. Server startup
  // can create ~/Library inside the fake home, so assert containment.
  expect(directories.directories).toContain("~/vessup");

  const prefixResponse = await fetch(
    `http://127.0.0.1:${state.port}/api/directories?q=${encodeURIComponent(`${home}/ves`)}`,
  );
  expect(
    ((await prefixResponse.json()) as { directories: string[] }).directories,
  ).toEqual(["~/vessup"]);

  const branchResponse = await fetch(
    `http://127.0.0.1:${state.port}/api/branches?cwd=${encodeURIComponent(repository)}`,
  );
  expect(branchResponse.ok).toBe(true);
  const branches = (await branchResponse.json()) as {
    local: string[];
    remote: string[];
  };
  expect(branches.local).toEqual(["feature", "main"]);
  expect(branches.remote).toEqual([]);

  const missingResponse = await fetch(
    `http://127.0.0.1:${state.port}/api/branches`,
  );
  expect(missingResponse.status).toBe(400);

  const plainDirectoryResponse = await fetch(
    `http://127.0.0.1:${state.port}/api/branches?cwd=${encodeURIComponent(home)}`,
  );
  expect(plainDirectoryResponse.ok).toBe(true);
  expect(
    ((await plainDirectoryResponse.json()) as { local: string[] }).local,
  ).toEqual([]);
});
