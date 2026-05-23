## Usage data — how it works

Claude's usage API is behind Cloudflare TLS fingerprinting. Plain Node.js HTTP, curl, and unauthenticated fetch all get 403. The CLI's `rate_limit_event` no longer carries `usage_fraction` (removed in v2.1.86+).

**The working solution**: `apps/server/src/services/usage-scraper.ts` uses `puppeteer-core` with a dedicated persistent Chrome profile at `~/.orca/chrome-profile`. This is a real Chromium binary with a real TLS fingerprint — Cloudflare passes it. No LLM involved.

- **First run**: Chrome launches in visible mode so the user can log in once. Session is persisted to `~/.orca/chrome-profile/Default/Cookies`.
- **Subsequent runs**: Fully headless. Scrapes `claude.ai/settings/usage` every 60 seconds server-side.
- **GET** `/api/rate-limit-usage` — returns cached fraction.
- **POST** `/api/rate-limit-usage/push` with `{ fraction: 0–1 }` — manual override (rarely needed).
- **POST** `/api/rate-limit-usage/refresh` — triggers an immediate scrape.

If the displayed value is stale, check the server logs for `[orca/usage-scraper]` lines. If Chrome is blocked (profile lock), restart the server to release the lock.