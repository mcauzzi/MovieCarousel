import { html } from 'lit';
import type { TemplateResult } from 'lit';
import type { Movie } from '../parser';
import type { WatchStatus, Rating } from '../store';
import { ransomTemplate } from './ransom.templates';
import { currentCopy } from '../copy';

export interface FieldData {
  label: string;
  values: string[];
  pills: boolean;
}

export interface ModalData {
  movie: Movie;
  url: string | null;
  /** Pezzi della riga meta (anno, durata, nazione): solo quelli presenti, uno per tag. */
  meta: string[];
  fields: FieldData[];
  cast: { actor: string; role: string }[];
}

export interface ModalState {
  status: WatchStatus;
  rating: Rating;
}

export interface ModalHandlers {
  onClose: () => void;
  onStatus: (v: WatchStatus) => void;
  onRating: (i: number) => void;
}

function fieldTemplate(f: FieldData): TemplateResult {
  return html`<dt>${f.label}</dt><dd>${f.pills
    ? f.values.map(v => html`<span class="pill">${v}</span>`)
    : f.values.join(', ')}</dd>`;
}

export function watchButtonsTemplate(current: WatchStatus, onPick: (v: WatchStatus) => void): TemplateResult {
  const defs: { label: string; value: WatchStatus }[] = [
    { label: 'SEEN', value: 'seen' },
    { label: 'WATCHLIST', value: 'watchlist' },
    { label: '—', value: null },
  ];
  return html`${defs.map(d =>
    html`<button class="watch-btn ${d.value === null ? 'clear' : ''} ${current === d.value ? 'active' : ''}"
      aria-pressed=${current === d.value ? 'true' : 'false'} @click=${() => onPick(d.value)}>${d.label}</button>`
  )}`;
}

/** RANK: numero grande + 5 tacche oblique (stessa scala 1–5, click sul valore attuale = azzera). */
export function rankTemplate(current: Rating, onPick: (i: number) => void): TemplateResult {
  return html`<span class="star-rank-label">RANK</span><span class="rank-num">${current ?? '–'}</span>
    <span class="rank-pips" role="group" aria-label="Voto">${[1, 2, 3, 4, 5].map(i =>
      html`<button class="rank-pip ${current !== null && i <= current ? 'on' : ''}" aria-label="Rank ${i}"
        aria-pressed=${current === i ? 'true' : 'false'} @click=${() => onPick(i)}></button>`
    )}</span>`;
}

export function modalTemplate(data: ModalData, state: ModalState, h: ModalHandlers): TemplateResult {
  const m = data.movie;
  const title = m.title ?? '';
  const c = currentCopy();
  const cover = data.url
    ? html`<img src=${data.url} alt=${title}>`
    : html`<div class="placeholder"><span class="ph-tag">${c.noVisual}</span><span class="ph-title">${title}</span></div>`;
  return html`
    <div class="modal-cover">
      <span class="modal-tape" aria-hidden="true"></span>
      <div class="modal-frame">${cover}</div>
    </div>
    <div class="modal-body">
      <button class="modal-close" aria-label="Chiudi" @click=${h.onClose}>✕</button>
      <div class="m-eyebrow">${c.fileEyebrow(m.id)}</div>
      <h2><span class="visually-hidden">${title}</span>${ransomTemplate(title)}</h2>
      ${data.meta.length ? html`<div class="m-tags">${data.meta.map(t => html`<span class="m-tag">${t}</span>`)}</div>` : ''}
      <div class="m-ctrl">
        <div class="watch-status" role="group" aria-label="Stato visione">${watchButtonsTemplate(state.status, h.onStatus)}</div>
        <div class="star-rank">${rankTemplate(state.rating, h.onRating)}</div>
      </div>
      ${m.plot ? html`<p class="m-plot">${m.plot}</p>` : ''}
      <dl class="modal-meta">${data.fields.map(fieldTemplate)}</dl>
      ${data.cast.length
        ? html`<div class="cast-section"><h3>Cast</h3><div class="cast-list">${
            data.cast.slice(0, 16).map(c =>
              html`<div><span class="actor">${c.actor}</span>${c.role ? html`<span class="role">${c.role}</span>` : ''}</div>`)
          }</div></div>`
        : ''}
    </div>`;
}

/** Banda del cut-in d'apertura: titolo a lettera anonima (decorativo, il nome sta nel dialog). */
export function cutinTemplate(title: string): TemplateResult {
  return html`<div class="modal-cutin-band">${ransomTemplate(title || currentCopy().seenBadge)}</div>`;
}
