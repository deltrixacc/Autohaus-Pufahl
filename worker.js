/**
 * worker.js — Cloudflare Worker variant (serverless; no server to maintain)
 * ------------------------------------------------------------------------
 * Same job as server.js, but runs on Cloudflare's free tier:
 *   - a Cron Trigger refreshes the inventory on a schedule  (scheduled handler)
 *   - the result is stored in a KV namespace
 *   - GET /api/inventory serves the stored JSON from KV       (fetch handler)
 *
 * Bindings (see wrangler.toml):
 *   - KV namespace:  INVENTORY
 *   - secret:        ANTHROPIC_API_KEY      (npx wrangler secret put ANTHROPIC_API_KEY)
 *   - vars:          DEALER_URL, ALLOWED_ORIGIN, ANTHROPIC_MODEL, MAX_PAGES, IMG_RULE
 */

const IMG_BASE    = "https://img.classistatic.de/api/v1/mo-prod/images/";
const DETAIL_BASE = "https://suchen.mobile.de/fahrzeuge/details.html?id=";
const BODY_TYPES  = ["suv", "limousine", "kombi", "van", "kompakt", "coupe"];
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export default {
  // Served to the website
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true }, { headers: cors });
    }
    if (url.pathname === "/api/inventory") {
      const data = await env.INVENTORY.get("data");
      if (!data) return Response.json({ error: "inventory not ready yet" }, { status: 503, headers: cors });
      return new Response(data, {
        headers: {
          ...cors,
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
        },
      });
    }
    // Live Zentrallager search — proxies mobile.de's OFFICIAL Search-API.
    if (url.pathname === "/api/search") {
      try {
        const payload = await searchMobile(env, url.searchParams);
        return new Response(JSON.stringify(payload), {
          headers: {
            ...cors,
            "Content-Type": "application/json",
            // search results change slowly; brief edge cache keeps it snappy.
            "Cache-Control": "public, max-age=120, stale-while-revalidate=600",
          },
        });
      } catch (err) {
        return Response.json({ error: err.message || "search failed" }, { status: 502, headers: cors });
      }
    }
    return new Response("Not found", { status: 404, headers: cors });
  },

  // Runs on the cron schedule defined in wrangler.toml
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refresh(env));
  },
};

async function refresh(env) {
  try {
    const dealerUrl = env.DEALER_URL || "https://home.mobile.de/AH-PUFAHL";
    const maxPages = Number(env.MAX_PAGES || 2);

    let html = "";
    for (let p = 1; p <= maxPages; p++) {
      const u = p === 1 ? dealerUrl : `${dealerUrl}?pageNumber=${p}`;
      const res = await fetch(u, { headers: { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9" } });
      if (!res.ok) { if (p === 1) throw new Error(`HTTP ${res.status}`); break; }
      html += "\n\n" + (await res.text());
    }

    const base = normalise(await extract(env, clean(html)), dealerUrl, env.IMG_RULE || "mo-1600");
    if (!base.length) throw new Error("0 vehicles extracted");
    const vehicles = await enrichWithDetails(env, base);

    const payload = {
      updatedAt: new Date().toISOString(),
      source: "mobile.de",
      dealerUrl,
      count: vehicles.length,
      vehicles,
    };
    await env.INVENTORY.put("data", JSON.stringify(payload));
    console.log(`[inventory] stored ${vehicles.length} vehicles`);
  } catch (err) {
    // Leave the previous KV value in place — site keeps serving last-good.
    console.error(`[inventory] refresh failed: ${err.message}`);
  }
}

function clean(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160000);
}

async function extract(env, html) {
  const system =
    "You extract used-car listing data from a mobile.de dealer page. " +
    "Reply with ONLY a raw JSON array — no prose, no markdown fences.";
  const prompt = `From the cleaned mobile.de HTML below, extract every passenger car.
Return a JSON array; each object EXACTLY:
{"make","model","variant","priceNow","priceWas","km","firstReg","powerPs","powerKw","fuel","gearbox","bodyType","adId","imagePaths","accidentFree"}
- priceNow/priceWas: EUR integers (priceWas null if none). km/powerPs/powerKw integers.
- firstReg "MM/YYYY". bodyType one of suv|limousine|kombi|van|kompakt|coupe.
- imagePaths: only the segment between ".../images/" and "?rule=" (max 3).
- adId: the numeric mobile.de id from links. Output ONLY the JSON array.

HTML:
${html}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || "claude-haiku-4-5",
      max_tokens: 8000,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const s = text.indexOf("["), e = text.lastIndexOf("]");
  if (s === -1 || e === -1) throw new Error("no JSON array in response");
  return JSON.parse(text.slice(s, e + 1));
}

/** Ask Claude to pull equipment/consumption/description out of a single vehicle's own detail page. */
async function extractDetail(env, html) {
  const system =
    "You extract used-car detail-page data from a single mobile.de vehicle ad. " +
    "Reply with ONLY a raw JSON object — no prose, no markdown fences.";
  const prompt = `Below is the cleaned HTML of a single mobile.de vehicle detail page.
Extract an object with EXACTLY these keys:
{
  "equipment": ["Sitzheizung", "Einparkhilfe Sensoren hinten"], // every equipment/feature item listed under "Ausstattung", flat array, original German wording, no duplicates, [] if none found
  "co2": 143,                 // combined CO2 emissions in g/km (integer), null if not stated
  "consumption": "6,2 l/100km", // combined fuel/energy consumption exactly as shown, "" if not stated
  "description": "..."        // the seller's free-text vehicle description ("Fahrzeugbeschreibung"), plain text, "" if none
}
Output ONLY the JSON object.

HTML:
${html}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || "claude-haiku-4-5",
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("no JSON object in response");
  return JSON.parse(text.slice(s, e + 1));
}

/** Visit each vehicle's own detail page and merge in equipment/CO2/consumption/description. Best-effort: a failed detail fetch just leaves the base fields untouched. */
async function enrichWithDetails(env, vehicles) {
  const maxDetail = Number(env.MAX_DETAIL_FETCH || 24);
  const concurrency = Number(env.DETAIL_CONCURRENCY || 4);
  const targets = vehicles.filter((v) => v.adId).slice(0, maxDetail);
  const byAdId = new Map();

  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (v) => {
        try {
          const res = await fetch(v.detailUrl, { headers: { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9" } });
          if (!res.ok) return;
          const html = clean(await res.text());
          const extra = await extractDetail(env, html);
          byAdId.set(v.adId, {
            equipment: Array.isArray(extra.equipment) ? extra.equipment.filter(Boolean) : [],
            co2: Number(extra.co2) || null,
            consumption: String(extra.consumption || "").trim(),
            description: String(extra.description || "").trim(),
          });
        } catch (err) {
          console.warn(`[inventory] detail enrich skipped for ${v.adId}: ${err.message}`);
        }
      })
    );
  }

  return vehicles.map((v) => (byAdId.has(v.adId) ? { ...v, ...byAdId.get(v.adId) } : v));
}

function normalise(raw, dealerUrl, rule) {
  const out = [], seen = new Set();
  for (const v of raw) {
    if (!v || !v.make || !v.model) continue;
    const adId = String(v.adId || "").replace(/\D/g, "");
    const key = adId || `${v.make}|${v.model}|${v.priceNow}|${v.km}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const paths = Array.isArray(v.imagePaths) ? v.imagePaths.filter(Boolean) : [];
    const images = paths.map((p) => `${IMG_BASE}${p}?rule=${rule}`);
    let bt = String(v.bodyType || "").toLowerCase();
    if (!BODY_TYPES.includes(bt)) bt = "limousine";
    out.push({
      make: String(v.make).trim(), model: String(v.model).trim(),
      variant: String(v.variant || "").trim(),
      priceNow: Number(v.priceNow) || null, priceWas: Number(v.priceWas) || null,
      km: Number(v.km) || null, firstReg: String(v.firstReg || "").trim(),
      powerPs: Number(v.powerPs) || null, powerKw: Number(v.powerKw) || null,
      fuel: String(v.fuel || "").trim(), gearbox: String(v.gearbox || "").trim(),
      bodyType: bt, accidentFree: Boolean(v.accidentFree),
      badge: v.priceWas ? "Reduziert" : "Gebraucht", adId,
      detailUrl: adId ? `${DETAIL_BASE}${adId}` : dealerUrl,
      imageUrl: images[0] || null, images,
    });
  }
  return out;
}

/* ==========================================================================
   LIVE SEARCH — mobile.de official Search-API
   --------------------------------------------------------------------------
   Docs: https://services.mobile.de/manual/search-api.html
   Auth: HTTP Basic with the API credentials mobile.de issues to the dealer.
   Set them as Worker secrets (never as plain vars):
       npx wrangler secret put MOBILE_API_USER
       npx wrangler secret put MOBILE_API_PASSWORD
   The frontend (fahrzeugsuche.html) sends these query params:
       make, model, maxPrice, maxKm, minYear, gearbox, fuel(csv), page, size
   ========================================================================== */
const SEARCH_API = "https://services.mobile.de/search-api/search";

async function searchMobile(env, qp) {
  const user = env.MOBILE_API_USER, pass = env.MOBILE_API_PASSWORD;
  if (!user || !pass) throw new Error("mobile.de API credentials not configured");

  const page = Math.max(1, parseInt(qp.get("page")) || 1);
  const size = Math.min(100, Math.max(1, parseInt(qp.get("size")) || 24));

  // Map our params → Search-API params.
  const api = new URLSearchParams();
  api.set("classification", "refdata/classes/Car");
  api.set("page.number", String(page));
  api.set("page.size", String(size));

  const make = qp.get("make");
  if (make) api.set("make", make);                                  // e.g. VOLKSWAGEN
  const model = qp.get("model");
  if (model) api.set("modelDescription", model);                   // free text
  const maxPrice = qp.get("maxPrice");
  if (maxPrice) api.set("price.max", maxPrice);
  const maxKm = qp.get("maxKm");
  if (maxKm) api.set("mileage.max", maxKm);
  const minYear = qp.get("minYear");
  if (minYear) api.set("firstRegistrationDate.min", `${minYear}0101`); // YYYYMMDD
  const gearbox = qp.get("gearbox");
  if (gearbox) api.set("gearbox", gearbox);
  const fuel = qp.get("fuel");
  if (fuel) fuel.split(",").filter(Boolean).forEach((f) => api.append("fuel", f));

  const res = await fetch(`${SEARCH_API}?${api.toString()}`, {
    headers: {
      "Authorization": "Basic " + btoa(`${user}:${pass}`),
      "Accept": "application/vnd.de.mobile.api+json",
      "Accept-Language": "de",
    },
  });
  if (!res.ok) throw new Error(`Search-API HTTP ${res.status}`);
  const json = await res.json();
  return normaliseSearch(json, page, size);
}

/* The Search-API JSON uses namespaced keys ("search:...", "vehicle:...") and
   wraps values as {"#text": "..."} / {"@key": "..."}. These helpers dig through
   that shape defensively so a small format change won't blow up the whole page. */
function txt(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (node["#text"] != null) return String(node["#text"]);
  return "";
}
function keyOf(node) {
  if (node == null) return "";
  if (node["@key"] != null) return String(node["@key"]);
  return "";
}
function asArray(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }

function normaliseSearch(json, page, size) {
  // Find the resultlist container regardless of the exact "resultlist.x.y" key.
  let rl = null;
  for (const k of Object.keys(json || {})) {
    if (k.indexOf("resultlist") !== -1) { rl = json[k]; break; }
  }
  rl = rl || json || {};

  const total = parseInt(txt(rl["search:numResultsTotal"]) || rl.numResultsTotal || 0) || 0;
  const adsNode = rl["search:ads"] || rl.ads || {};
  const ads = asArray(adsNode["search:ad"] || adsNode.ad || adsNode);

  const vehicles = ads.map((ad) => {
    const v = ad["search:vehicle"] || ad.vehicle || {};
    const spec = v["vehicle:specifics"] || v.specifics || v;

    const make  = txt(v["vehicle:make"]) || keyOf(v["vehicle:make"]);
    const model = txt(v["vehicle:model"]) || keyOf(v["vehicle:model"]);
    const variant = txt(v["vehicle:model-description"] || v.modelDescription);

    const km = parseInt(txt(spec["vehicle:mileage"] || spec.mileage)) || null;
    const kw = parseInt(txt(spec["vehicle:power"] || spec.power)) || null;   // API power is kW
    const powerPs = kw ? Math.round(kw * 1.35962) : null;

    const fuel = txt(spec["vehicle:fuel"]) || keyOf(spec["vehicle:fuel"]);
    const gearbox = txt(spec["vehicle:gearbox"]) || keyOf(spec["vehicle:gearbox"]);
    const firstReg = txt(spec["vehicle:first-registration"] || spec.firstRegistration); // YYYYMM

    // price
    const priceNode = ad["search:price"] || ad.price || {};
    const priceNow = parseInt(
      txt(priceNode["price:consumer-price-amount"] || priceNode.consumerPriceGross || priceNode.amount)
    ) || null;

    // first image (largest available representation)
    let imageUrl = null;
    const imgs = ad["search:images"] || ad.images || {};
    const first = asArray(imgs["search:image"] || imgs.image)[0];
    if (first) {
      const reps = asArray(first["search:representation"] || first.representation);
      const pick = reps.find((r) => (r["@size"] || r.size) === "XL")
        || reps.find((r) => (r["@size"] || r.size) === "L")
        || reps[0];
      if (pick) imageUrl = pick["@url"] || pick.url || null;
    }

    const detailUrl = txt(ad["search:detail-page"] || ad.detailPage) || ad["@url"] || ad.url
      || "https://home.mobile.de/AH-PUFAHL";

    return {
      make, model, variant,
      priceNow, km, powerPs,
      firstReg, fuel, gearbox,
      imageUrl, detailUrl,
    };
  }).filter((v) => v.make || v.model);

  return { total, page, pageSize: size, source: "mobile.de", vehicles };
}
