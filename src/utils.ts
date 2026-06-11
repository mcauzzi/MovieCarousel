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
