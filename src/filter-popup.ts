import type { Movie } from './parser';
import type { Grouper } from './groupers';
import type { StoreAdapter } from './store';
import type { WatchFilter } from './renderer';
import { buildPool, buildGrouperPanel, buildPanelShell, buildWatchRow } from './filters';
import type { PanelShell, GrouperPanel } from './filters';

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

  const shell = buildPanelShell('FILTRI', 'AVANZATI');
  const { panel } = shell;

  let countEl!: HTMLElement;

  function updateCount(): void {
    const n = buildPool(movies, groupers, filterSelections, store, currentWatchFilter).length;
    countEl.textContent = n + ' / ' + movies.length + ' film';
  }

  // Groups grid — stessi pannelli del random picker, ma le selezioni
  // persistono in main.ts e filtrano la vista principale in tempo reale.
  const grid = document.createElement('div');
  grid.className = 'random-groups-grid';
  panel.appendChild(grid);

  const panels: GrouperPanel[] = [];
  for (const grouper of groupers) {
    const sel = filterSelections.get(grouper.name)!;
    const gp = buildGrouperPanel(grouper, sel, () => {
      updateCount();
      onFilterChange();
    }, movies);
    panels.push(gp);
    grid.appendChild(gp.el);
  }

  // Watch filter row
  const watchRow = buildWatchRow(currentWatchFilter, f => {
    currentWatchFilter = f;
    updateCount();
    onWatchFilterChange(f);
  });
  panel.appendChild(watchRow.row);

  // Footer: conteggio film corrispondenti + reset globale
  const footer = document.createElement('div');
  footer.className = 'random-footer';

  countEl = document.createElement('div');
  countEl.className = 'random-pool-count';

  const resetAllBtn = document.createElement('button');
  resetAllBtn.className = 'group-btn random-reset-btn';
  resetAllBtn.textContent = '✕ Rimuovi tutti i filtri';
  resetAllBtn.onclick = () => {
    panels.forEach(p => p.clearSelection());
    currentWatchFilter = 'all';
    watchRow.setValue('all');
    updateCount();
    // Un solo callback basta: main aggiorna stato visione, badge e vista.
    onWatchFilterChange('all');
  };

  footer.appendChild(countEl);
  footer.appendChild(resetAllBtn);
  panel.appendChild(footer);

  updateCount();

  function setWatchFilter(f: WatchFilter): void {
    currentWatchFilter = f;
    watchRow.setValue(f);
    updateCount();
  }

  return { shell, setWatchFilter };
}
