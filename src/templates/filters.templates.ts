import { html } from 'lit';
import type { TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import type { Grouper } from '../groupers';
import type { WatchFilter } from '../renderer';

export interface PickerItem {
  key: string;
  label: string;
  count: number;
}

export interface GrouperPanelState {
  grouper: Grouper;
  pickerItems: PickerItem[];
  noneCount: number;
  /** Set di chiavi selezionate (posseduto dal chiamante, mutato in place). */
  selectedKeys: Set<string>;
  isOpen: boolean;
  /** Testo grezzo della ricerca (per display nell'input). */
  query: string;
}

export interface GrouperPanelHandlers {
  onToggleItem: (key: string) => void;
  onInput: (raw: string) => void;
  onToggleOpen: () => void;
  onChipRemove: (key: string) => void;
  onReset: () => void;
}

function listItemTemplate(
  key: string,
  label: string,
  count: number,
  isNone: boolean,
  selected: boolean,
  onToggle: (key: string) => void
): TemplateResult {
  return html`<div
    class="random-list-item ${isNone ? 'li-none' : ''} ${selected ? 'active' : ''}"
    @click=${() => onToggle(key)}>
    <span class="li-label">${label}</span>
    <span class="li-count">×${count}</span>
  </div>`;
}

export function grouperPanelTemplate(s: GrouperPanelState, h: GrouperPanelHandlers): TemplateResult {
  const q = s.query.toLowerCase().trim();
  const visible = (i: PickerItem) => !q || i.label.toLowerCase().includes(q);
  const selectedItems = s.pickerItems.filter(i => s.selectedKeys.has(i.key) && visible(i));
  const unselectedItems = s.pickerItems.filter(i => !s.selectedKeys.has(i.key) && visible(i));

  // Lista ordinata (— Nessun — sempre in cima, poi selezionati, poi resto) con
  // chiave stabile per il keying di lit: i nodi vengono riusati invece che
  // ricreati a ogni ricerca/selezione.
  interface ListEntry { key: string; label: string; count: number; isNone: boolean; selected: boolean }
  const entries: ListEntry[] = [];
  if (s.noneCount > 0)
    entries.push({ key: '__none__', label: '— Nessun ' + s.grouper.label, count: s.noneCount, isNone: true, selected: s.selectedKeys.has('__none__') });
  for (const i of selectedItems) entries.push({ key: i.key, label: i.label, count: i.count, isNone: false, selected: true });
  for (const i of unselectedItems) entries.push({ key: i.key, label: i.label, count: i.count, isNone: false, selected: false });

  const chips = s.selectedKeys.size === 0
    ? html`<span class="random-no-filter">(nessun filtro)</span>`
    : [...s.selectedKeys].map(key => {
        const label = key === '__none__'
          ? 'Nessun ' + s.grouper.label
          : (s.pickerItems.find(i => i.key === key)?.label ?? key);
        return html`<span class="random-chip"><span>${label}</span><button
          class="random-chip-remove"
          @click=${(e: Event) => { e.stopPropagation(); h.onChipRemove(key); }}>×</button></span>`;
      });

  return html`
    <div class="random-grouper-header ${s.isOpen ? 'open' : ''}" @click=${h.onToggleOpen}>
      <span class="random-grouper-label">${s.grouper.label.toUpperCase()}</span>
      <span class="random-grouper-arrow">${s.isOpen ? '▾' : '▸'}</span>
    </div>
    <div class="random-chips-area" style="display:${s.isOpen ? 'none' : 'flex'}">${chips}</div>
    <div class="random-grouper-body" style="display:${s.isOpen ? 'flex' : 'none'}">
      <input
        type="text"
        class="random-search"
        placeholder=${'Cerca ' + s.grouper.label.toLowerCase() + '...'}
        .value=${s.query}
        @input=${(e: Event) => h.onInput((e.target as HTMLInputElement).value)}>
      <div class="random-list">
        ${repeat(entries, e => e.key, e => listItemTemplate(e.key, e.label, e.count, e.isNone, e.selected, h.onToggleItem))}
      </div>
      <div class="random-quick-row">
        ${s.selectedKeys.size > 0
          ? html`<button class="group-btn random-reset-btn" @click=${h.onReset}>✕ Rimuovi selezione</button>`
          : ''}
      </div>
    </div>`;
}

export function watchRowTemplate(current: WatchFilter, onPick: (f: WatchFilter) => void): TemplateResult {
  const opts: { label: string; value: WatchFilter }[] = [
    { label: 'TUTTI', value: 'all' },
    { label: 'VISTI', value: 'seen' },
    { label: 'NON VISTI', value: 'unseen' },
  ];
  return html`<span class="random-watch-label">VISIONE</span>${opts.map(o =>
    html`<button class="group-btn ${current === o.value ? 'active' : ''}" @click=${() => onPick(o.value)}>${o.label}</button>`
  )}`;
}
