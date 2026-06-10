import { render } from 'lit';
import type { Movie } from './parser';
import type { Grouper } from './groupers';
import type { StoreAdapter } from './store';
import type { WatchFilter } from './renderer';
import { grouperPanelTemplate, watchRowTemplate } from './templates/filters.templates';
import type { PickerItem, GrouperPanelHandlers } from './templates/filters.templates';

/* Building block condivisi tra random picker e popup filtri:
   - buildPool: applica selezioni per grouper + filtro visione a una lista di film
   - buildGrouperPanel: pannello espandibile con ricerca, lista e chip per un grouper
   - buildPanelShell: backdrop + pannello + header con titolo accentato, chiusura (✕, click fuori, Escape)
   - buildWatchRow: riga VISIONE con i toggle TUTTI / VISTI / NON VISTI
   I tre builder costruiscono un elemento radice una volta e vi renderizzano un
   template lit, ri-renderizzandolo allo stato aggiornato a ogni interazione. */

export function buildPool(
  movies: Movie[],
  groupers: Grouper[],
  selections: Map<string, Set<string>>,
  store: StoreAdapter,
  watchFilter: WatchFilter
): Movie[] {
  let pool = [...movies];

  for (const [grouperName, selectedKeys] of selections) {
    if (selectedKeys.size === 0) continue;
    const grouper = groupers.find(g => g.name === grouperName);
    if (!grouper) continue;
    const allowed = new Set<number>();
    if (grouper.field) {
      // Matching diretto sul valore del campo: funziona per tutti i valori,
      // anche quelli sotto minSize che non compaiono nei gruppi del grouper principale.
      const f = grouper.field;
      const selectedValues = new Set([...selectedKeys].filter(k => k !== '__none__'));
      for (const m of movies) {
        const v = m[f];
        const vals = Array.isArray(v) ? v as string[] : (v ? [String(v)] : []);
        if (vals.length === 0) {
          if (selectedKeys.has('__none__')) allowed.add(m.id);
        } else {
          for (const val of vals) { if (selectedValues.has(val)) { allowed.add(m.id); break; } }
        }
      }
    } else {
      for (const group of grouper.groups) {
        if (selectedKeys.has(group.key)) {
          for (const m of group.movies) allowed.add(m.id);
        }
      }
      if (selectedKeys.has('__none__')) {
        const coveredByGrouper = new Set<number>();
        for (const g of grouper.groups) for (const m of g.movies) coveredByGrouper.add(m.id);
        for (const m of movies) if (!coveredByGrouper.has(m.id)) allowed.add(m.id);
      }
    }
    pool = pool.filter(m => allowed.has(m.id));
  }

  if (watchFilter === 'seen') {
    pool = pool.filter(m => store.getStatus(m.id) === 'seen');
  } else if (watchFilter === 'unseen') {
    pool = pool.filter(m => store.getStatus(m.id) !== 'seen');
  }

  return pool;
}

export interface GrouperPanel {
  el: HTMLElement;
  /** Svuota la selezione e aggiorna chip/lista. NON chiama onSelectionChange: decide il chiamante. */
  clearSelection: () => void;
}

export function buildGrouperPanel(
  grouper: Grouper,
  selectedKeys: Set<string>,
  onSelectionChange: () => void,
  allMovies: Movie[]
): GrouperPanel {
  // Per i grouper field-based costruiamo la lista da tutti i valori reali (no minSize):
  // ogni valore compare, TUTTI seleziona davvero tutti i film.
  const pickerItems: PickerItem[] = [];
  let noneCount = 0;

  if (grouper.field) {
    const f = grouper.field;
    const valueMap = new Map<string, number>();
    for (const m of allMovies) {
      const v = m[f];
      const vals = Array.isArray(v) ? v as string[] : (v ? [String(v)] : []);
      if (vals.length === 0) { noneCount++; continue; }
      for (const val of vals) if (val) valueMap.set(val, (valueMap.get(val) ?? 0) + 1);
    }
    for (const [k, cnt] of [...valueMap.entries()].sort((a, b) => b[1] - a[1]))
      pickerItems.push({ key: k, label: k, count: cnt });
  } else {
    const coveredIds = new Set<number>();
    for (const g of grouper.groups) for (const m of g.movies) coveredIds.add(m.id);
    noneCount = allMovies.filter(m => !coveredIds.has(m.id)).length;
    for (const g of grouper.groups) pickerItems.push({ key: g.key, label: g.label, count: g.movies.length });
  }

  const ui = { isOpen: false, query: '' };

  const el = document.createElement('div');
  el.className = 'random-grouper-panel';

  const rerender = (): void => {
    render(
      grouperPanelTemplate({ grouper, pickerItems, noneCount, selectedKeys, isOpen: ui.isOpen, query: ui.query }, handlers),
      el
    );
  };

  const handlers: GrouperPanelHandlers = {
    onToggleItem: (key) => {
      if (selectedKeys.has(key)) selectedKeys.delete(key); else selectedKeys.add(key);
      rerender();
      onSelectionChange();
    },
    onInput: (raw) => { ui.query = raw; rerender(); },
    onToggleOpen: () => { ui.isOpen = !ui.isOpen; if (ui.isOpen) ui.query = ''; rerender(); },
    onChipRemove: (key) => { selectedKeys.delete(key); rerender(); onSelectionChange(); },
    onReset: () => { selectedKeys.clear(); rerender(); onSelectionChange(); },
  };

  function clearSelection(): void {
    selectedKeys.clear();
    rerender();
  }

  rerender();
  return { el, clearSelection };
}

export interface PanelShell {
  backdrop: HTMLElement;
  panel: HTMLElement;
  close: () => void;
  /** Rimuove il listener Escape e stacca il backdrop dal DOM. */
  destroy: () => void;
}

export function buildPanelShell(titleMain: string, titleAccent: string): PanelShell {
  const backdrop = document.createElement('div');
  backdrop.className = 'random-backdrop';

  const panel = document.createElement('div');
  panel.className = 'random-panel';
  backdrop.appendChild(panel);

  const headerEl = document.createElement('div');
  headerEl.className = 'random-header';

  const titleEl = document.createElement('div');
  titleEl.className = 'random-title';
  titleEl.append(titleMain + ' ');
  const accentEl = document.createElement('span');
  accentEl.className = 'random-title-accent';
  accentEl.textContent = titleAccent;
  titleEl.appendChild(accentEl);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'random-close';
  closeBtn.textContent = '✕';
  closeBtn.onclick = () => close();

  headerEl.appendChild(titleEl);
  headerEl.appendChild(closeBtn);
  panel.appendChild(headerEl);

  function close(): void {
    backdrop.classList.remove('show');
  }

  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  const keydownHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && backdrop.classList.contains('show')) close();
  };
  document.addEventListener('keydown', keydownHandler);

  function destroy(): void {
    document.removeEventListener('keydown', keydownHandler);
    backdrop.remove();
  }

  return { backdrop, panel, close, destroy };
}

export interface WatchRow {
  row: HTMLElement;
  /** Aggiorna solo lo stato visivo dei toggle. NON chiama onChange. */
  setValue: (f: WatchFilter) => void;
}

export function buildWatchRow(initial: WatchFilter, onChange: (f: WatchFilter) => void): WatchRow {
  let current = initial;

  const row = document.createElement('div');
  row.className = 'random-watch-row';

  const rerender = (): void => { render(watchRowTemplate(current, onPick), row); };

  function onPick(f: WatchFilter): void {
    current = f;
    rerender();
    onChange(f);
  }

  function setValue(f: WatchFilter): void {
    current = f;
    rerender();
  }

  rerender();
  return { row, setValue };
}
