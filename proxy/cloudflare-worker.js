// Optionaler Minimal-Proxy für TCGdex (nur nötig, falls ein Browser CORS blockt).
// Getestet am 17.11.2026: TCGdex sendet "Access-Control-Allow-Origin: *" -> direkt nutzbar.
// Deploy: Cloudflare Dashboard -> Workers -> neuen Worker anlegen -> diesen Code einfügen.
// In der App unter Einstellungen -> API-Basis-URL: https://<dein-worker>.workers.dev/v2
const UPSTREAM = 'https://api.tcgdex.net';
const TTL = 24 * 3600; // 24 h

export default {
  async fetch(request, env, ctx) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return new Response('Nur GET erlaubt', { status: 405, headers: cors });

    const url = new URL(request.url);
    if (!url.pathname.startsWith('/v2/')) return new Response('Nicht gefunden', { status: 404, headers: cors });
    const target = UPSTREAM + url.pathname + url.search;

    const cache = caches.default;
    const key = new Request(target, { method: 'GET' });
    let res = await cache.match(key);
    if (!res) {
      const up = await fetch(target, { headers: { Accept: 'application/json' } });
      res = new Response(up.body, up);
      res.headers.set('Cache-Control', `public, max-age=${TTL}`);
      if (up.ok || up.status === 404) ctx.waitUntil(cache.put(key, res.clone()));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
