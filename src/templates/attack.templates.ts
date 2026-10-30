import { html } from 'lit';
import type { TemplateResult } from 'lit';
import type { Movie } from '../parser';
import { ransomTemplate } from './ransom.templates';

/* Overlay "ALL-OUT ATTACK!" del RANDOM: prima la raffica (raggi + stelle +
   scritta a lettere ritagliate), poi il biglietto da visita col film estratto.
   Le scritte in ransomTemplate sono aria-hidden: il testo accessibile sta in
   elementi .aoa-sr (visually hidden) affiancati. */

/** Posizioni pseudo-casuali ma deterministiche per le stelle (stessa formula a ogni raffica). */
function starsTemplate(count: number, cls: string): TemplateResult[] {
  return Array.from({ length: count }, (_, i) => html`<i class=${cls}
    style="--w:${40 + (i * 37) % 70}px;--x:${(i * 53) % 92}%;--y:${(i * 31 + 7) % 86}%;--d:${i * 45}ms"></i>`);
}

export function attackBurstTemplate(): TemplateResult {
  return html`
    <div class="aoa-stars" aria-hidden="true">${starsTemplate(11, 'aoa-star')}</div>
    <div class="aoa-txt">${ransomTemplate('All-out')}${ransomTemplate('attack!')}<span class="aoa-sr">All-out attack!</span></div>`;
}

export interface CallingCardData {
  movie: Movie;
  /** URL della copertina, null se assente o se il caricamento è fallito. */
  cover: string | null;
  poolCount: number;
}

export interface CallingCardHandlers {
  onOpen: () => void;
  onRetry: () => void;
  onEdit: () => void;
  onClose: () => void;
  onCoverError: () => void;
}

/** Titolo come lettera anonima, una parola per ritaglio: va a capo tra le
 *  parole invece che a metà parola. Titoli lunghi → corpo più piccolo. */
function titleTemplate(title: string): TemplateResult {
  const words = title.split(/\s+/).filter(Boolean);
  const size = title.length > 34 ? 'cc-title-xs' : title.length > 18 ? 'cc-title-sm' : '';
  return html`<div class="cc-title ${size}">${words.map(w => ransomTemplate(w))}</div>`;
}

export function callingCardTemplate(d: CallingCardData, h: CallingCardHandlers): TemplateResult {
  const m = d.movie;
  const title = m.title || 'Senza titolo';
  const minutes = m['running-time'];
  const stolen = typeof minutes === 'number' && minutes > 0
    ? `stasera ti ruberemo ${minutes} minuti di vita con`
    : 'stasera ti ruberemo il tempo con';
  const meta = [m.year ? String(m.year) : '', (m.director ?? []).slice(0, 2).join(', ')].filter(Boolean).join(' · ');

  return html`
    <div class="card-call">
      <div class="cc-emb" aria-hidden="true"></div>
      <p class="cc-line">Gentile spettatore,</p>
      <p class="cc-line">${stolen}</p>
      <div class="cc-film">
        <div class="cc-thumb">${d.cover
          ? html`<img src=${d.cover} alt="" @error=${h.onCoverError}>`
          : html`<span class="cc-thumb-ph" aria-hidden="true">?</span>`}</div>
        <div class="cc-film-txt">
          <h2 class="cc-h">${titleTemplate(title)}<span class="aoa-sr">${title}</span></h2>
          ${meta ? html`<p class="cc-meta">${meta}</p>` : ''}
        </div>
      </div>
      <p class="cc-line">Non potrai opporti.</p>
      <div class="cc-sig">— I LADRI DI PELLICOLE</div>
      <div class="cc-act">
        <button class="cc-btn cc-pri" data-cc="open" @click=${h.onOpen}>APRI SCHEDA</button>
        <button class="cc-btn cc-retry" data-cc="retry" @click=${h.onRetry}
          aria-keyshortcuts="R">↻ RITENTA <kbd aria-hidden="true">R</kbd></button>
      </div>
      <div class="cc-sub">
        <button class="cc-btn cc-sec" @click=${h.onEdit}>MODIFICA</button>
        <button class="cc-btn cc-sec" @click=${h.onClose}>CHIUDI</button>
        <span class="cc-pool">Pool: ${d.poolCount} film</span>
      </div>
    </div>
    <div class="cc-reroll-stars" aria-hidden="true">${starsTemplate(5, 'cc-rstar')}</div>
    <p class="aoa-sr" aria-live="polite">Film estratto: ${title}</p>`;
}
