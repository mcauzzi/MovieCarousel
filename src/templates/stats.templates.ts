import { html } from 'lit';
import type { TemplateResult } from 'lit';
import type { Stats } from '../stats';

export function barTemplate(label: string, value: number, max: number): TemplateResult {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return html`<div class="stat-bar-row">
    <div class="stat-bar-label">${label}</div>
    <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
    <div class="stat-bar-val">${value}</div>
  </div>`;
}

export function statsTemplate(stats: Stats): TemplateResult {
  const seenPct = stats.total > 0 ? Math.round((stats.seen / stats.total) * 100) : 0;
  const genreMax = stats.topGenres[0]?.[1] ?? 1;
  const dirMax = stats.topDirectors[0]?.[1] ?? 1;
  const decadeMax = Math.max(...stats.byDecade.map(([, n]) => n), 1);
  const ratingMax = Math.max(...stats.byRating.map(([, n]) => n), 1);

  return html`<div class="stats-panel">
    <div class="intel-header">
      <div class="intel-header-stripe"></div>
      <div class="intel-header-content">
        <div class="intel-eyebrow">▰ PHANTOM INTEL ▰</div>
        <h2 class="intel-title">THIEVES' DEN</h2>
        <div class="intel-subtitle">ARCHIVE REPORT</div>
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
    ${stats.topGenres.length ? html`<div class="stats-section"><h3 class="stats-section-title">TOP GENRES</h3>${stats.topGenres.map(([g, n]) => barTemplate(g, n, genreMax))}</div>` : ''}
    ${stats.topDirectors.length ? html`<div class="stats-section"><h3 class="stats-section-title">TOP DIRECTORS</h3>${stats.topDirectors.map(([d, n]) => barTemplate(d, n, dirMax))}</div>` : ''}
    ${stats.byDecade.length ? html`<div class="stats-section"><h3 class="stats-section-title">BY DECADE</h3>${stats.byDecade.map(([d, n]) => barTemplate('ANNI ' + d.replace('s', ''), n, decadeMax))}</div>` : ''}
    ${stats.byRating.length ? html`<div class="stats-section"><h3 class="stats-section-title">BY RANK</h3>${stats.byRating.map(([r, n]) => barTemplate('★'.repeat(r), n, ratingMax))}</div>` : ''}
  </div>`;
}
