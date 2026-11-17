import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centering, centeringCap, subScore, overallGrade } from '../js/grading.js';

test('Zentrierung 50/50 und 60/40', () => {
  const c = centering({ outerL: 0, outerR: 1, outerT: 0, outerB: 1, innerL: 0.05, innerR: 0.95, innerT: 0.05, innerB: 0.95 });
  assert.equal(Math.round(c.lr), 50);
  assert.equal(c.valid, true);
  const d = centering({ outerL: 0, outerR: 1, outerT: 0, outerB: 1, innerL: 0.06, innerR: 0.96, innerT: 0.05, innerB: 0.95 });
  assert.equal(Math.round(d.lr), 60);
  assert.equal(Math.round(d.worst), 60);
});

test('PSA-Zentrierungsgrenzen', () => {
  assert.equal(centeringCap(55, 70), 10);
  assert.equal(centeringCap(55, null), 10);
  assert.equal(centeringCap(57, null), 9); // Beispiel 57/43 -> PSA 9
  assert.equal(centeringCap(62, null), 8);
  assert.equal(centeringCap(55, 80), 9); // Rückseite 80/20 -> nicht 10
  assert.equal(centeringCap(68, null), 7);
  assert.equal(centeringCap(84, null), 5);
});

test('Teilnoten und Gesamtnote', () => {
  const defects = [{ cat: 'corner', sev: 1 }, { cat: 'corner', sev: 2 }, { cat: 'surface', sev: 1 }];
  assert.equal(subScore(defects, 'corner'), 8);
  assert.equal(subScore(defects, 'surface'), 9.5);
  assert.equal(subScore(defects, 'edge'), 10);
  assert.equal(overallGrade({ cap: 10, corners: 8, edges: 10, surface: 9.5 }), 8);
  assert.equal(overallGrade({ cap: 7, corners: 10, edges: 10, surface: 10 }), 7);
});

test('Homographie bildet Ecken exakt ab', async () => {
  const { homography, applyH } = await import('../js/grading.js');
  const src = [[0, 0], [100, 0], [100, 140], [0, 140]];
  const dst = [[12, 8], [118, 15], [110, 160], [5, 150]];
  const H = homography(src, dst);
  for (let i = 0; i < 4; i++) {
    const [u, v] = applyH(H, ...src[i]);
    assert.ok(Math.abs(u - dst[i][0]) < 1e-6 && Math.abs(v - dst[i][1]) < 1e-6);
  }
});

test('Checkliste: Teilnoten und Knick-Deckel', async () => {
  const { checklistScores, defaultChecklist, checklistLines } = await import('../js/grading.js');
  const c = defaultChecklist();
  assert.deepEqual(checklistScores(c), { corners: 10, edges: 10, surface: 10, cap: 10 });
  c.cornerWhitening = 2; c.edgeWhitening = 'light'; c.scratches = true; c.scratchCount = 2; c.holoDamage = 'light_scratches';
  const s = checklistScores(c);
  assert.equal(s.corners, 8); // 10 − 2 × 1,125 = 7,75 → 8
  assert.equal(s.edges, 9);
  assert.equal(s.surface, 7.5);
  c.creases = 'crease';
  assert.equal(checklistScores(c).cap, 4);
  assert.ok(checklistLines(c).some((l) => l.startsWith('Kratzer: ja, 2')));
});
