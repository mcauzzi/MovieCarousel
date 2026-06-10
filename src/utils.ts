export interface MovieForCover {
  cover?: string;
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
