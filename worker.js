// Cloudflare Worker: liefert die statische App aus und stellt zwei kleine Hilfs-Endpunkte bereit.
//   /api/fx            USD->EUR-Kurs (EZB über frankfurter.dev), 12 h gecacht
//   /api/graded        Graded-Preise (Pokemon Price Tracker, Schlüssel per Secret PPT_API_KEY oder Header X-PPT-Key), 24 h gecacht
//   /api/tcgdex/...    GET-Proxy zu https://api.tcgdex.net/v2/... (Fallback, falls der Browser TCGdex blockt), 24 h gecacht
// Alles andere: statische Dateien (env.ASSETS).
import { aiGrade, aiIdentify } from './ai-grade.js';

const JSON_HDR = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'X-PPT-Key, X-Anthropic-Key, Content-Type', 'Access-Control-Expose-Headers': 'X-Credits-Remaining, X-API-Calls-Consumed' };

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
      // KI-Grading (POST, Bild im Body). Schlüssel: Secret ANTHROPIC_API_KEY oder Header X-Anthropic-Key.
      if (url.pathname === '/api/ai-identify') {
        if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST erwartet' }), { status: 405, headers: JSON_HDR });
        const key = env.ANTHROPIC_API_KEY || request.headers.get('x-anthropic-key');
        if (!key) return new Response(JSON.stringify({ error: 'not_configured' }), { status: 501, headers: JSON_HDR });
        let body;
        try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'bad_body' }), { status: 400, headers: JSON_HDR }); }
        if (!body || typeof body.image !== 'string' || body.image.length > 6_000_000) return new Response(JSON.stringify({ error: 'bad_image' }), { status: 400, headers: JSON_HDR });
        try {
          const out = await aiIdentify(body, key);
          return new Response(JSON.stringify(out), { status: out.error ? 422 : 200, headers: JSON_HDR });
        } catch (e) {
          const status = e && e.status ? e.status : 502;
          return new Response(JSON.stringify({ error: status === 401 ? 'key_invalid' : status === 429 ? 'rate_limited' : 'api_error', message: String(e && e.message || e) }), { status, headers: JSON_HDR });
        }
      }
      if (url.pathname === '/api/ai-grade') {
        if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST erwartet' }), { status: 405, headers: JSON_HDR });
        const key = env.ANTHROPIC_API_KEY || request.headers.get('x-anthropic-key');
        if (!key) return new Response(JSON.stringify({ error: 'not_configured' }), { status: 501, headers: JSON_HDR });
        let body;
        try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'bad_body' }), { status: 400, headers: JSON_HDR }); }
        const imgs = body && Array.isArray(body.images) ? body.images : body && typeof body.image === 'string' ? [{ side: body.side, image: body.image }] : [];
        if (!imgs.length || imgs.length > 2 || imgs.some((i) => !i || typeof i.image !== 'string' || i.image.length > 6_000_000 || !['front', 'back'].includes(i.side))) {
          return new Response(JSON.stringify({ error: 'bad_image' }), { status: 400, headers: JSON_HDR });
        }
        try {
          const out = await aiGrade(body, key);
          return new Response(JSON.stringify(out), { status: out.error ? 422 : 200, headers: JSON_HDR });
        } catch (e) {
          const status = e && e.status ? e.status : 502;
          return new Response(JSON.stringify({ error: status === 401 ? 'key_invalid' : status === 429 ? 'rate_limited' : 'api_error', message: String(e && e.message || e) }), { status, headers: JSON_HDR });
        }
      }
      if (request.method !== 'GET') return new Response('Nur GET', { status: 405, headers: JSON_HDR });

      if (url.pathname === '/api/fx') {
        return cached(ctx, 'https://fx.internal/usd-eur', 12 * 3600, async () => {
          const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR');
          if (!r.ok) return new Response(JSON.stringify({ error: 'fx ' + r.status }), { status: 502, headers: JSON_HDR });
          const d = await r.json();
          return new Response(JSON.stringify({ rate: d.rates.EUR, date: d.date, source: 'EZB' }), { headers: JSON_HDR });
        });
      }

      // Graded-Preise (PSA/CGC/BGS) über Pokemon Price Tracker. Schlüssel: Worker-Secret PPT_API_KEY oder Header X-PPT-Key.
      if (url.pathname === '/api/graded' || url.pathname === '/api/graded-test') {
        const key = env.PPT_API_KEY || request.headers.get('x-ppt-key');
        if (!key) return new Response(JSON.stringify({ error: 'not_configured' }), { status: 501, headers: JSON_HDR });
        let target;
        if (url.pathname === '/api/graded-test') {
          target = 'https://www.pokemonpricetracker.com/api/v2/sets?limit=1';
        } else {
          const id = url.searchParams.get('tcgPlayerId');
          const q = url.searchParams.get('q');
          if (id && /^\d+$/.test(id)) target = `https://www.pokemonpricetracker.com/api/v2/cards?tcgPlayerId=${id}&includeBoth=true&days=3`;
          else if (q) target = `https://www.pokemonpricetracker.com/api/v2/cards?search=${encodeURIComponent(q.slice(0, 100))}&limit=1&includeBoth=true&days=3`;
          else return new Response(JSON.stringify({ error: 'missing_param' }), { status: 400, headers: JSON_HDR });
        }
        const run = async () => {
          const r = await fetch(target, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
          const body = await r.text();
          return new Response(body, { status: r.status, headers: { ...JSON_HDR, 'X-API-Calls-Consumed': r.headers.get('x-api-calls-consumed') || '', 'X-Credits-Remaining': r.headers.get('x-ratelimit-daily-remaining') || '' } });
        };
        // Preise sind öffentlich: Cache je Ziel-URL (nicht je Schlüssel), Test nie cachen
        if (url.pathname === '/api/graded-test') {
          try { return await run(); } catch (e) { return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: JSON_HDR }); }
        }
        return cached(ctx, target, 24 * 3600, run);
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
