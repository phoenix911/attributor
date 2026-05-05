<div align="center">

# attributor

**Self-hosted mobile install attribution on Cloudflare Workers**

A tiny Worker that records install-page clicks and matches them to first-app-launch events. Multi-tenant (one Worker, many apps), $5/month flat.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/phoenix911/attributor)

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?style=flat&logo=cloudflare&logoColor=white)
![D1](https://img.shields.io/badge/Cloudflare_D1-F38020?style=flat&logo=cloudflare&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green?style=flat)

</div>

---

## Why attributor?

Mobile attribution SaaS (Adjust, AppsFlyer, Branch) starts at hundreds per month and ships an SDK that bloats your binary, eats privacy permissions, and ties analytics to a vendor. attributor does the boring 80% — **which referrer brought this install** — in a single Worker file you control, with no SDK.

```
install page click  →  POST /click   →  D1 row + click_id
first app launch    →  POST /match   →  matched referrer
```

- **Android:** Play Install Referrer carries your `click_id` — ~100% match.
- **iOS:** fingerprint match on IP + UA + locale + TZ + screen + ASN — ~80–88% match.
- **Multi-app:** one Worker handles many apps via `APPS_CONFIG`.
- **$5/month flat** on Workers Paid up to ~1.6M clicks/day. Free tier covers ~3,300/day.

---

## Quick start

**Option A — Deploy button** *(recommended)*

1. Click the button at the top. Cloudflare creates the Worker + D1 binding from `wrangler.toml`.
2. Clone the repo and run the wizard to apply the schema and set the dashboard password:
   ```bash
   git clone https://github.com/phoenix911/attributor.git
   cd attributor
   make setup
   ```
   The wizard auto-detects the existing deployment and only runs the missing steps (schema apply + secrets + optional domain).

**Option B — Clone and deploy**

```bash
git clone https://github.com/phoenix911/attributor.git
cd attributor
make setup
```

The wizard handles: Cloudflare auth → `wrangler d1 create` → schema apply → custom domain (optional) → `DASHBOARD_PASS` secret → `wrangler deploy`. Resumable — re-run any time and it skips completed steps.

When it finishes, it offers to open the Cloudflare dashboard → **Variables and Secrets** for this Worker so you can manage `APPS_CONFIG`, `ALLOWED_ORIGINS`, and secrets in the UI.

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/click` | Install page logs each visit with `?referrer=…`. Returns `{click_id}` to embed in the Play `referrer=` URL. |
| `POST` | `/match` | First app launch hits this. Android: `play_referrer` extracted directly. iOS: scored fingerprint match. |
| `GET`  | `/dashboard` | Stats UI — clicks, match rate, top referrers, per-app split. Basic-auth via `DASHBOARD_USER` + `DASHBOARD_PASS`. |
| `GET`  | `/dashboard/api/stats` | JSON aggregations (same auth). |
| `GET`  | `/health` | Liveness probe. |

---

## Adding a new app

Edit `code/wrangler.toml` → `APPS_CONFIG`:

```jsonc
APPS_CONFIG = '''{
  "com.your.app":     {"ttl_days": 7,  "max_referrer_len": 64, "referrer_pattern": "^[a-z0-9_-]+$"},
  "com.another.app":  {"ttl_days": 14, "max_referrer_len": 32, "referrer_pattern": "^[A-Z0-9]+$"}
}'''
```

Then `make deploy`. No code change. Or edit it in the Cloudflare dashboard under **Variables and Secrets** for live changes without a redeploy.

---

## Storage — D1 only

Two tables (see `code/schema.sql`):
- `clicks` — every install-page hit. 14-day retention via `cleanup.sql`.
- `matches` — outcome of every `/match` call. Used to measure attribution rate. 90-day retention.

```bash
make db-cleanup       # manual retention sweep
```

To automate, uncomment the `[triggers]` block in `code/wrangler.toml`:

```toml
[triggers]
crons = ["0 3 * * 0"]   # Sundays at 03:00 UTC
```

(and add a scheduled handler — see Cloudflare docs).

---

## Inspecting data

```bash
cd code
npx wrangler d1 execute attribution --remote \
  --command "SELECT referrer, count(*) FROM clicks WHERE app_id='com.your.app' GROUP BY referrer ORDER BY 2 DESC LIMIT 20"

npx wrangler d1 execute attribution --remote \
  --command "SELECT method, count(*) FROM matches WHERE matched_at > (strftime('%s','now')-86400)*1000 GROUP BY method"
```

Or just open `/dashboard` on your domain.

---

## Stack

| Layer | Tech | Why |
|-------|------|-----|
| Runtime | Cloudflare Workers | V8 isolates, 0 ms cold start, global edge |
| Storage | Cloudflare D1 | SQL, native to Workers, $5/mo flat |
| Language | TypeScript | Type safety, compiled by Wrangler |
| Auth | Basic auth on `/dashboard` | One secret, no session machinery |

---

## Makefile

```bash
make setup          # interactive wizard (resumable)
make deploy         # deploy to Cloudflare Workers
make dev            # local dev at localhost:8787
make tail           # stream live worker logs
make db-init        # apply schema.sql to remote D1
make db-cleanup     # run retention sweep against remote D1
make secrets        # open CF dashboard → Variables & Secrets
make commit MSG=…   # stage all, commit, push  (NP=1 to skip push)
make help           # all commands
```

---

## Don'ts

- Don't store PII beyond IP + UA. The 14-day `clicks` TTL keeps the privacy footprint small — don't widen it without a reason.
- Don't widen `referrer_pattern` to allow whitespace or symbols — it opens injection vectors and breaks Play Install Referrer parsing.
- Don't add D1 indexes without checking write cost — every index is an extra B-tree write per insert.

---

<div align="center">

MIT license — fork it, deploy it, run it however you like.

</div>
