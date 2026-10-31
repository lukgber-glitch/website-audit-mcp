import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { TLSSocket } from "node:tls";

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowPrivateHosts?: boolean;
}

export interface FetchResult {
  finalUrl: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  bodyBytes: number;
  truncated: boolean;
  responseTimeMs: number;
  redirects: number;
  tls: { valid: boolean; daysUntilExpiry: number | null; protocol: string | null } | null;
}

export class AuditInputError extends Error {}

export function isPrivateAddress(addr: string): boolean {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (net.isIPv6(addr)) {
    const l = addr.toLowerCase();
    if (l === "::" || l === "::1") return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true;
}

/** Parse and validate a user supplied URL. Throws AuditInputError. */
export function parseUrl(input: string): URL {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new AuditInputError(`Invalid URL: ${input}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new AuditInputError(`Only http and https URLs are allowed (got ${u.protocol})`);
  }
  if (u.username || u.password) throw new AuditInputError("URLs with credentials are not allowed");
  return u;
}

async function resolveHost(u: URL, allowPrivate: boolean): Promise<string> {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && (host === "localhost" || host.endsWith(".localhost"))) {
    throw new AuditInputError(`Refusing private or loopback host: ${host}`);
  }
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.length === 0) throw new AuditInputError(`Cannot resolve host: ${host}`);
  if (!allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) {
    throw new AuditInputError(`Refusing private or loopback host: ${host}`);
  }
  return addrs[0].address;
}

type Once = Omit<FetchResult, "redirects" | "finalUrl"> & { location?: string };

function once(u: URL, address: string, timeoutMs: number, maxBytes: number): Promise<Once> {
  return new Promise<Once>((resolve, reject) => {
    const start = Date.now();
    const lib = u.protocol === "https:" ? https : http;
    let settled = false;
    const req = lib.request(
      u,
      {
        method: "GET",
        timeout: timeoutMs,
        headers: { "user-agent": "website-audit-mcp/0.1", accept: "text/html,*/*;q=0.8" },
        // Connect to the address that was validated, not a second DNS answer.
        lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          const family = net.isIPv6(address) ? 6 : 4;
          if (o && o.all) cb(null, [{ address, family }]);
          else cb(null, address, family);
        }) as never,
      },
      (res) => {
        const responseTimeMs = Date.now() - start;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let tls: FetchResult["tls"] = null;
        if (u.protocol === "https:") {
          const sock = res.socket as TLSSocket;
          const cert = sock.getPeerCertificate();
          const exp = cert && cert.valid_to ? Date.parse(cert.valid_to) : NaN;
          tls = {
            valid: sock.authorized,
            daysUntilExpiry: Number.isNaN(exp) ? null : Math.floor((exp - Date.now()) / 86400000),
            protocol: sock.getProtocol(),
          };
        }
        res.on("data", (c: Buffer) => {
          if (truncated) return;
          if (size + c.length > maxBytes) {
            chunks.push(c.subarray(0, maxBytes - size));
            size = maxBytes;
            truncated = true;
            req.destroy();
            return;
          }
          size += c.length;
          chunks.push(c);
        });
        const done = () => {
          if (settled) return;
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            bodyBytes: size,
            truncated,
            responseTimeMs,
            tls,
            location: res.headers.location,
          });
        };
        res.on("end", done);
        res.on("close", done);
        res.on("error", (e) => (truncated ? done() : reject(e)));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms`)));
    req.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    req.end();
  });
}

export async function fetchPage(input: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;
  let u = parseUrl(input);
  let redirects = 0;
  for (;;) {
    const address = await resolveHost(u, opts.allowPrivateHosts ?? false);
    const r = await once(u, address, timeoutMs, maxBytes);
    if (r.status >= 300 && r.status < 400 && r.location) {
      if (++redirects > maxRedirects) throw new AuditInputError("Too many redirects");
      u = parseUrl(new URL(r.location, u).toString()); // re-validated on the next loop
      continue;
    }
    const { location: _l, ...rest } = r;
    return { ...rest, finalUrl: u.toString(), redirects };
  }
}
