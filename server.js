/**
 * server.js
 * ---------
 * Tiny Express service that:
 *   - serves the cached inventory at GET /api/inventory (fast; CORS-enabled)
 *   - refreshes the cache from mobile.de on a cron schedule (default: every 6h)
 *   - persists the last successful result to disk and always serves the
 *     last-good copy if a refresh fails (the site never goes blank)
 *
 * Visitors hit the cache only. The (paid) Claude extraction runs on the
 * schedule, not per request.
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchInventory } from "./lib/fetchInventory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "data", "inventory.json");
const SEED_FILE = path.join(__dirname, "data", "inventory.seed.json");

const PORT           = Number(process.env.PORT || 8080);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const REFRESH_TOKEN  = process.env.REFRESH_TOKEN || "";
const CRON_SCHEDULE  = process.env.CRON_SCHEDULE || "0 */6 * * *"; // every 6 hours

let cache = null;       // last-good inventory object
let refreshing = false; // simple lock

/* ---------- cache helpers ---------- */

async function loadFromDisk() {
  for (const file of [DATA_FILE, SEED_FILE]) {
    try {
      const txt = await fs.readFile(file, "utf-8");
      cache = JSON.parse(txt);
      console.log(`[inventory] loaded ${cache.vehicles?.length ?? 0} vehicles from ${path.basename(file)}`);
      return;
    } catch {
      /* try next */
    }
  }
  console.warn("[inventory] no cached or seed data found — cache is empty until first refresh");
}

async function saveToDisk(data) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

/* ---------- refresh ---------- */

async function refresh(reason = "scheduled") {
  if (refreshing) return { skipped: true };
  refreshing = true;
  const startedAt = Date.now();
  try {
    console.log(`[inventory] refresh start (${reason})`);
    const data = await fetchInventory();
    if (!data.vehicles?.length) throw new Error("extraction returned 0 vehicles");
    cache = data;
    await saveToDisk(data);
    console.log(`[inventory] refresh ok: ${data.count} vehicles in ${Date.now() - startedAt}ms`);
    return { ok: true, count: data.count, updatedAt: data.updatedAt };
  } catch (err) {
    // Keep serving the last-good cache; never throw away working data.
    console.error(`[inventory] refresh FAILED (${reason}): ${err.message} — serving last-good copy`);
    return { ok: false, error: err.message };
  } finally {
    refreshing = false;
  }
}

/* ---------- http ---------- */

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/api/inventory", (_req, res) => {
  if (!cache) return res.status(503).json({ error: "inventory not ready yet" });
  // Let browsers/CDNs cache briefly; data only changes a few times a day.
  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
  res.json(cache);
});

// Manual refresh, protected by a shared token: POST /api/refresh  (x-refresh-token: ...)
app.post("/api/refresh", async (req, res) => {
  if (!REFRESH_TOKEN || req.get("x-refresh-token") !== REFRESH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const result = await refresh("manual");
  res.json(result);
});

/* ---------- boot ---------- */

await loadFromDisk();

app.listen(PORT, () => {
  console.log(`[inventory] listening on :${PORT}  (origin: ${ALLOWED_ORIGIN})`);
  // Kick off an initial refresh shortly after boot (non-blocking).
  setTimeout(() => refresh("startup"), 2000);
});

// Schedule recurring refreshes.
cron.schedule(CRON_SCHEDULE, () => refresh("cron"), { timezone: "Europe/Berlin" });
console.log(`[inventory] cron scheduled: "${CRON_SCHEDULE}" (Europe/Berlin)`);
