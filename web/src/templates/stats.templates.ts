import { html, svg } from 'lit';
import type { TemplateResult } from 'lit';
import type { Stats } from '../stats';
import { ransomTemplate, capTitleTemplate } from './ransom.templates';
import { currentCopy } from '../copy';

// Numero di tacche della barra PROGRESS (stile metro a segmenti P5).
const PROGRESS_SEGMENTS = 20;

/** `srLabel`: testo per gli screen reader quando l'etichetta visiva è grafica
 *  (tacche RANK aria-hidden). Un aria-label su un div generico verrebbe ignorato. */
export function barTemplate(label: string | TemplateResult, value: number, max: number, srLabel?: string): TemplateResult {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return html`<div class="stat-bar-row">
    <div class="stat-bar-label">${label}${srLabel ? html`<span class="visually-hidden">${srLabel}</span>` : ''}</div>
    <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
    <div class="stat-bar-val">${value}</div>
  </div>`;
}

/** Tacche RANK 1–5 (stesse della scheda film) come etichetta delle barre "BY RANK". */
function rankPipsTemplate(r: number): TemplateResult {
  return html`<span class="stat-rank-pips" aria-hidden="true">${[1, 2, 3, 4, 5].map(i =>
    html`<span class="stat-rank-pip ${i <= r ? 'on' : ''}"></span>`)}</span>`;
}

/** Radar "social stats" sui generi principali: ogni asse è un genere, il
 *  raggio è proporzionale al conteggio (max = bordo). Servono almeno 3 assi. */
function radarTemplate(entries: [string, number][]): TemplateResult | string {
  if (entries.length < 3) return '';
  const max = entries[0][1] || 1;
  const n = entries.length;
  const C = 150, R = 92;
  const pt = (i: number, f: number): [number, number] => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [C + Math.cos(a) * R * f, C + Math.sin(a) * R * f];
  };
  const ring = (f: number) => entries.map((_, i) => pt(i, f).join(',')).join(' ');
  const shape = entries.map(([, v], i) => pt(i, v / max).join(',')).join(' ');
  return html`<figure class="stat-radar">
    <svg viewBox="-100 0 500 300" role="img" aria-label=${'Generi principali: ' + entries.map(([g, v]) => `${g} ${v}`).join(', ')}>
      ${[1, 0.66, 0.33].map(f => svg`<polygon class="radar-ring" points=${ring(f)}></polygon>`)}
      ${entries.map((_, i) => { const [x, y] = pt(i, 1); return svg`<line class="radar-axis" x1=${C} y1=${C} x2=${x} y2=${y}></line>`; })}
      <polygon class="radar-shape-shadow" points=${shape} transform="translate(6 6)"></polygon>
      <polygon class="radar-shape" points=${shape}></polygon>
      ${entries.map(([g, v], i) => {
        const [x, y] = pt(i, 1.2);
        const anchor = Math.abs(x - C) < 8 ? 'middle' : x > C ? 'start' : 'end';
        // Etichette lunghe accorciate: il viewBox lascia ~130 unità oltre l'etichetta
        // (nome completo nell'aria-label dell'svg).
        const name = g.length > 13 ? g.slice(0, 12) + '…' : g;
        return svg`<text class="radar-label" x=${x} y=${y} text-anchor=${anchor} dominant-baseline="middle">${name.toUpperCase()} <tspan class="radar-val">${v}</tspan></text>`;
      })}
    </svg>
  </figure>`;
}

export function statsTemplate(stats: Stats): TemplateResult {
  const c = currentCopy();
  const seenPct = stats.total > 0 ? Math.round((stats.seen / stats.total) * 100) : 0;
  const filledSegs = Math.round((seenPct / 100) * PROGRESS_SEGMENTS);
  const genreMax = stats.topGenres[0]?.[1] ?? 1;
  const dirMax = stats.topDirectors[0]?.[1] ?? 1;
  const decadeMax = Math.max(...stats.byDecade.map(([, n]) => n), 1);
  const ratingMax = Math.max(...stats.byRating.map(([, n]) => n), 1);
  const section = (title: string, body: unknown, wide = false) =>
    html`<div class="stats-section ${wide ? 'stats-section-wide' : ''}"><h3 class="stats-section-title" aria-label=${title}>${capTitleTemplate(title)}</h3>${body}</div>`;

  return html`<div class="stats-panel">
    <div class="intel-header">
      <div class="intel-header-stripe"></div>
      <div class="intel-header-content">
        <div class="intel-eyebrow">${c.intelEyebrow}</div>
        <h2 class="intel-title" aria-label=${c.intelTitle}>${ransomTemplate(c.intelTitle)}</h2>
        <div class="intel-subtitle">${c.intelSubtitle}</div>
      </div>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-card-val">${stats.total}</div><div class="stat-card-label">${c.unit.toUpperCase()}</div></div>
      <div class="stat-card"><div class="stat-card-val">${stats.seen}</div><div class="stat-card-label">${c.statSeen}</div></div>
      <div class="stat-card"><div class="stat-card-val">${stats.watchlist}</div><div class="stat-card-label">${c.statWatchlist}</div></div>
      <div class="stat-card"><div class="stat-card-val">${stats.avgRating?.toFixed(1) ?? '—'}</div><div class="stat-card-label">AVG RANK</div></div>
    </div>
    <div class="stat-progress-row">
      <div class="stat-progress-label">${c.statProgress} <span>${seenPct}%</span></div>
      <div class="stat-progress-track" role="progressbar" aria-label="Film visti" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${seenPct}>
        ${Array.from({ length: PROGRESS_SEGMENTS }, (_, i) => html`<span class="stat-seg ${i < filledSegs ? 'on' : ''}"></span>`)}
      </div>
    </div>
    <div class="stats-columns">
      ${stats.topGenres.length ? section('Top genres', html`<div class="stats-genres">${radarTemplate(stats.topGenres)}<div class="stats-genres-bars">${stats.topGenres.map(([g, n]) => barTemplate(g, n, genreMax))}</div></div>`, true) : ''}
      ${stats.topDirectors.length ? section('Top directors', stats.topDirectors.map(([d, n]) => barTemplate(d, n, dirMax))) : ''}
      ${stats.byDecade.length ? section('By decade', stats.byDecade.map(([d, n]) => barTemplate('ANNI ' + d.replace('s', ''), n, decadeMax))) : ''}
      ${stats.byRating.length ? section('By rank', stats.byRating.map(([r, n]) => barTemplate(rankPipsTemplate(r), n, ratingMax, 'Rank ' + r))) : ''}
    </div>
  </div>`;
}
