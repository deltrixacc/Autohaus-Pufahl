/**
 * inventory-config.js
 * --------------------
 * Single source of truth for the live inventory feed URL, shared by
 * index.html, fahrzeuge.html and fahrzeug-detail.html.
 *
 * Leave empty to keep showing the static demo cards baked into the pages.
 * Once the scraper (worker.js or server.js) is deployed, paste its
 * /api/inventory URL below — all three pages pick it up automatically:
 *   - the listing pages replace the demo cards with the live feed and
 *     stay in sync with mobile.de (cars added/removed there disappear
 *     or appear here on the next page load)
 *   - the detail page fetches the same feed by ad id, so a direct link
 *     to a car that has since been sold shows "nicht mehr verfügbar"
 *     instead of stale data.
 */
window.INVENTORY_API = ""; /* e.g. "https://pufahl-inventory.<you>.workers.dev/api/inventory" */

/**
 * MOBILE_SEARCH_API — used by fahrzeugsuche.html (the "Über 20.000 Fahrzeuge"
 * Zentrallager search). Point it at the worker's /api/search endpoint. It
 * queries mobile.de's OFFICIAL Search-API server-side (credentials stay on the
 * server) and returns the matching listings as JSON, rendered on our own page.
 *
 * Leave "" until the worker is deployed with the mobile.de API credentials —
 * the page then shows a notice and a "search on mobile.de" fallback link.
 */
window.MOBILE_SEARCH_API = ""; /* e.g. "https://pufahl-inventory.<you>.workers.dev/api/search" */

/**
 * KLASSIK_WORKER_URL — used by klassik-cars.html to load CMS-managed classic cars.
 * Point it at the same worker's base URL (no path).
 * Leave "" to hide the dynamic section entirely.
 */
window.KLASSIK_WORKER_URL = "https://aged-butterfly-2054.m727hp.workers.dev";
