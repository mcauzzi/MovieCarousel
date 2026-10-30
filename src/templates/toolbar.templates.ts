import { html } from 'lit';
import type { TemplateResult } from 'lit';
import type { Grouper } from '../groupers';

/** Fumetto bianco frastagliato del masthead: "N TARGETS". */
export function countLabelTemplate(count: number): TemplateResult {
  return html`<b>${count}</b> TARGETS`;
}

export function filterButtonTemplate(count: number): TemplateResult {
  return html`⊞ FILTRI <span class="filter-badge" style="display:${count > 0 ? '' : 'none'}">${count}</span>`;
}

export interface ViewSelectorHandlers {
  onToggle: () => void;
  onSelect: (name: string) => void;
}

export function viewSelectorTemplate(
  groupers: Grouper[],
  currentGrouper: string,
  isOpen: boolean,
  isActive: boolean,
  h: ViewSelectorHandlers
): TemplateResult {
  const current = groupers.find(g => g.name === currentGrouper);
  return html`<div class="view-select ${isOpen ? 'open' : ''}">
    <button
      id="viewBtn"
      class="group-btn view-trigger ${isActive ? 'active' : ''}"
      aria-haspopup="listbox"
      aria-expanded=${isOpen}
      @click=${h.onToggle}>
      <span class="view-label">Vista</span>
      <span class="view-current">${current?.label ?? 'Seleziona'}</span>
      <span class="view-arrow">${isOpen ? '▴' : '▾'}</span>
    </button>
    <div class="view-menu" role="listbox" aria-label="Raggruppa per">
      <div class="view-menu-title">Raggruppa per</div>
      ${groupers.map((g, i) => html`<button
        class="view-option ${g.name === currentGrouper ? 'active' : ''}"
        role="option"
        style="--i:${Math.min(i, 7)};--d:${i * 28}ms"
        aria-selected=${g.name === currentGrouper}
        @click=${() => h.onSelect(g.name)}>
        <span class="view-option-check" aria-hidden="true"></span>
        <span class="view-option-label">${g.label}</span>
        <span class="view-option-count">${g.groups.length}</span>
      </button>`)}
    </div>
  </div>`;
}
