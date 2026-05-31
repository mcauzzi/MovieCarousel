export interface MovieForCover {
  cover?: string;
}

export function escapeHtml(s: unknown): string {
  if (s == null) return '';
  const map: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  };
  return String(s).replace(/[&<>"']/g, c => map[c] ?? c);
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
