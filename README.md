# website-audit-mcp

An MCP server (stdio) that fetches a web page over HTTP and scores it in five categories: performance, SEO, design, functionality and technology. It uses plain HTTP requests and cheerio. It needs no browser, no database and no API key.

## What it checks

| Category | Checks (weight in overall score) |
|---|---|
| performance (25) | response time, HTML size, compression header, number of external scripts, redirects, HTTP status |
| seo (25) | title, meta description, `<h1>` count, `lang` attribute, canonical link, image alt text, noindex |
| design (20) | viewport meta tag, favicon link, deprecated presentational elements, charset, inline styles, table count |
| functionality (15) | links present, empty or `javascript:` links, unlabeled form inputs, HTTP status |
| technology (15) | HTTPS, TLS validity and expiry, security headers, server version disclosure, CMS and library detection |

Scores are 0-100. The overall score is the weighted average. Only the HTML document is analyzed; linked assets are not downloaded and JavaScript is not executed, so pages rendered client-side are scored on their initial HTML.

## Input limits

- Only `http:` and `https:` URLs. URLs with embedded credentials are refused.
- Hosts that resolve to loopback, private, link-local or otherwise reserved addresses are refused. Every redirect target is checked again, and the connection uses the validated address.
- 10 s timeout, 2 MB body cap (the body is truncated and reported as `truncated`), at most 5 redirects.
- `compare_websites` takes 2 to 10 URLs.

## Install

```sh
git clone <this repository>
cd website-audit-mcp
npm install
npm run build
```

Requires Node.js 18 or newer.

## Configure

Claude Code:

```sh
claude mcp add website-audit -- node /absolute/path/to/website-audit-mcp/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "website-audit": {
      "command": "node",
      "args": ["/absolute/path/to/website-audit-mcp/dist/index.js"]
    }
  }
}
```

Setting `WEBSITE_AUDIT_ALLOW_PRIVATE=1` disables the private-host check. It exists for the test suite and should not be set otherwise.

## Tools

### `audit_website`

Input:

```json
{ "url": "string (http or https URL)" }
```

Output (JSON text): `url`, `finalUrl`, `status`, `scores` (`performance`, `seo`, `design`, `functionality`, `technology`, `overall`), `findings[]` (`category`, `severity` of `info|warning|error`, `message`), `detected` (`cms`, `frameworks`, `server`), `metrics` (`responseTimeMs`, `htmlBytes`, `truncated`, `redirects`).

### `compare_websites`

Input:

```json
{ "urls": ["string", "string"] }
```

Output (JSON text): `ranked[]` (`rank`, `url`, `overall`, `scores`) sorted by overall score, highest first, and `errors[]` (`url`, `error`) for URLs that were refused or failed.

Invalid input returns a tool result with `isError: true` and a message.

## Example

`audit_website` with `{"url": "https://example.com"}` (findings shortened):

```json
{
  "url": "https://example.com",
  "finalUrl": "https://example.com/",
  "status": 200,
  "scores": { "performance": 100, "seo": 60, "design": 100, "functionality": 75, "technology": 84, "overall": 84 },
  "findings": [
    { "category": "performance", "severity": "info", "message": "Response time 67 ms" },
    { "category": "seo", "severity": "error", "message": "Missing meta description" },
    { "category": "seo", "severity": "error", "message": "No <h1>" },
    { "category": "functionality", "severity": "warning", "message": "No links on the page" },
    { "category": "technology", "severity": "info", "message": "TLS valid (TLSv1.3), 55 days until expiry" },
    { "category": "technology", "severity": "warning", "message": "No Strict-Transport-Security header" }
  ],
  "detected": { "cms": null, "frameworks": [], "server": "cloudflare" },
  "metrics": { "responseTimeMs": 67, "htmlBytes": 577, "truncated": false, "redirects": 0 }
}
```

## Development

```sh
npm test          # builds, then runs unit tests and the stdio end-to-end test
npx tsc --noEmit  # type check
```

The tests use a local HTTP server as a fixture. The end-to-end test starts the built server over stdio and talks to it with the SDK client.

## Limitations

- The scoring rules are fixed heuristics, not measurements from a browser. They do not replace Lighthouse.
- Only the single URL given is fetched. No other pages of the site are crawled.

## License

MIT, see `LICENSE`.
