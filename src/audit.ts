import * as cheerio from "cheerio";
import { fetchPage, type FetchOptions, type FetchResult } from "./fetch.js";

export type Category = "performance" | "seo" | "design" | "functionality" | "technology";

export interface Finding {
  category: Category;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface AuditResult {
  url: string;
  finalUrl: string;
  status: number;
  scores: Record<Category, number> & { overall: number };
  findings: Finding[];
  detected: { cms: string | null; frameworks: string[]; server: string | null };
  metrics: { responseTimeMs: number; htmlBytes: number; truncated: boolean; redirects: number };
}

/** Category weights for the overall score. */
export const WEIGHTS: Record<Category, number> = {
  performance: 25, seo: 25, design: 20, functionality: 15, technology: 15,
};

const CMS: [string, RegExp][] = [
  ["WordPress", /wp-content|wp-includes|\/wp-json\//i],
  ["Joomla", /\/media\/jui\/|\/components\/com_/i],
  ["Drupal", /drupal\.js|\/sites\/default\//i],
  ["TYPO3", /typo3conf|typo3temp/i],
  ["Shopify", /cdn\.shopify\.com|myshopify\.com/i],
  ["Wix", /wix\.com|_wix_browser_sess/i],
  ["Squarespace", /squarespace\.com|sqsp\.net/i],
  ["Webflow", /webflow\.com|wf-page/i],
];
const FRAMEWORKS: [string, RegExp][] = [
  ["Next.js", /__NEXT_DATA__|\/_next\//],
  ["Nuxt", /__NUXT__|\/_nuxt\//],
  ["React", /react-dom|data-reactroot/i],
  ["Vue", /vue(\.min)?\.js|data-v-[0-9a-f]{6,}/i],
  ["Angular", /ng-version|angular(\.min)?\.js/i],
  ["Svelte", /__svelte|svelte-[a-z0-9]{5,}/i],
  ["jQuery", /jquery[.\-0-9]*(\.min)?\.js/i],
];

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function analyze(url: string, r: FetchResult): AuditResult {
  const $ = cheerio.load(r.body);
  const findings: Finding[] = [];
  const add = (category: Category, severity: Finding["severity"], message: string) =>
    findings.push({ category, severity, message });

  // performance
  let performance = 100;
  const ms = r.responseTimeMs;
  if (ms > 3000) { performance -= 45; add("performance", "error", `Response time ${ms} ms (over 3000 ms)`); }
  else if (ms > 1000) { performance -= 25; add("performance", "warning", `Response time ${ms} ms (over 1000 ms)`); }
  else add("performance", "info", `Response time ${ms} ms`);
  const kb = Math.round(r.bodyBytes / 1024);
  if (r.bodyBytes > 1024 * 1024) { performance -= 30; add("performance", "error", `HTML is ${kb} KB (over 1024 KB)`); }
  else if (r.bodyBytes > 300 * 1024) { performance -= 15; add("performance", "warning", `HTML is ${kb} KB (over 300 KB)`); }
  else add("performance", "info", `HTML is ${kb} KB`);
  if (!r.headers["content-encoding"] && r.bodyBytes > 10 * 1024) {
    performance -= 10; add("performance", "warning", "Response is not compressed (no Content-Encoding)");
  }
  const scripts = $("script[src]").length;
  if (scripts > 20) { performance -= 10; add("performance", "warning", `${scripts} external scripts`); }
  if (r.redirects > 1) { performance -= 5; add("performance", "warning", `${r.redirects} redirects before the final page`); }
  if (r.status >= 400) { performance -= 40; add("performance", "error", `HTTP status ${r.status}`); }

  // seo
  let seo = 100;
  const title = $("head title").first().text().trim();
  if (!title) { seo -= 25; add("seo", "error", "Missing <title>"); }
  else if (title.length < 10 || title.length > 70) { seo -= 8; add("seo", "warning", `Title length ${title.length} (recommended 10-70)`); }
  else add("seo", "info", `Title present (${title.length} characters)`);
  const desc = ($('meta[name="description"]').attr("content") ?? "").trim();
  if (!desc) { seo -= 20; add("seo", "error", "Missing meta description"); }
  else if (desc.length < 50 || desc.length > 170) { seo -= 6; add("seo", "warning", `Meta description length ${desc.length} (recommended 50-170)`); }
  const h1 = $("h1").length;
  if (h1 === 0) { seo -= 15; add("seo", "error", "No <h1>"); }
  else if (h1 > 1) { seo -= 6; add("seo", "warning", `${h1} <h1> elements`); }
  if (!$("html").attr("lang")) { seo -= 8; add("seo", "warning", "Missing lang attribute on <html>"); }
  if (!$('link[rel="canonical"]').attr("href")) { seo -= 5; add("seo", "info", "No canonical link"); }
  const imgs = $("img");
  const noAlt = imgs.filter((_, e) => $(e).attr("alt") === undefined).length;
  if (imgs.length > 0 && noAlt > 0) {
    seo -= Math.min(15, Math.round((noAlt / imgs.length) * 15));
    add("seo", "warning", `${noAlt} of ${imgs.length} images have no alt attribute`);
  }
  if (/noindex/i.test($('meta[name="robots"]').attr("content") ?? "")) { seo -= 20; add("seo", "warning", "Page is marked noindex"); }

  // design
  let design = 100;
  const viewport = $('meta[name="viewport"]').attr("content");
  if (!viewport) { design -= 35; add("design", "error", "Missing viewport meta tag"); }
  else if (!/width\s*=\s*device-width/i.test(viewport)) { design -= 15; add("design", "warning", "Viewport does not use width=device-width"); }
  else add("design", "info", "Viewport meta tag present");
  if (!$('link[rel~="icon"]').length) { design -= 8; add("design", "info", "No favicon link"); }
  const legacy = $("font, center, marquee, blink").length;
  if (legacy > 0) { design -= 20; add("design", "warning", `${legacy} deprecated presentational elements`); }
  if (!$('meta[charset], meta[http-equiv="Content-Type"]').length) { design -= 5; add("design", "info", "No charset declaration"); }
  const inline = $("[style]").length;
  if (inline > 50) { design -= 10; add("design", "warning", `${inline} elements with inline styles`); }
  const tables = $("table").length;
  if (tables > 5) { design -= 8; add("design", "info", `${tables} tables (possible table layout)`); }

  // functionality
  let functionality = 100;
  const links = $("a[href]").length;
  if (links === 0) { functionality -= 25; add("functionality", "warning", "No links on the page"); }
  const emptyLinks = $("a[href]").filter((_, e) => {
    const h = ($(e).attr("href") ?? "").trim();
    return h === "" || h === "#" || /^javascript:/i.test(h);
  }).length;
  if (emptyLinks > 3) { functionality -= 10; add("functionality", "warning", `${emptyLinks} links with empty or javascript: targets`); }
  const forms = $("form").length;
  if (forms > 0) {
    const unlabeled = $("input:not([type=hidden]):not([type=submit]):not([type=button])").filter((_, e) => {
      const id = $(e).attr("id");
      return !($(e).attr("aria-label") || $(e).attr("placeholder") || $(e).closest("label").length || (id && $(`label[for="${id}"]`).length));
    }).length;
    if (unlabeled > 0) { functionality -= 10; add("functionality", "warning", `${unlabeled} form inputs without a label`); }
    else add("functionality", "info", `${forms} form(s), inputs labeled`);
  }
  if (r.status >= 400) { functionality -= 40; add("functionality", "error", `HTTP status ${r.status}`); }
  if (r.truncated) { functionality -= 5; add("functionality", "info", "HTML exceeded the size cap and was truncated"); }

  // technology
  let technology = 100;
  const cms = CMS.find(([, re]) => re.test(r.body))?.[0] ?? null;
  const frameworks = FRAMEWORKS.filter(([, re]) => re.test(r.body)).map(([n]) => n);
  const server = (r.headers["server"] as string | undefined) ?? null;
  const https = r.finalUrl.startsWith("https:");
  if (!https) { technology -= 40; add("technology", "error", "Page is served over plain HTTP"); }
  else {
    if (r.tls) {
      if (!r.tls.valid) { technology -= 40; add("technology", "error", "TLS certificate did not validate"); }
      else if (r.tls.daysUntilExpiry !== null && r.tls.daysUntilExpiry < 14) { technology -= 15; add("technology", "warning", `TLS certificate expires in ${r.tls.daysUntilExpiry} days`); }
      else add("technology", "info", `TLS valid (${r.tls.protocol}), ${r.tls.daysUntilExpiry} days until expiry`);
    }
    if (!r.headers["strict-transport-security"]) { technology -= 8; add("technology", "warning", "No Strict-Transport-Security header"); }
  }
  if (!r.headers["x-content-type-options"]) { technology -= 4; add("technology", "info", "No X-Content-Type-Options header"); }
  if (!r.headers["content-security-policy"]) { technology -= 4; add("technology", "info", "No Content-Security-Policy header"); }
  if (/\/\d/.test(server ?? "") || r.headers["x-powered-by"]) { technology -= 6; add("technology", "info", "Server version is disclosed in response headers"); }
  if (cms) add("technology", "info", `Detected CMS: ${cms}`);
  if (frameworks.length) add("technology", "info", `Detected libraries: ${frameworks.join(", ")}`);
  const gen = $('meta[name="generator"]').attr("content");
  if (gen && /\d+\.\d+/.test(gen)) { technology -= 4; add("technology", "info", `Generator tag discloses version: ${gen}`); }

  const scores = {
    performance: clamp(performance), seo: clamp(seo), design: clamp(design),
    functionality: clamp(functionality), technology: clamp(technology),
  };
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const overall = clamp(
    (Object.keys(WEIGHTS) as Category[]).reduce((s, k) => s + scores[k] * WEIGHTS[k], 0) / total,
  );
  return {
    url, finalUrl: r.finalUrl, status: r.status,
    scores: { ...scores, overall },
    findings,
    detected: { cms, frameworks, server },
    metrics: { responseTimeMs: ms, htmlBytes: r.bodyBytes, truncated: r.truncated, redirects: r.redirects },
  };
}

export async function auditWebsite(url: string, opts: FetchOptions = {}): Promise<AuditResult> {
  return analyze(url, await fetchPage(url, opts));
}

export interface Comparison {
  ranked: { rank: number; url: string; overall: number; scores: AuditResult["scores"] }[];
  errors: { url: string; error: string }[];
}

export async function compareWebsites(urls: string[], opts: FetchOptions = {}): Promise<Comparison> {
  const settled = await Promise.all(
    urls.map(async (u) => {
      try { return { u, r: await auditWebsite(u, opts) }; }
      catch (e) { return { u, e: e instanceof Error ? e.message : String(e) }; }
    }),
  );
  const ok = settled.filter((s): s is { u: string; r: AuditResult } => "r" in s);
  ok.sort((a, b) => b.r.scores.overall - a.r.scores.overall);
  return {
    ranked: ok.map((s, i) => ({ rank: i + 1, url: s.u, overall: s.r.scores.overall, scores: s.r.scores })),
    errors: settled.filter((s): s is { u: string; e: string } => "e" in s).map((s) => ({ url: s.u, error: s.e })),
  };
}
