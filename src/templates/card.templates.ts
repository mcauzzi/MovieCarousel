import { html } from 'lit';
import type { TemplateResult } from 'lit';
import type { Movie } from '../parser';
import type { WatchStatus } from '../store';

/** Dati pronti per il rendering di una card (calcolati dal renderer). */
export interface CardData {
  movie: Movie;
  url: string | null;
  status: WatchStatus;
  failed: boolean;
}

export function placeholderTemplate(title: string | undefined, year: string): TemplateResult {
  return html`<div class="placeholder">
    <div class="pl-title">${title ?? ''}</div>
    ${year ? html`<div class="pl-year">${year}</div>` : ''}
  </div>`;
}

export function cardTemplate(
  data: CardData,
  onCardClick: (e: Event) => void,
  onCardKeydown: (e: KeyboardEvent) => void,
  onImgError: (e: Event) => void
): TemplateResult {
  const { movie: m, url, status, failed } = data;
  const yr = m.year ? String(m.year) : '';
  const director = Array.isArray(m.director) ? m.director[0] : (m.director ?? '');
  // Handler stabili (id ricavato dal data-id sul .card): identità costante tra i
  // render, così lit non ri-aggancia i listener a ogni re-render.
  const cover = url && !failed
    ? html`<img src=${url} alt=${m.title ?? ''} loading="lazy" @error=${onImgError}>`
    : placeholderTemplate(m.title, yr);
  return html`<div class="card" data-id=${m.id} role="button" tabindex="0"
    aria-label=${m.title ?? 'Dettagli film'} @click=${onCardClick} @keydown=${onCardKeydown}>
    <div class="card-inner">
      <div class="img-wrap">${cover}</div>
      <div class="card-overlay">
        <div class="co-title">${m.title ?? ''}</div>
        ${director ? html`<div class="co-meta">${director}</div>` : ''}
      </div>
    </div>
    <div class="card-bar">${m.title ?? ''}</div>
    ${yr ? html`<div class="card-tag">${yr}</div>` : ''}
    ${status
      ? html`<div class="card-status-badge ${status === 'seen' ? 'badge-seen' : 'badge-watchlist'}">${status === 'seen' ? 'SEEN' : '◎'}</div>`
      : ''}
  </div>`;
}
