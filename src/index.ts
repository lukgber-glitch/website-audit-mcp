#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { auditWebsite, compareWebsites } from "./audit.js";

// Set WEBSITE_AUDIT_ALLOW_PRIVATE=1 only for local testing.
const opts = { allowPrivateHosts: process.env.WEBSITE_AUDIT_ALLOW_PRIVATE === "1" };

const server = new McpServer({ name: "website-audit-mcp", version: "0.1.0" });

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});

server.registerTool(
  "audit_website",
  {
    description:
      "Fetch one http/https URL and score it 0-100 for performance, SEO, design, functionality and technology, with findings.",
    inputSchema: { url: z.string().describe("http or https URL of the page to audit") },
  },
  async ({ url }) => {
    try { return text(await auditWebsite(url, opts)); } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "compare_websites",
  {
    description: "Audit 2 to 10 URLs and return them ranked by overall score, best first.",
    inputSchema: { urls: z.array(z.string()).min(2).max(10).describe("http or https URLs") },
  },
  async ({ urls }) => {
    try { return text(await compareWebsites(urls, opts)); } catch (e) { return fail(e); }
  },
);

await server.connect(new StdioServerTransport());
