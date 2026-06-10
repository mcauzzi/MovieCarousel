import { html } from 'lit';
import type { TemplateResult } from 'lit';
import { cardTemplate } from './card.templates';
import type { CardData } from './card.templates';

/** Dati di una riga/carosello pronti per il rendering. */
export interface RowData {
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

export function rowTemplate(
  row: RowData,
  onCardClick: (id: number) => void,
  onImgError: (id: number) => void
): TemplateResult {
  const num = String(row.idx + 1).padStart(2, '0');
  const delay = Math.min(row.idx * 0.05, 0.4);
  return html`<section class="row" style="animation-delay:${delay}s">
    <div class="row-header">
      <div class="row-num-block">${num}</div>
      <div class="row-text">
        <div class="row-eyebrow">Mission ${num}</div>
        <h2 class="row-title">${row.label}</h2>
      </div>
      <div class="row-meta">
        <span class="big">${row.filtered.length}</span>
        <span class="small">${row.filtered.length !== row.totalCount ? '/ ' + row.totalCount + ' films' : 'films'}</span>
      </div>
    </div>
    <div class="carousel-wrap">
      <button class="carousel-btn prev" aria-label="Indietro" @click=${(e: Event) => scrollCarousel(e, -1)}><span>◀</span></button>
      <div class="carousel">${row.filtered.map(c => cardTemplate(c, onCardClick, onImgError))}</div>
      <button class="carousel-btn next" aria-label="Avanti" @click=${(e: Event) => scrollCarousel(e, 1)}><span>▶</span></button>
    </div>
  </section>`;
}

export function mainTemplate(
  rows: RowData[],
  emptyMsg: string,
  onCardClick: (id: number) => void,
  onImgError: (id: number) => void
): TemplateResult {
  return rows.length
    ? html`${rows.map(r => rowTemplate(r, onCardClick, onImgError))}`
    : html`<div class="empty">${emptyMsg}</div>`;
}
