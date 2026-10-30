import { html } from 'lit';
import type { TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { cardTemplate } from './card.templates';
import type { CardData } from './card.templates';
import { capTitleTemplate } from './ransom.templates';

/** Dati di una riga/carosello pronti per il rendering. */
export interface RowData {
  /** Chiave stabile del gruppo (per il keying di lit). */
  key: string;
  label: string;
  /** Indice della riga nei gruppi (per numero "Mission" e ritardo animazione). */
  idx: number;
  totalCount: number;
  filtered: CardData[];
}

function scrollCarousel(e: Event, dir: number): void {
  const wrap = (e.currentTarget as HTMLElement).closest('.carousel-wrap');
  const car = wrap?.querySelector('.carousel') as HTMLElement | null;
  if (car) car.scrollBy({ left: dir * car.clientWidth * 0.7, behavior: 'smooth' });
}

// Handler stabili: identità costante tra i render → lit non ri-aggancia i listener.
function scrollPrev(e: Event): void { scrollCarousel(e, -1); }
function scrollNext(e: Event): void { scrollCarousel(e, 1); }

export function rowTemplate(
  row: RowData,
  onCardClick: (e: Event) => void,
  onCardKeydown: (e: KeyboardEvent) => void,
  onImgError: (e: Event) => void
): TemplateResult {
  const num = String(row.idx + 1).padStart(2, '0');
  const delay = Math.min(row.idx * 0.05, 0.4);
  // Header "a calendario": etichetta MISSION + numero grande in contorno, titolo
  // con l'iniziale ritagliata (aria-label: il riquadro non spezza la lettura).
  return html`<section class="row" style="animation-delay:${delay}s">
    <div class="row-header">
      <div class="row-cal" aria-hidden="true"><small>MISSION</small><b>${num}</b></div>
      <h2 class="row-title" aria-label=${row.label}>${capTitleTemplate(row.label)}</h2>
      <div class="row-meta">
        <b>${row.filtered.length}</b>
        <span>${row.filtered.length !== row.totalCount ? '/ ' + row.totalCount + ' targets' : 'targets'}</span>
      </div>
    </div>
    <div class="carousel-wrap">
      <button class="carousel-btn prev" aria-label="Indietro" @click=${scrollPrev}><span>◀</span></button>
      <div class="carousel">${repeat(row.filtered, c => c.movie.id, c => cardTemplate(c, onCardClick, onCardKeydown, onImgError))}</div>
      <button class="carousel-btn next" aria-label="Avanti" @click=${scrollNext}><span>▶</span></button>
    </div>
  </section>`;
}

export function mainTemplate(
  rows: RowData[],
  emptyMsg: string,
  onCardClick: (e: Event) => void,
  onCardKeydown: (e: KeyboardEvent) => void,
  onImgError: (e: Event) => void
): TemplateResult {
  return rows.length
    ? html`${repeat(rows, r => r.key, r => rowTemplate(r, onCardClick, onCardKeydown, onImgError))}`
    : html`<div class="empty">${emptyMsg}</div>`;
}
