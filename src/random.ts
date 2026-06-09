import type { Movie } from './parser';
import type { Grouper } from './groupers';
import type { StoreAdapter } from './store';
import type { WatchFilter } from './renderer';
import { buildGrouperPanel } from './filter-popup';

interface PickerParams {
  movies: Movie[];
  groupers: Grouper[];
  store: StoreAdapter;
  initialWatchFilter: WatchFilter;
  onPick: (id: number) => void;
}

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

let backdropEl: HTMLElement | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let setPickerWatchFilter: ((f: WatchFilter) => void) | null = null;

export function resetRandomPicker(): void {
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }
  backdropEl?.remove();
  backdropEl = null;
  setPickerWatchFilter = null;
}

export function openRandomPicker(params: PickerParams): void {
  if (!backdropEl) {
    const { backdrop, setWatchFilter } = buildPicker(params);
    backdropEl = backdrop;
    setPickerWatchFilter = setWatchFilter;
    document.body.appendChild(backdropEl);
  } else {
    setPickerWatchFilter?.(params.initialWatchFilter);
  }
  backdropEl.classList.add('show');
}


function buildPicker(params: PickerParams): { backdrop: HTMLElement; setWatchFilter: (f: WatchFilter) => void } {
  const { movies, groupers, store, initialWatchFilter, onPick } = params;

  const selections = new Map<string, Set<string>>();
  let currentWatchFilter: WatchFilter = initialWatchFilter;

  const backdrop = document.createElement('div');
  backdrop.className = 'random-backdrop';

  const panel = document.createElement('div');
  panel.className = 'random-panel';
  backdrop.appendChild(panel);

  // Header
  const headerEl = document.createElement('div');
  headerEl.className = 'random-header';

  const titleEl = document.createElement('div');
  titleEl.className = 'random-title';
  titleEl.innerHTML = 'RANDOM <span class="random-title-accent">TARGET</span>';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'random-close';
  closeBtn.textContent = '✕';
  closeBtn.onclick = () => close();

  headerEl.appendChild(titleEl);
  headerEl.appendChild(closeBtn);
  panel.appendChild(headerEl);

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
    grid.appendChild(buildGrouperPanel(grouper, selections.get(grouper.name)!, updatePool, movies));
  }

  // Watch filter row
  const watchRow = document.createElement('div');
  watchRow.className = 'random-watch-row';

  const watchLabel = document.createElement('span');
  watchLabel.className = 'random-watch-label';
  watchLabel.textContent = 'VISIONE';
  watchRow.appendChild(watchLabel);

  const watchOpts: { label: string; value: WatchFilter }[] = [
    { label: 'TUTTI', value: 'all' },
    { label: 'VISTI', value: 'seen' },
    { label: 'NON VISTI', value: 'unseen' },
  ];
  const watchBtns: HTMLButtonElement[] = [];
  for (const opt of watchOpts) {
    const btn = document.createElement('button');
    btn.className = 'group-btn' + (currentWatchFilter === opt.value ? ' active' : '');
    btn.textContent = opt.label;
    btn.onclick = () => {
      currentWatchFilter = opt.value;
      watchBtns.forEach((b, i) => b.classList.toggle('active', watchOpts[i].value === opt.value));
      updatePool();
    };
    watchBtns.push(btn);
    watchRow.appendChild(btn);
  }
  panel.appendChild(watchRow);

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

  function close(): void {
    backdrop.classList.remove('show');
  }

  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  keydownHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && backdrop.classList.contains('show')) close();
  };
  document.addEventListener('keydown', keydownHandler);

  updatePool();

  function setWatchFilter(f: WatchFilter): void {
    currentWatchFilter = f;
    watchBtns.forEach((b, i) => b.classList.toggle('active', watchOpts[i].value === f));
    updatePool();
  }

  return { backdrop, setWatchFilter };
}
