import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, expect, it } from "vitest";

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
let fixture: http.Server;
let base: string;
let client: Client;

beforeAll(async () => {
  fixture = http.createServer((_q, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture page title</title><meta name="viewport" content="width=device-width"></head><body><h1>Hi</h1></body></html>');
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...(process.env as Record<string, string>), WEBSITE_AUDIT_ALLOW_PRIVATE: "1" },
    }),
  );
});
afterAll(async () => {
  await client.close();
  await new Promise<void>((r) => fixture.close(() => r()));
});

it("lists both tools over stdio", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["audit_website", "compare_websites"]);
});

it("audit_website returns a score for the fixture server", async () => {
  const res = await client.callTool({ name: "audit_website", arguments: { url: base } });
  const out = JSON.parse((res.content as { text: string }[])[0].text);
  expect(out.status).toBe(200);
  expect(out.scores.overall).toBeGreaterThan(0);
  expect(out.scores.overall).toBeLessThanOrEqual(100);
});

it("compare_websites ranks the fixture", async () => {
  const res = await client.callTool({ name: "compare_websites", arguments: { urls: [base, base + "x"] } });
  const out = JSON.parse((res.content as { text: string }[])[0].text);
  expect(out.ranked).toHaveLength(2);
});

it("returns an error result for a refused URL", async () => {
  const res = await client.callTool({ name: "audit_website", arguments: { url: "file:///etc/passwd" } });
  expect(res.isError).toBe(true);
});
