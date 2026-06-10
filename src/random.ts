import { render } from 'lit';
import type { Movie } from './parser';
import type { Grouper } from './groupers';
import type { StoreAdapter } from './store';
import type { WatchFilter } from './renderer';
import { buildPool, buildGrouperPanel, buildPanelShell, buildWatchRow } from './filters';
import type { PanelShell } from './filters';
import { randomPickerBodyTemplate } from './templates/popup.templates';

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
  let poolCount = 0;
  let extractDisabled = true;

  const shell = buildPanelShell('RANDOM', 'TARGET');
  const { panel, close } = shell;

  const body = document.createElement('div');
  panel.appendChild(body);

  // Pannelli grouper: elementi vivi creati una volta, interpolati nel template.
  const panelEls: HTMLElement[] = [];
  for (const grouper of groupers) {
    const sel = new Set<string>();
    selections.set(grouper.name, sel);
    panelEls.push(buildGrouperPanel(grouper, sel, updatePool, movies).el);
  }

  const watchRow = buildWatchRow(currentWatchFilter, f => {
    currentWatchFilter = f;
    updatePool();
  });

  function onExtract(): void {
    const pool = buildPool(movies, groupers, selections, store, currentWatchFilter);
    if (!pool.length) return;
    const picked = pool[Math.floor(Math.random() * pool.length)];
    close();
    onPick(picked.id);
  }

  function rerenderBody(): void {
    render(randomPickerBodyTemplate(panelEls, watchRow.row, poolCount, extractDisabled, onExtract), body);
  }

  function updatePool(): void {
    const pool = buildPool(movies, groupers, selections, store, currentWatchFilter);
    poolCount = pool.length;
    extractDisabled = pool.length === 0;
    rerenderBody();
  }

  updatePool();

  function setWatchFilter(f: WatchFilter): void {
    currentWatchFilter = f;
    watchRow.setValue(f);
    updatePool();
  }

  return { shell, setWatchFilter };
}
