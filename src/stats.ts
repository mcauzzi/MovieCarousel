import { render } from 'lit';
import type { Movie } from './parser';
import type { StoreAdapter } from './store';
import { statsTemplate } from './templates/stats.templates';

export interface Stats {
  total: number;
  seen: number;
  watchlist: number;
  avgRating: number | null;
  topGenres: [string, number][];
  topDirectors: [string, number][];
  byDecade: [string, number][];
  byRating: [number, number][];
}

export function computeStats(movies: Movie[], store: StoreAdapter): Stats {
  let seen = 0, watchlist = 0, ratingSum = 0, ratingCount = 0;
  const ratingCounts = new Map<number, number>();
  for (const m of movies) {
    const s = store.getStatus(m.id);
    if (s === 'seen') seen++;
    else if (s === 'watchlist') watchlist++;
    const r = store.getRating(m.id);
    if (r !== null) { ratingSum += r; ratingCount++; ratingCounts.set(r, (ratingCounts.get(r) ?? 0) + 1); }
  }

  const genreMap = new Map<string, number>();
  const dirMap = new Map<string, number>();
  const decadeMap = new Map<string, number>();
  for (const m of movies) {
    const genres = Array.isArray(m.genre) ? m.genre as string[] : [];
    for (const g of genres) genreMap.set(g, (genreMap.get(g) ?? 0) + 1);
    const dirs = Array.isArray(m.director) ? m.director as string[] : [];
    for (const d of dirs) dirMap.set(d, (dirMap.get(d) ?? 0) + 1);
    if (m.year) {
      const decade = Math.floor((m.year as number) / 10) * 10 + 's';
      decadeMap.set(decade, (decadeMap.get(decade) ?? 0) + 1);
    }
  }

  return {
    total: movies.length,
    seen,
    watchlist,
    avgRating: ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : null,
    topGenres: [...genreMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    topDirectors: [...dirMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    byDecade: [...decadeMap.entries()].sort((a, b) => parseInt(b[0]) - parseInt(a[0])),
    byRating: [...ratingCounts.entries()].sort((a, b) => b[0] - a[0]),
  };
}

export function renderStats(container: HTMLElement, stats: Stats): void {
  render(statsTemplate(stats), container);
}
