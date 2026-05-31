import type { Movie } from './parser';
import type { StoreAdapter } from './store';
import { escapeHtml } from './utils';

export interface Stats {
  total: number;
  seen: number;
  watchlist: number;
  avgRating: number | null;
  topGenres: [string, number][];
  topDirectors: [string, number][];
  byDecade: [string, number][];
}

export function computeStats(movies: Movie[], store: StoreAdapter): Stats {
  let seen = 0, watchlist = 0, ratingSum = 0, ratingCount = 0;
  for (const m of movies) {
    const s = store.getStatus(m.id);
    if (s === 'seen') seen++;
    else if (s === 'watchlist') watchlist++;
    const r = store.getRating(m.id);
    if (r !== null) { ratingSum += r; ratingCount++; }
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
  };
}

function barHTML(label: string, value: number, max: number): string {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return `<div class="stat-bar-row">
    <div class="stat-bar-label">${escapeHtml(label)}</div>
    <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
    <div class="stat-bar-val">${value}</div>
  </div>`;
}

export function renderStats(container: HTMLElement, stats: Stats): void {
  const seenPct = stats.total > 0 ? Math.round((stats.seen / stats.total) * 100) : 0;
  const genreMax = stats.topGenres[0]?.[1] ?? 1;
  const dirMax = stats.topDirectors[0]?.[1] ?? 1;
  const decadeMax = Math.max(...stats.byDecade.map(([, n]) => n), 1);

  container.innerHTML = `
    <div class="stats-panel">
      <div class="stats-header">
        <div class="row-num-block">★</div>
        <div class="row-text">
          <div class="row-eyebrow">Phantom Intel</div>
          <h2 class="row-title">THIEVES&apos; DEN</h2>
        </div>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-card-val">${stats.total}</div><div class="stat-card-label">TARGETS</div></div>
        <div class="stat-card"><div class="stat-card-val">${stats.seen}</div><div class="stat-card-label">NEUTRALIZED</div></div>
        <div class="stat-card"><div class="stat-card-val">${stats.watchlist}</div><div class="stat-card-label">ON RADAR</div></div>
        <div class="stat-card"><div class="stat-card-val">${stats.avgRating?.toFixed(1) ?? '—'}</div><div class="stat-card-label">AVG RANK</div></div>
      </div>
      <div class="stat-progress-row">
        <div class="stat-progress-label">PROGRESS <span>${seenPct}%</span></div>
        <div class="stat-progress-track"><div class="stat-progress-fill" style="width:${seenPct}%"></div></div>
      </div>
      ${stats.topGenres.length ? `<div class="stats-section"><h3 class="stats-section-title">TOP GENRES</h3>${stats.topGenres.map(([g, n]) => barHTML(g, n, genreMax)).join('')}</div>` : ''}
      ${stats.topDirectors.length ? `<div class="stats-section"><h3 class="stats-section-title">TOP DIRECTORS</h3>${stats.topDirectors.map(([d, n]) => barHTML(d, n, dirMax)).join('')}</div>` : ''}
      ${stats.byDecade.length ? `<div class="stats-section"><h3 class="stats-section-title">BY DECADE</h3>${stats.byDecade.map(([d, n]) => barHTML('ANNI ' + d.replace('s', ''), n, decadeMax)).join('')}</div>` : ''}
    </div>`;
}
