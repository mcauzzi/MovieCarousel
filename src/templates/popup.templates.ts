import { html } from 'lit';
import type { TemplateResult } from 'lit';

/* I pannelli grouper e la watch row sono elementi DOM vivi (creati una volta
   in filters.ts e gestiti dai propri render lit): vengono interpolati come Node
   nei template, lit li mantiene in posizione senza ricrearli. */

export function randomPickerBodyTemplate(
  panelEls: HTMLElement[],
  watchRowEl: HTMLElement,
  poolCount: number,
  extractDisabled: boolean,
  onExtract: () => void
): TemplateResult {
  return html`
    <div class="random-groups-grid">${panelEls}</div>
    ${watchRowEl}
    <div class="random-footer">
      <div class="random-pool-count">Pool: ${poolCount} film</div>
      <button class="random-extract-btn" ?disabled=${extractDisabled} @click=${onExtract}>◈ ESTRAI</button>
    </div>`;
}

export function filterPopupBodyTemplate(
  panelEls: HTMLElement[],
  watchRowEl: HTMLElement,
  count: number,
  total: number,
  onResetAll: () => void
): TemplateResult {
  return html`
    <div class="random-groups-grid">${panelEls}</div>
    ${watchRowEl}
    <div class="random-footer">
      <div class="random-pool-count">${count} / ${total} film</div>
      <button class="group-btn random-reset-btn" @click=${onResetAll}>✕ Rimuovi tutti i filtri</button>
    </div>`;
}
