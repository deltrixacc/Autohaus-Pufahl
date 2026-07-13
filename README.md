# Pufahl Inventory API

A small service that keeps the Autohaus Pufahl website in sync with the
dealership's **live mobile.de inventory** — real cars, real prices, real
photos — and refreshes itself automatically.

```
mobile.de dealer page ──(scheduled)──▶  this service  ──▶  inventory.json
                                          │  (Claude extracts the listings;
                                          │   API key stays server-side)
                                          ▼
                          website fahrzeuge.html  ◀── GET /api/inventory
                          (visitors hit the cache, never the API)
```

## How it works

1. On a schedule (default **every 6 hours**) the service fetches Pufahl's
   public mobile.de page.
2. It sends the page HTML to **Claude Haiku** (`claude-haiku-4-5`), which
   returns the listings as clean JSON (make, model, price, mileage, photos,
   per-listing URL, …). Semantic extraction is far more robust than CSS
   selectors when mobile.de changes its markup.
3. The result is cached to disk / KV and served at `GET /api/inventory`.
4. The website fetches that JSON and renders the cards. **Visitors never
   trigger an API call** — they read the cache, so the page is instant and
   the API cost stays tiny.
5. If a refresh ever fails, the **last-good copy keeps being served** — the
   page never goes blank.

The API key lives only on the server (env var / Worker secret). It is never
shipped to the browser.

---

## Option A — Node server (Railway, Render, Fly.io, a VPS, …)

Best if you like a normal long-running process you can run locally.

```bash
cd pufahl-inventory-api
npm install
cp .env.example .env          # then edit .env and add ANTHROPIC_API_KEY
npm start                     # serves http://localhost:8080/api/inventory
```

Test a one-off extraction without starting the server:

```bash
npm run refresh               # prints the JSON it would cache
```

Endpoints:

| Method | Path              | Purpose                                            |
|--------|-------------------|----------------------------------------------------|
| GET    | `/api/inventory`  | the cached inventory JSON (CORS-enabled)           |
| GET    | `/healthz`        | health check                                       |
| POST   | `/api/refresh`    | force a refresh; send header `x-refresh-token: …`  |

**Deploy (Railway example):** push this folder to a repo, create a Railway
project from it, set the env vars from `.env.example`, done. Render and Fly.io
are the same idea. On a VPS, run it under `pm2` or a systemd unit.

---

## Option B — Cloudflare Worker (free, serverless, no server to babysit)

Best fit for a static site: free tier, global, built-in cron + storage.

```bash
cd pufahl-inventory-api
npm install -g wrangler                       # or: npx wrangler ...
npx wrangler kv namespace create INVENTORY    # copy the id it prints
#   → paste that id into wrangler.toml  (kv_namespaces.id)
npx wrangler secret put ANTHROPIC_API_KEY     # paste your key when prompted
npx wrangler deploy
```

You'll get a URL like `https://pufahl-inventory.<you>.workers.dev`.
The cron trigger in `wrangler.toml` refreshes the inventory automatically;
`GET /api/inventory` serves it from KV.

To seed it immediately instead of waiting for the first cron run, open the
Worker's **Trigger → Cron → "Trigger scheduled event"** in the Cloudflare
dashboard, or just hit the deployed URL after the first scheduled run.

---

## Wire up the website

Open `fahrzeuge.html`, find this line near the bottom (in the inventory
script) and paste your endpoint:

```js
const INVENTORY_API = ""; // e.g. "https://pufahl-inventory.<you>.workers.dev/api/inventory"
```

That's it. Behaviour:

- **Left blank** → the page shows the built-in cards that already ship in the
  HTML (real current stock, updated by hand).
- **Set to your endpoint** → on load the page fetches the live feed and
  rebuilds the grid with whatever Pufahl currently has on mobile.de. If the
  feed is unreachable, it silently falls back to the built-in cards.

The built-in cards are intentionally kept as a fallback so the page is never
empty and renders instantly for SEO, even before the feed responds.

---

## Cost

At a 6-hour schedule that's **4 extractions/day**. Each reads one dealer page
(~tens of thousands of tokens) with Haiku at **$1 / 1M input, $5 / 1M output**.
Real-world cost is on the order of **a few cents per month**. Visitor traffic
adds nothing, because visitors read the cache, not the API.

Want it cheaper still? Increase the interval (`CRON_SCHEDULE`) — most dealer
inventories don't change more than once or twice a day.

---

## Configuration (env vars)

See `.env.example`. The important ones:

- `ANTHROPIC_API_KEY` — required.
- `REFRESH_TOKEN` — protects `POST /api/refresh`.
- `ALLOWED_ORIGIN` — set to the site origin in production (e.g.
  `https://www.autohaus-pufahl.de`); `*` is fine while testing.
- `CRON_SCHEDULE` — how often to refresh (cron syntax).
- `DEALER_URL`, `MAX_PAGES`, `ANTHROPIC_MODEL`, `IMG_RULE` — usually leave as-is.

---

## A note on data sources (worth reading)

This service reads Pufahl's **own public listings** and displays them on
Pufahl's **own website**, which is a legitimate use. Two things to keep in
mind for the long run:

- **mobile.de Terms of Service.** Automated reading of their pages should stay
  low-volume and respectful — the default schedule (a few times a day, one
  page, cached) is deliberately gentle. Don't crank the frequency up.
- **The cleanest long-term source is the dealer's own feed.** Pufahl's
  inventory almost certainly flows to mobile.de from a dealer-management
  system (DMS) via a CSV/XML export. That same export — or mobile.de's
  official Seller-API — can feed this service directly instead of reading the
  public page. If/when Pufahl shares that feed, swap the fetch step in
  `lib/fetchInventory.js` (or `worker.js`) for it and you can drop the Claude
  extraction entirely. The rest of the pipeline stays the same.

---

## Files

```
pufahl-inventory-api/
├── server.js                 Node/Express server (Option A)
├── lib/fetchInventory.js     fetch mobile.de + Claude extraction + normalise
├── worker.js                 Cloudflare Worker (Option B)
├── wrangler.toml             Worker config (cron + KV)
├── data/inventory.seed.json  real current stock; served until first refresh
├── .env.example              all config knobs
└── package.json
```
