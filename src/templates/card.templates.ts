import { html } from 'lit';
import type { TemplateResult } from 'lit';
import type { Movie } from '../parser';
import type { WatchStatus } from '../store';
import { capTitleTemplate } from './ransom.templates';
import { currentCopy } from '../copy';

/** Dati pronti per il rendering di una card (calcolati dal renderer). */
export interface CardData {
  movie: Movie;
  url: string | null;
  status: WatchStatus;
  failed: boolean;
  /** Poligono "tagliato a mano" della card (clip-path), deterministico per id. */
  clip: string;
  /** Inclinazione base della card in gradi (moltiplicata per --tilt in CSS). */
  tilt: string;
}

/** Copertina finta "da manifesto" quando manca l'immagine o il caricamento fallisce. */
// (L'anno sta già nel tag della card: qui solo titolo ed etichetta.)
export function placeholderTemplate(title: string | undefined): TemplateResult {
  return html`<div class="placeholder">
    <div class="pl-tag">${currentCopy().noCover}</div>
    <div class="pl-title">${title ?? ''}</div>
  </div>`;
}

/* Card "manifesto" P5: stella che esplode dietro (hover/focus), ombra --hot e
   cornice bianca con lo stesso poligono per-card, tag anno, timbro di stato,
   barra titolo inclinata con l'iniziale ritagliata e regista in mono. */
export function cardTemplate(
  data: CardData,
  onCardClick: (e: Event) => void,
  onCardKeydown: (e: KeyboardEvent) => void,
  onImgError: (e: Event) => void
): TemplateResult {
  const { movie: m, url, status, failed, clip, tilt } = data;
  const c = currentCopy();
  const title = m.title ?? '';
  const yr = m.year ? String(m.year) : '';
  const director = Array.isArray(m.director) ? m.director[0] : (m.director ?? '');
  // Handler stabili (id ricavato dal data-id sul .card): identità costante tra i
  // render, così lit non ri-aggancia i listener a ogni re-render.
  // Nome accessibile = tutto il testo visibile della card (titolo per primo):
  // anno, regista e timbro non vanno persi per lo screen reader (WCAG 2.5.3).
  const badge = status === 'seen' ? c.seenBadge : status === 'watchlist' ? c.watchBadge : '';
  const label = [title || 'Dettagli film', yr, director, badge].filter(Boolean).join(', ');
  const cover = url && !failed
    ? html`<img src=${url} alt="" loading="lazy" @error=${onImgError}>`
    : placeholderTemplate(m.title);
  return html`<div class="card" data-id=${m.id} role="button" tabindex="0" style="--clip:${clip};--r:${tilt}deg"
    aria-label=${label} @click=${onCardClick} @keydown=${onCardKeydown}>
    <div class="card-burst" aria-hidden="true"></div>
    <div class="card-shadow" aria-hidden="true"></div>
    <div class="card-frame"><div class="img-wrap">${cover}</div></div>
    ${yr ? html`<div class="card-tag">${yr}</div>` : ''}
    ${status === 'seen' ? html`<div class="card-stamp">${c.seenBadge}</div>` : ''}
    ${status === 'watchlist' ? html`<div class="card-target"><i aria-hidden="true"></i>${c.watchBadge}</div>` : ''}
    <div class="card-bar">${title ? capTitleTemplate(title) : ''}</div>
    ${director ? html`<div class="card-dir">${director}</div>` : ''}
  </div>`;
}
