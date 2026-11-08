import { render } from 'lit';
import type { Movie } from './parser';
import type { Grouper } from './groupers';
import type { StoreAdapter } from './store';
import type { WatchFilter } from './renderer';
import { buildPool, buildGrouperPanel, buildPanelShell, buildWatchRow } from './filters';
import type { PanelShell, GrouperPanel } from './filters';
import { filterPopupBodyTemplate } from './templates/popup.templates';

export interface FilterPopupParams {
  movies: Movie[];
  groupers: Grouper[];
  store: StoreAdapter;
  /** Selezioni per grouper, possedute da main.ts: il popup le muta in place. */
  filterSelections: Map<string, Set<string>>;
  watchFilter: WatchFilter;
  onFilterChange: () => void;
  onWatchFilterChange: (f: WatchFilter) => void;
}

let popup: { shell: PanelShell; setWatchFilter: (f: WatchFilter) => void } | null = null;

export function resetFilterPopup(): void {
  popup?.shell.destroy();
  popup = null;
}

export function openFilterPopup(params: FilterPopupParams): void {
  if (!popup) {
    popup = buildFilterPanel(params);
    document.body.appendChild(popup.shell.backdrop);
  } else {
    popup.setWatchFilter(params.watchFilter);
  }
  popup.shell.backdrop.classList.add('show');
}

function buildFilterPanel(params: FilterPopupParams): { shell: PanelShell; setWatchFilter: (f: WatchFilter) => void } {
  const { movies, groupers, store, filterSelections, watchFilter, onFilterChange, onWatchFilterChange } = params;
  let currentWatchFilter: WatchFilter = watchFilter;
  let count = 0;

  const shell = buildPanelShell('FILTRI', 'AVANZATI');
  const { panel } = shell;

  const body = document.createElement('div');
  panel.appendChild(body);

  // Stessi pannelli del random picker, ma le selezioni persistono in main.ts
  // e filtrano la vista principale in tempo reale.
  const panels: GrouperPanel[] = [];
  const panelEls: HTMLElement[] = [];
  for (const grouper of groupers) {
    const sel = filterSelections.get(grouper.name)!;
    const gp = buildGrouperPanel(grouper, sel, () => {
      updateCount();
      onFilterChange();
    }, movies);
    panels.push(gp);
    panelEls.push(gp.el);
  }

  const watchRow = buildWatchRow(currentWatchFilter, f => {
    currentWatchFilter = f;
    updateCount();
    onWatchFilterChange(f);
  });

  function onResetAll(): void {
    panels.forEach(p => p.clearSelection());
    currentWatchFilter = 'all';
    watchRow.setValue('all');
    updateCount();
    // Un solo callback basta: main aggiorna stato visione, badge e vista.
    onWatchFilterChange('all');
  }

  function rerenderBody(): void {
    render(filterPopupBodyTemplate(panelEls, watchRow.row, count, movies.length, onResetAll), body);
  }

  function updateCount(): void {
    count = buildPool(movies, groupers, filterSelections, store, currentWatchFilter).length;
    rerenderBody();
  }

  updateCount();

  function setWatchFilter(f: WatchFilter): void {
    currentWatchFilter = f;
    watchRow.setValue(f);
    updateCount();
  }

  return { shell, setWatchFilter };
}
