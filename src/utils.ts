export interface MovieForCover {
  cover?: string;
}

/** Valori di un campo Movie normalizzati a `string[]`: array così com'è, scalare
 *  incapsulato, assente → `[]`. Centralizza il pattern ripetuto in filters/groupers/stats. */
export function fieldValues(m: Record<string, unknown>, field: string): string[] {
  const v = m[field];
  if (Array.isArray(v)) return v as string[];
  return v ? [String(v)] : [];
}

/** Chiave del decennio per un anno (es. 1994 → "1990s"). */
export function decadeKey(year: number): string {
  return Math.floor(year / 10) * 10 + 's';
}

export function coverUrl(
  m: MovieForCover,
  embeddedImages: Map<string, string>,
  imgDir: string
): string | null {
  if (!m.cover) return null;
  if (embeddedImages.has(m.cover)) return embeddedImages.get(m.cover)!;
  return imgDir + m.cover;
}

/** Generatore pseudo-casuale deterministico (mulberry32) con seed da stringa:
 *  stesso testo → stessa sequenza. Usato per le composizioni "ransom" e per i
 *  poligoni irregolari delle card, così non cambiano a ogni re-render. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h |= 0;
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
