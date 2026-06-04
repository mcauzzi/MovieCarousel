import type { Movie } from './parser';
import type { Grouper } from './groupers';
import type { StoreAdapter } from './store';
import type { WatchFilter } from './renderer';

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
    for (const group of grouper.groups) {
      if (selectedKeys.has(group.key)) {
        for (const m of group.movies) allowed.add(m.id);
      }
    }
    if (selectedKeys.has('__none__')) {
      const coveredIds = new Set<number>();
      for (const g of grouper.groups) for (const m of g.movies) coveredIds.add(m.id);
      for (const m of movies) if (!coveredIds.has(m.id)) allowed.add(m.id);
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

function buildGrouperPanel(
  grouper: Grouper,
  selectedKeys: Set<string>,
  onSelectionChange: () => void,
  allMovies: Movie[]
): HTMLElement {
  const coveredIds = new Set<number>();
  for (const g of grouper.groups) for (const m of g.movies) coveredIds.add(m.id);
  const noneCount = allMovies.filter(m => !coveredIds.has(m.id)).length;

  let isOpen = false;

  const panel = document.createElement('div');
  panel.className = 'random-grouper-panel';

  const headerEl = document.createElement('div');
  headerEl.className = 'random-grouper-header';

  const labelEl = document.createElement('span');
  labelEl.className = 'random-grouper-label';
  labelEl.textContent = grouper.label.toUpperCase();

  const arrowEl = document.createElement('span');
  arrowEl.className = 'random-grouper-arrow';
  arrowEl.textContent = '▸';

  headerEl.appendChild(labelEl);
  headerEl.appendChild(arrowEl);

  const chipsArea = document.createElement('div');
  chipsArea.className = 'random-chips-area';

  const body = document.createElement('div');
  body.className = 'random-grouper-body';
  body.style.display = 'none';

  const groupBtns = new Map<string, HTMLButtonElement>();
  for (const group of grouper.groups) {
    const btn = document.createElement('button');
    btn.className = 'group-btn';
    btn.textContent = group.label + ' ×' + group.movies.length;
    btn.dataset.key = group.key;
    btn.onclick = () => {
      if (selectedKeys.has(group.key)) {
        selectedKeys.delete(group.key);
        btn.classList.remove('active');
      } else {
        selectedKeys.add(group.key);
        btn.classList.add('active');
      }
      renderChips();
      onSelectionChange();
    };
    groupBtns.set(group.key, btn);
    body.appendChild(btn);
  }

  let noneValueBtn: HTMLButtonElement | null = null;
  if (noneCount > 0) {
    noneValueBtn = document.createElement('button');
    noneValueBtn.className = 'group-btn none-value-btn' + (selectedKeys.has('__none__') ? ' active' : '');
    noneValueBtn.textContent = 'Nessun ' + grouper.label + ' ×' + noneCount;
    noneValueBtn.onclick = () => {
      if (selectedKeys.has('__none__')) {
        selectedKeys.delete('__none__');
        noneValueBtn!.classList.remove('active');
      } else {
        selectedKeys.add('__none__');
        noneValueBtn!.classList.add('active');
      }
      renderChips();
      onSelectionChange();
    };
    body.appendChild(noneValueBtn);
  }

  const quickRow = document.createElement('div');
  quickRow.className = 'random-quick-row';

  const allBtn = document.createElement('button');
  allBtn.className = 'group-btn';
  allBtn.textContent = 'TUTTI';
  allBtn.onclick = () => {
    for (const group of grouper.groups) {
      selectedKeys.add(group.key);
      groupBtns.get(group.key)?.classList.add('active');
    }
    if (noneCount > 0) {
      selectedKeys.add('__none__');
      noneValueBtn?.classList.add('active');
    }
    renderChips();
    onSelectionChange();
  };

  const noneBtn = document.createElement('button');
  noneBtn.className = 'group-btn';
  noneBtn.textContent = 'NESSUNO';
  noneBtn.onclick = () => {
    selectedKeys.clear();
    groupBtns.forEach(b => b.classList.remove('active'));
    noneValueBtn?.classList.remove('active');
    renderChips();
    onSelectionChange();
  };

  quickRow.appendChild(allBtn);
  quickRow.appendChild(noneBtn);
  body.appendChild(quickRow);

  function setOpen(open: boolean): void {
    isOpen = open;
    arrowEl.textContent = open ? '▾' : '▸';
    headerEl.classList.toggle('open', open);
    body.style.display = open ? 'flex' : 'none';
    chipsArea.style.display = open ? 'none' : 'flex';
  }

  headerEl.onclick = () => setOpen(!isOpen);

  function renderChips(): void {
    chipsArea.innerHTML = '';
    if (selectedKeys.size === 0) {
      const none = document.createElement('span');
      none.className = 'random-no-filter';
      none.textContent = '(nessun filtro)';
      chipsArea.appendChild(none);
      return;
    }
    for (const key of selectedKeys) {
      const label = key === '__none__'
        ? 'Nessun ' + grouper.label
        : (grouper.groups.find(g => g.key === key)?.label ?? key);
      const chip = document.createElement('span');
      chip.className = 'random-chip';

      const chipLabel = document.createElement('span');
      chipLabel.textContent = label;

      const chipRemove = document.createElement('button');
      chipRemove.className = 'random-chip-remove';
      chipRemove.textContent = '×';
      chipRemove.onclick = (e) => {
        e.stopPropagation();
        selectedKeys.delete(key);
        if (key === '__none__') noneValueBtn?.classList.remove('active');
        else groupBtns.get(key)?.classList.remove('active');
        renderChips();
        onSelectionChange();
      };

      chip.appendChild(chipLabel);
      chip.appendChild(chipRemove);
      chipsArea.appendChild(chip);
    }
  }

  panel.appendChild(headerEl);
  panel.appendChild(chipsArea);
  panel.appendChild(body);

  setOpen(false);
  renderChips();

  return panel;
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

  const eyebrow = document.createElement('div');
  eyebrow.className = 'random-eyebrow';
  eyebrow.textContent = '▰ SELEZIONE CASUALE';

  const titleEl = document.createElement('div');
  titleEl.className = 'random-title';
  titleEl.innerHTML = 'RANDOM <span class="random-title-accent">TARGET</span>';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'random-close';
  closeBtn.textContent = '✕';
  closeBtn.onclick = () => close();

  headerEl.appendChild(eyebrow);
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
