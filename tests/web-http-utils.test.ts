import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonResponse } from "../web/server/http-utils";
import { createStaticAssetResponder } from "../web/server/static-assets";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("JSON responses preserve every HeadersInit representation", () => {
  const fromHeaders = jsonResponse(
    {},
    { headers: new Headers({ "x-test": "headers" }) },
  );
  expect(fromHeaders.headers.get("x-test")).toBe("headers");
  expect(fromHeaders.headers.get("content-type")).toBe(
    "application/json; charset=utf-8",
  );

  const fromEntries = jsonResponse(
    {},
    {
      headers: [
        ["x-test", "entries"],
        ["content-type", "application/problem+json"],
      ],
    },
  );
  expect(fromEntries.headers.get("x-test")).toBe("entries");
  expect(fromEntries.headers.get("content-type")).toBe(
    "application/problem+json",
  );
});

test("static assets reject malformed paths and never serve directories", async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-kit-static-assets-"));
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "app shell");
  const respond = createStaticAssetResponder(directory);

  expect(respond(new Request("http://localhost/%"))?.status).toBe(400);
  expect(respond(new Request("http://localhost/%zz"))?.status).toBe(400);
  const directoryResponse = respond(new Request("http://localhost/assets"));
  expect(directoryResponse?.status).toBe(200);
  expect(await directoryResponse?.text()).toBe("app shell");
  expect(directoryResponse?.headers.get("cache-control")).toBe("no-cache");
});
