// Cloudflare Worker: liefert die statische App aus und stellt zwei kleine Hilfs-Endpunkte bereit.
//   /api/fx            USD->EUR-Kurs (EZB über frankfurter.dev), 12 h gecacht
//   /api/tcgdex/...    GET-Proxy zu https://api.tcgdex.net/v2/... (Fallback, falls der Browser TCGdex blockt), 24 h gecacht
// Alles andere: statische Dateien (env.ASSETS).
const JSON_HDR = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };

async function cached(ctx, key, ttl, produce) {
  const cache = caches.default;
  const req = new Request(key);
  let res = await cache.match(req);
  if (res) return res;
  try {
    res = await produce();
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 502, headers: JSON_HDR });
  }
  if (res.ok || res.status === 404) {
    const copy = new Response(res.body, res);
    copy.headers.set('Cache-Control', `public, max-age=${ttl}`);
    ctx.waitUntil(cache.put(req, copy.clone()));
    return copy;
  }
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') return new Response('Nur GET', { status: 405, headers: JSON_HDR });

      if (url.pathname === '/api/fx') {
        return cached(ctx, 'https://fx.internal/usd-eur', 12 * 3600, async () => {
          const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR');
          if (!r.ok) return new Response(JSON.stringify({ error: 'fx ' + r.status }), { status: 502, headers: JSON_HDR });
          const d = await r.json();
          return new Response(JSON.stringify({ rate: d.rates.EUR, date: d.date, source: 'EZB' }), { headers: JSON_HDR });
        });
      }

      if (url.pathname.startsWith('/api/tcgdex/')) {
        const target = 'https://api.tcgdex.net/v2/' + url.pathname.slice('/api/tcgdex/'.length) + url.search;
        return cached(ctx, target, 24 * 3600, async () => {
          const r = await fetch(target, { headers: { Accept: 'application/json' } });
          return new Response(r.body, { status: r.status, headers: JSON_HDR });
        });
      }
      return new Response(JSON.stringify({ error: 'unbekannt' }), { status: 404, headers: JSON_HDR });
    }
    return env.ASSETS.fetch(request);
  },
};
