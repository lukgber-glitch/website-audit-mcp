import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze, auditWebsite, compareWebsites } from "../src/audit.js";
import { fetchPage, isPrivateAddress, parseUrl } from "../src/fetch.js";

const GOOD = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>A well formed page title</title>
<meta name="description" content="A description that is long enough to be inside the recommended range for search snippets.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="/"><link rel="icon" href="/f.ico"></head>
<body><h1>Hello</h1><img src="a.png" alt="a"><a href="/x">x</a>
<script src="/wp-content/x.js"></script></body></html>`;
const BAD = `<html><head></head><body><font>old</font><img src="a.png"><img src="b.png"></body></html>`;

let server: http.Server;
let base: string;
const opts = { allowPrivateHosts: true };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/good") { res.setHeader("content-type", "text/html"); res.end(GOOD); }
    else if (path === "/bad") { res.setHeader("content-type", "text/html"); res.end(BAD); }
    else if (path === "/redir") { res.statusCode = 302; res.setHeader("location", "/good"); res.end(); }
    else if (path === "/loop") { res.statusCode = 302; res.setHeader("location", "/loop"); res.end(); }
    else if (path === "/big") { res.end("x".repeat(5000)); }
    else if (path === "/slow") { setTimeout(() => res.end("late"), 2000); }
    else if (path === "/missing") { res.statusCode = 404; res.end("nope"); }
    else res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("checks", () => {
  it("scores a well formed page highly and detects the CMS", async () => {
    const r = await auditWebsite(`${base}/good`, opts);
    expect(r.scores.seo).toBe(100);
    expect(r.scores.design).toBe(100);
    expect(r.detected.cms).toBe("WordPress");
    expect(r.scores.overall).toBeGreaterThan(80);
  });

  it("reports missing title, description, h1, viewport and alt text", async () => {
    const r = await auditWebsite(`${base}/bad`, opts);
    const msgs = r.findings.map((f) => f.message).join("\n");
    expect(msgs).toMatch(/Missing <title>/);
    expect(msgs).toMatch(/Missing meta description/);
    expect(msgs).toMatch(/No <h1>/);
    expect(msgs).toMatch(/Missing viewport/);
    expect(msgs).toMatch(/2 of 2 images have no alt/);
    expect(r.scores.seo).toBeLessThan(60);
  });

  it("flags plain HTTP as a technology error", async () => {
    const r = await auditWebsite(`${base}/good`, opts);
    expect(r.findings.some((f) => f.category === "technology" && f.severity === "error")).toBe(true);
  });

  it("follows redirects and counts them", async () => {
    const r = await fetchPage(`${base}/redir`, opts);
    expect(r.finalUrl).toBe(`${base}/good`);
    expect(r.redirects).toBe(1);
  });

  it("stops redirect loops", async () => {
    await expect(fetchPage(`${base}/loop`, opts)).rejects.toThrow(/Too many redirects/);
  });

  it("caps the body size", async () => {
    const r = await fetchPage(`${base}/big`, { ...opts, maxBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.bodyBytes).toBe(1000);
  });

  it("times out slow servers", async () => {
    await expect(fetchPage(`${base}/slow`, { ...opts, timeoutMs: 300 })).rejects.toThrow(/timed out/i);
  });

  it("lowers scores for HTTP error status", async () => {
    const r = await auditWebsite(`${base}/missing`, opts);
    expect(r.status).toBe(404);
    expect(r.scores.functionality).toBeLessThanOrEqual(60);
  });

  it("ranks compared sites best first and reports failures", async () => {
    const c = await compareWebsites([`${base}/bad`, `${base}/good`, "ftp://example.com"], opts);
    expect(c.ranked.map((x) => x.url)).toEqual([`${base}/good`, `${base}/bad`]);
    expect(c.ranked[0].rank).toBe(1);
    expect(c.errors).toHaveLength(1);
  });

  it("analyze is pure over a fetch result", () => {
    const r = analyze("http://x", {
      finalUrl: "https://x/", status: 200, headers: {}, body: GOOD, bodyBytes: GOOD.length,
      truncated: false, responseTimeMs: 50, redirects: 0,
      tls: { valid: true, daysUntilExpiry: 90, protocol: "TLSv1.3" },
    });
    expect(r.findings.some((f) => /TLS valid/.test(f.message))).toBe(true);
  });
});

describe("input validation", () => {
  it("rejects non-http schemes and malformed URLs", () => {
    for (const u of ["ftp://a.com", "file:///etc/passwd", "javascript:alert(1)", "not a url", ""]) {
      expect(() => parseUrl(u)).toThrow();
    }
  });

  it("rejects credentials in URLs", () => {
    expect(() => parseUrl("http://user:pw@example.com")).toThrow(/credentials/);
  });

  it("classifies private and loopback addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) expect(isPrivateAddress(a), a).toBe(false);
  });

  it("refuses loopback hosts by default", async () => {
    await expect(fetchPage(`${base}/good`)).rejects.toThrow(/private or loopback/);
    await expect(fetchPage("http://localhost:1/")).rejects.toThrow(/private or loopback/);
    await expect(fetchPage("http://[::1]:1/")).rejects.toThrow(/private or loopback/);
  });
});
