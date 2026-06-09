import type { Movie } from './parser';
import type { Grouper } from './groupers';
import type { StoreAdapter } from './store';
import type { WatchFilter } from './renderer';
import { buildPool, buildGrouperPanel, buildPanelShell, buildWatchRow } from './filters';
import type { PanelShell } from './filters';

interface PickerParams {
  movies: Movie[];
  groupers: Grouper[];
  store: StoreAdapter;
  initialWatchFilter: WatchFilter;
  onPick: (id: number) => void;
}

let picker: { shell: PanelShell; setWatchFilter: (f: WatchFilter) => void } | null = null;

export function resetRandomPicker(): void {
  picker?.shell.destroy();
  picker = null;
}

export function openRandomPicker(params: PickerParams): void {
  if (!picker) {
    picker = buildPicker(params);
    document.body.appendChild(picker.shell.backdrop);
  } else {
    picker.setWatchFilter(params.initialWatchFilter);
  }
  picker.shell.backdrop.classList.add('show');
}

function buildPicker(params: PickerParams): { shell: PanelShell; setWatchFilter: (f: WatchFilter) => void } {
  const { movies, groupers, store, initialWatchFilter, onPick } = params;

  const selections = new Map<string, Set<string>>();
  let currentWatchFilter: WatchFilter = initialWatchFilter;

  const shell = buildPanelShell('RANDOM', 'TARGET');
  const { panel, close } = shell;

  // Groups grid
  const grid = document.createElement('div');
  grid.className = 'random-groups-grid';
  panel.appendChild(grid);

  let poolCountEl!: HTMLElement;
  let extractBtn!: HTMLButtonElement;

  function updatePool(): void {
    const pool = buildPool(movies, groupers, selections, store, currentWatchFilter);
    poolCountEl.textContent = 'Pool: ' + pool.length + ' film';
    extractBtn.disabled = pool.length === 0;
  }

  for (const grouper of groupers) {
    selections.set(grouper.name, new Set());
    grid.appendChild(buildGrouperPanel(grouper, selections.get(grouper.name)!, updatePool, movies).el);
  }

  // Watch filter row
  const watchRow = buildWatchRow(currentWatchFilter, f => {
    currentWatchFilter = f;
    updatePool();
  });
  panel.appendChild(watchRow.row);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'random-footer';

  poolCountEl = document.createElement('div');
  poolCountEl.className = 'random-pool-count';

  extractBtn = document.createElement('button');
  extractBtn.className = 'random-extract-btn';
  extractBtn.textContent = '◈ ESTRAI';
  extractBtn.onclick = () => {
    const pool = buildPool(movies, groupers, selections, store, currentWatchFilter);
    if (!pool.length) return;
    const picked = pool[Math.floor(Math.random() * pool.length)];
    close();
    onPick(picked.id);
  };

  footer.appendChild(poolCountEl);
  footer.appendChild(extractBtn);
  panel.appendChild(footer);

  updatePool();

  function setWatchFilter(f: WatchFilter): void {
    currentWatchFilter = f;
    watchRow.setValue(f);
    updatePool();
  }

  return { shell, setWatchFilter };
}
