import { expect, test } from "bun:test";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

test("Staff Review Informant job uses trusted review resources", async () => {
  const source = await Bun.file(
    join(repositoryRoot, ".informant/jobs/staffReview.toml"),
  ).text();
  const job = Bun.TOML.parse(source) as {
    name: string;
    command: string;
    optional: boolean;
    timeout_minutes: number;
    runs_on: string[];
    secrets: string[];
    mounts: Array<{ source: string; target: string; write_back: boolean }>;
    environment: Record<string, string>;
    triggers: unknown[];
    container: {
      prepare: string;
      prepareInputs: string[];
      trustedPrepareInputs: boolean;
    };
  };

  expect(job.name).toBe("Staff Review");
  expect(job.optional).toBe(true);
  expect(job.timeout_minutes).toBe(60);
  expect(job.triggers).toHaveLength(1);
  expect(job.command).toContain("pi --print");
  expect(job.command).toContain("pi install npm:@vessup/pi-kit@0.1.2");
  expect(job.command).toContain(
    'pi_kit_subagents="$review_agent_dir/npm/node_modules/@vessup/pi-kit/extensions/subagents.ts"',
  );
  expect(job.command).not.toContain("$review_root/extensions/subagents.ts");
  expect(job.runs_on).toContain("mount:pi-auth");
  expect(job.secrets).toEqual(["GITHUB_TOKEN"]);
  expect(job.mounts).toEqual([
    {
      source: "pi-auth",
      target: "/mnt/informant-pi",
      write_back: false,
    },
  ]);
  expect(job.command).toContain("runuser -u reviewer");
  expect(job.command).not.toContain("staff-review-findings.json");
  expect(job.container.trustedPrepareInputs).toBe(true);
  expect(job.container.prepareInputs).toEqual([
    ".agents/skills/staff-review/**",
    ".agents/skills/staff-review-find/**",
    ".agents/skills/staff-review-verify/**",
    ".agents/skills/staff-comment/**",
  ]);
  expect(job.container.prepare).toContain("sha256sum -c -");
  expect(job.container.prepare).toContain(
    "sed -i 's#[.]agents/skills/#/opt/informant/skills/#g'",
  );
  expect(job.container.prepare).toContain(
    "@earendil-works/pi-coding-agent@0.84.1",
  );
});
