// KI-Grading über Claude (Vision). Wird vom Worker für POST /api/ai-grade genutzt.
// Vorder- und Rückseite werden in EINER Anfrage gemeinsam bewertet (stimmige Gesamtnote).
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

export const GradeSchema = z.object({
  defects: z.array(
    z.object({
      side: z.enum(['front', 'back']),
      cat: z.enum(['surface', 'corner', 'edge']),
      kind: z.string(),
      sev: z.number().int(),
      x: z.number(),
      y: z.number(),
      note: z.string(),
    }),
  ),
  checklist: z.object({
    scratches: z.boolean(),
    scratchCount: z.number().int(),
    scratchWhere: z.string(),
    edgeWhitening: z.enum(['none', 'light', 'medium', 'heavy']),
    edgeWhiteningSpots: z.number().int(),
    cornerWhitening: z.number().int(),
    holoDamage: z.enum(['none', 'light_scratches', 'wear', 'dents', 'not_holo']),
    creases: z.enum(['none', 'slight_bend', 'crease']),
    dents: z.number().int(),
    stains: z.boolean(),
    printLines: z.boolean(),
  }),
  subgrades: z.object({ corners: z.number(), edges: z.number(), surface: z.number() }),
  summaryFront: z.string(),
  summaryBack: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
});

const SYSTEM = `Du bist ein erfahrener Grader für Pokémon-Sammelkarten (Maßstab: PSA/CGC/BGS).
Du bekommst Fotos der Vorderseite und/oder Rückseite EINER Karte. Jedes Foto wurde bereits perspektivisch entzerrt:
die Karte füllt das Bild mit etwa 4 % Rand. Vor jedem Foto steht, welche Seite es zeigt.
Aufgabe: sichtbare Mängel finden und den Zustand der ganzen Karte einschätzen. Sei genau und eher streng, erfinde aber nichts:
melde nur, was im Foto erkennbar ist. Spiegelungen, Hüllen, Staub auf dem Foto und Bildrauschen sind keine Mängel.
Weißung an Kanten und Ecken ist auf der (blauen) Rückseite meist besser sichtbar – prüfe sie dort besonders.
- defects: jeder Mangel einzeln. side: front oder back. cat: surface (Fläche/Holo), corner (Ecke), edge (Kante).
  kind: kurzer deutscher Begriff (z. B. "Kratzer", "Weißung", "Holo-Kratzer", "Delle", "Knick", "Fleck", "Druckfehler").
  sev: 1 leicht, 2 mittel, 3 stark. x, y: Position der Mangelmitte als Anteil von Breite/Höhe des jeweiligen Fotos (0 bis 1).
  note: kurze deutsche Beschreibung, wo und wie.
- checklist: Gesamtbild beider Seiten zusammen. cornerWhitening = Anzahl betroffener Ecken (0-4, eine Ecke zählt einmal,
  auch wenn sie vorne und hinten weiß ist). scratchCount = Kratzer insgesamt; scratchWhere: wo (vorne/hinten, Bereich).
  holoDamage = not_holo, wenn die Vorderseite keine Holo-Fläche hat.
- subgrades: Ecken, Kanten, Oberfläche je 1-10 (halbe Noten erlaubt) für die ganze Karte.
- summaryFront / summaryBack: je 1-2 deutsche Sätze; leer lassen, wenn diese Seite fehlt.
- confidence: wie sicher du bei dieser Fotoqualität bist.`;

/**
 * @param {{ images?: {side:'front'|'back', image:string}[], image?: string, side?: 'front'|'back', card?: string }} body
 *        image = JPEG base64 ohne Präfix
 * @param {string} apiKey
 */
export async function aiGrade(body, apiKey) {
  const images = Array.isArray(body.images) && body.images.length ? body.images : [{ side: body.side === 'back' ? 'back' : 'front', image: body.image }];
  const content = [];
  for (const im of images.slice(0, 2)) {
    content.push({ type: 'text', text: im.side === 'back' ? 'Rückseite:' : 'Vorderseite:' });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: im.image } });
  }
  content.push({ type: 'text', text: `Karte${body.card ? ' „' + body.card + '“' : ''}. Bitte bewerten.` });

  const client = new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com' });
  const response = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    output_config: { effort: 'high', format: zodOutputFormat(GradeSchema) },
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') return { error: 'refusal', detail: response.stop_details?.category ?? null };
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: 'invalid_json' };
  }
  const parsed = GradeSchema.safeParse(json);
  if (!parsed.success) return { error: 'invalid_schema' };
  const r = parsed.data;
  const sides = new Set(images.map((i) => i.side));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  r.defects = r.defects
    .filter((d) => sides.has(d.side))
    .map((d) => ({ ...d, sev: clamp(Math.round(d.sev), 1, 3), x: clamp(d.x, 0, 1), y: clamp(d.y, 0, 1) }));
  for (const k of ['corners', 'edges', 'surface']) r.subgrades[k] = clamp(r.subgrades[k], 1, 10);
  r.checklist.cornerWhitening = clamp(r.checklist.cornerWhitening, 0, 4);
  return { result: r, model: response.model, usage: response.usage };
}
