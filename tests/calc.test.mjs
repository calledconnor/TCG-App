import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CF, DEFAULT_LF, stats, evaluate, zustandsFaktor, sprachFaktor,
  parsePrices, parseCardNumber, localIdVariants, marktwert,
} from '../js/calc.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('Gegenprobe: englisch NM -> deutsch LP = 0.45 × 0.63 = 0.2835', () => {
  const f = zustandsFaktor(DEFAULT_CF, 'LP', 'NM') * sprachFaktor(DEFAULT_LF, 'de', 'en');
  close(f, 0.2835);
  assert.equal(f.toFixed(2), '0.28');
});

test('Faktoren sind Verhältnisse, nicht feste Abschläge', () => {
  close(zustandsFaktor(DEFAULT_CF, 'EX', 'MT'), 0.8 / 1.15);
  close(sprachFaktor(DEFAULT_LF, 'de', 'fr'), 0.63 / 0.55);
});

test('stats: Median statt Durchschnitt, Ausreißer zieht nur den Schnitt', () => {
  const s = stats([10, 11, 12, 13, 100]);
  assert.equal(s.count, 5);
  assert.equal(s.min, 10);
  assert.equal(s.median, 12);
  close(s.mean, 29.2);
  assert.equal(s.max, 100);
  assert.equal(stats([1, 2, 3, 4]).median, 2.5);
  assert.equal(stats([]).count, 0);
});

test('evaluate: brutto, netto, Leiter, Rendite 70 % = 42,9 %', () => {
  const r = evaluate({
    referenz: 100, cf: DEFAULT_CF, lf: DEFAULT_LF,
    meinZustand: 'LP', refZustand: 'NM', meineSprache: 'de', refSprache: 'en',
    provision: 0.05, versand: 1, minNetto: 25,
  });
  close(r.brutto, 28.35);
  close(r.netto, 28.35 * 0.95 - 1);
  assert.deepEqual(r.ladder.map((l) => l.p), [0.85, 0.8, 0.75, 0.7]);
  const l70 = r.ladder[3];
  close(l70.maxGebot, r.netto * 0.7);
  close(l70.gewinn, r.netto - r.netto * 0.7);
  assert.equal((l70.rendite * 100).toFixed(1), '42.9');
  assert.ok(r.ladder[1].highlight);
  assert.equal(r.unterMindest, false);
});

test('Warnung unter Netto-Minimum', () => {
  const r = evaluate({ referenz: 20, cf: DEFAULT_CF, lf: DEFAULT_LF, meinZustand: 'NM', refZustand: 'NM', meineSprache: 'en', refSprache: 'en', provision: 0, versand: 0, minNetto: 25 });
  assert.equal(r.unterMindest, true);
});

test('marktwert nach Faktoren', () => {
  close(marktwert({ referenz: 10, cf: DEFAULT_CF, lf: DEFAULT_LF, zustand: 'LP', sprache: 'de' }), 2.835);
  assert.equal(marktwert({ referenz: null, cf: DEFAULT_CF, lf: DEFAULT_LF, zustand: 'LP', sprache: 'de' }), null);
});

test('parsePrices: deutsche und englische Schreibweisen', () => {
  assert.deepEqual(parsePrices('12,50 €  13,00 €\n€ 3.99; 1.234,00 €'), [12.5, 13, 3.99, 1234]);
  assert.deepEqual(parsePrices('7 8,5'), [7, 8.5]);
});

test('parseCardNumber aus OCR-Text', () => {
  assert.deepEqual(parseCardNumber('Illus. 097/165 ★'), { number: '097', total: '165' });
  assert.deepEqual(parseCardNumber('97 / 99'), { number: '97', total: '99' });
  assert.deepEqual(parseCardNumber('TG05/TG30'), { number: 'TG05', total: 'TG30' });
  assert.deepEqual(parseCardNumber('4|102'), { number: '4', total: '102' });
  assert.equal(parseCardNumber('kein text'), null);
});

test('localIdVariants für TCGdex (6/06/006)', () => {
  assert.deepEqual(localIdVariants('6').sort(), ['006', '06', '6']);
  assert.deepEqual(localIdVariants('097').sort(), ['097', '97']);
  assert.ok(localIdVariants('TG05').includes('TG05'));
});
