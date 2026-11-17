import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundPrice, kalkulation, verkaufsErgebnis, portfolio } from '../js/flip.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('roundPrice: auf ,x9 abrunden', () => {
  assert.equal(roundPrice(6.17), 6.09);
  assert.equal(roundPrice(12), 11.99);
  assert.equal(roundPrice(6.09), 6.09);
  assert.equal(roundPrice(0.456), 0.46);
  assert.equal(roundPrice(0), null);
});

test('kalkulation: Mindestpreis, Zielpreis, Angebot, Deckungsbeitrag', () => {
  const k = kalkulation({ einkauf: 3, markt: 6.4, provision: 0.05, versand: 1, undercut: 0.05, marge: 0.2 });
  close(k.breakEven, 4 / 0.95);
  close(k.zielpreis, (3.6 + 1) / 0.95);
  assert.equal(k.angebot, 5.99); // 6,4 × 0,95 = 6,08 → 5,99
  close(k.db, 5.99 * 0.95 - 1 - 3);
  assert.equal(k.verlust, false);
  const v = kalkulation({ einkauf: 10, markt: 8, provision: 0.05, versand: 1 });
  assert.equal(v.verlust, true);
});

test('verkaufsErgebnis', () => {
  const r = verkaufsErgebnis({ verkauf: 20, provision: 0.05, versand: 1.5, einkauf: 10 });
  close(r.netto, 17.5);
  close(r.db, 7.5);
  close(r.roi, 0.75);
});

test('portfolio: Kasse = Start − Einkäufe + Netto-Erlöse, Lagerwert, Rendite', () => {
  const items = [
    { status: 'bestand', einkauf: 30, datum: '2026-11-01' },
    { status: 'verkauft', einkauf: 20, verkauf: 40, vkVersand: 2, datum: '2026-11-01', vkDatum: '2026-11-11' },
    { status: 'beobachtet', einkauf: 999 },
  ];
  const p = portfolio(items, { start: 100, marktwert: (it) => (it.status === 'bestand' ? 45 : null), platform: () => ({ provision: 0.05, versand: 1 }) });
  close(p.kasse, 100 - 50 + (40 * 0.95 - 2));
  assert.equal(p.gebunden, 30);
  assert.equal(p.lagerwert, 45);
  close(p.dbSumme, 40 * 0.95 - 2 - 20);
  assert.equal(p.halteSchnitt, 10);
  close(p.rendite, (p.kasse + 45 - 100) / 100);
});
