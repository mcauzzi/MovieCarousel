import { html } from 'lit';
import type { TemplateResult } from 'lit';
import type { Movie } from '../parser';
import type { WatchStatus, Rating } from '../store';

export interface FieldData {
  label: string;
  values: string[];
  pills: boolean;
}

export interface ModalData {
  movie: Movie;
  url: string | null;
  meta: string;
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
    html`<button class="watch-btn ${current === d.value ? 'active' : ''}" @click=${() => onPick(d.value)}>${d.label}</button>`
  )}`;
}

export function starsTemplate(current: Rating, onPick: (i: number) => void): TemplateResult {
  return html`<span class="star-rank-label">RANK</span>${[1, 2, 3, 4, 5].map(i =>
    html`<button class="star-btn ${current !== null && i <= current ? 'filled' : ''}" @click=${() => onPick(i)}>★</button>`
  )}`;
}

export function modalTemplate(data: ModalData, state: ModalState, h: ModalHandlers): TemplateResult {
  const m = data.movie;
  const cover = data.url
    ? html`<img src=${data.url} alt=${m.title ?? ''}>`
    : html`<div class="placeholder">${m.title ?? ''}</div>`;
  return html`
    <div class="modal-cover">${cover}</div>
    <div class="modal-body">
      <button class="modal-close" aria-label="Chiudi" @click=${h.onClose}>✕</button>
      <div class="m-eyebrow">▰ TARGET FILE ▰</div>
      <h2>${m.title ?? ''}</h2>
      <div class="m-subtitle">${data.meta}</div>
      <div class="watch-status">${watchButtonsTemplate(state.status, h.onStatus)}</div>
      <div class="star-rank">${starsTemplate(state.rating, h.onRating)}</div>
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
