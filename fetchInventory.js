/**
 * fetchInventory.js
 * ------------------
 * Fetches Autohaus Pufahl's public mobile.de dealer page(s) server-side,
 * then uses Claude (Anthropic API) to extract the listings into clean,
 * structured JSON. The API key lives in the environment — never in the
 * browser.
 *
 * Why Claude instead of hand-written CSS selectors?
 *   mobile.de's markup changes without notice. A semantic extraction step
 *   is far more resilient than brittle querySelector chains, and at Haiku
 *   pricing ($1/$5 per million tokens) a twice-daily run costs pennies a
 *   month. The expensive step runs on a schedule; visitors are served the
 *   cached result, so they never trigger an API call.
 */

import Anthropic from "@anthropic-ai/sdk";

const DEALER_URL  = process.env.DEALER_URL  || "https://home.mobile.de/AH-PUFAHL";
const MAX_PAGES   = Number(process.env.MAX_PAGES || 2);
const MODEL       = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const IMG_BASE    = "https://img.classistatic.de/api/v1/mo-prod/images/";
const DETAIL_BASE = "https://suchen.mobile.de/fahrzeuge/details.html?id=";
const IMG_RULE    = process.env.IMG_RULE || "mo-1600";
const MAX_DETAIL_FETCH  = Number(process.env.MAX_DETAIL_FETCH || 24);
const DETAIL_CONCURRENCY = Number(process.env.DETAIL_CONCURRENCY || 4);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const BODY_TYPES = ["suv", "limousine", "kombi", "van", "kompakt", "coupe"];

/** Fetch one dealer page as HTML. */
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "de-DE,de;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`mobile.de returned HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Strip noise (scripts/styles/svg/head/comments) and collapse whitespace. */
function cleanHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160000); // generous cap; Haiku has a 200k context window
}

/** Ask Claude to turn the page HTML into a strict JSON array of vehicles. */
async function extractWithClaude(client, html) {
  const system =
    "You extract used-car listing data from a mobile.de dealer page. " +
    "You reply with ONLY a raw JSON array — no prose, no markdown fences.";

  const prompt = `Below is the cleaned HTML of a mobile.de dealer listings page.
Extract every passenger-car (Pkw) listing you can find. For each listing return
an object with EXACTLY these keys:

{
  "make": "Opel",                 // manufacturer
  "model": "Grandland",           // model name (without the variant text)
  "variant": "1.5 D Automatik",   // engine / trim line; "" if unknown
  "priceNow": 19500,              // current asking price in EUR (integer, no separators)
  "priceWas": 19900,              // original/strikethrough price in EUR, or null if none
  "km": 39000,                    // mileage in km (integer)
  "firstReg": "08/2021",          // first registration as MM/YYYY ("" if unknown)
  "powerPs": 181,                 // power in PS (integer)
  "powerKw": 133,                 // power in kW (integer, 0 if unknown)
  "fuel": "Benzin",               // Benzin | Diesel | Hybrid | Elektro | Autogas | ...
  "gearbox": "Automatik",         // Automatik | Schaltgetriebe
  "bodyType": "suv",              // one of: suv | limousine | kombi | van | kompakt | coupe
  "adId": "450000528",            // the numeric mobile.de ad id (from links/finance URLs)
  "imagePaths": ["11/11b95c16-a088-4272-a777-6d9473e0a3f7"], // image path segments only
  "accidentFree": true            // true if "Unfallfrei" is stated, else false
}

Rules:
- "imagePaths": take only the path AFTER ".../images/" and BEFORE "?rule=...".
  Example: from
  "https://img.classistatic.de/api/v1/mo-prod/images/11/11b95c16-a088-4272-a777-6d9473e0a3f7?rule=mo-1600"
  return "11/11b95c16-a088-4272-a777-6d9473e0a3f7". Include up to 3 per car.
- "adId": find the numeric id (it appears in finance/detail links as adId=... or id=...).
- Pick the single best "bodyType" from the allowed list.
- Skip trucks/vans over 7.5t. Keep normal passenger cars and minibuses.
- Output ONLY the JSON array.

HTML:
${html}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) {
    throw new Error("Claude response contained no JSON array");
  }
  return JSON.parse(text.slice(start, end + 1));
}

/** Ask Claude to pull equipment/consumption/description out of a single vehicle's own detail page. */
async function extractDetailWithClaude(client, html) {
  const system =
    "You extract used-car detail-page data from a single mobile.de vehicle ad. " +
    "You reply with ONLY a raw JSON object — no prose, no markdown fences.";

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

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Claude response contained no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

/** Visit each vehicle's own detail page and merge in equipment/CO2/consumption/description. Best-effort: a failed detail fetch just leaves the base fields untouched. */
async function enrichWithDetails(client, vehicles) {
  const targets = vehicles.filter((v) => v.adId).slice(0, MAX_DETAIL_FETCH);
  const byAdId = new Map();

  for (let i = 0; i < targets.length; i += DETAIL_CONCURRENCY) {
    const batch = targets.slice(i, i + DETAIL_CONCURRENCY);
    await Promise.all(
      batch.map(async (v) => {
        try {
          const html = cleanHtml(await fetchPage(v.detailUrl));
          const extra = await extractDetailWithClaude(client, html);
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

/** Validate, normalise, and attach full URLs. */
function normalise(raw) {
  const out = [];
  const seen = new Set();

  for (const v of raw) {
    if (!v || !v.make || !v.model) continue;

    const adId = String(v.adId || "").replace(/\D/g, "");
    const dedupeKey = adId || `${v.make}|${v.model}|${v.priceNow}|${v.km}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const paths = Array.isArray(v.imagePaths) ? v.imagePaths.filter(Boolean) : [];
    const images = paths.map((p) => `${IMG_BASE}${p}?rule=${IMG_RULE}`);

    let bodyType = String(v.bodyType || "").toLowerCase();
    if (!BODY_TYPES.includes(bodyType)) bodyType = "limousine";

    out.push({
      make: String(v.make).trim(),
      model: String(v.model).trim(),
      variant: String(v.variant || "").trim(),
      priceNow: Number(v.priceNow) || null,
      priceWas: Number(v.priceWas) || null,
      km: Number(v.km) || null,
      firstReg: String(v.firstReg || "").trim(),
      powerPs: Number(v.powerPs) || null,
      powerKw: Number(v.powerKw) || null,
      fuel: String(v.fuel || "").trim(),
      gearbox: String(v.gearbox || "").trim(),
      bodyType,
      accidentFree: Boolean(v.accidentFree),
      badge: v.priceWas ? "Reduziert" : "Gebraucht",
      adId,
      detailUrl: adId ? `${DETAIL_BASE}${adId}` : DEALER_URL,
      imageUrl: images[0] || null,
      images,
    });
  }
  return out;
}

/**
 * Main entry: returns
 * { updatedAt, source, dealerUrl, count, vehicles: [...] }
 */
export async function fetchInventory() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const client = new Anthropic({ apiKey });

  // Collect HTML across pages (page 1 has no suffix; later pages use ?pageNumber=N).
  let combined = "";
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? DEALER_URL : `${DEALER_URL}?pageNumber=${page}`;
    try {
      combined += "\n\n" + (await fetchPage(url));
    } catch (err) {
      if (page === 1) throw err; // page 1 must work
      console.warn(`[inventory] page ${page} skipped: ${err.message}`);
      break;
    }
  }

  const raw = await extractWithClaude(client, cleanHtml(combined));
  const base = normalise(raw);
  const vehicles = await enrichWithDetails(client, base);

  return {
    updatedAt: new Date().toISOString(),
    source: "mobile.de",
    dealerUrl: DEALER_URL,
    count: vehicles.length,
    vehicles,
  };
}
