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

function buildGrouperPanel(
  grouper: Grouper,
  selectedKeys: Set<string>,
  onSelectionChange: () => void,
  allMovies: Movie[]
): HTMLElement {
  // Per i grouper field-based costruiamo la lista da tutti i valori reali (no minSize):
  // ogni valore compare, TUTTI seleziona davvero tutti i film.
  interface PickerItem { key: string; label: string; count: number }
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

  // Barra di ricerca
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'random-search';
  searchInput.placeholder = 'Cerca ' + grouper.label.toLowerCase() + '...';
  body.appendChild(searchInput);

  // Lista scrollabile
  const listEl = document.createElement('div');
  listEl.className = 'random-list';
  body.appendChild(listEl);

  // Mappa key → elemento lista (per sincronizzare selezione e chip)
  const itemEls = new Map<string, HTMLElement>();

  function makeListItem(key: string, label: string, count: number, isNone = false): HTMLElement {
    const el = document.createElement('div');
    el.className = 'random-list-item' + (isNone ? ' li-none' : '') + (selectedKeys.has(key) ? ' active' : '');

    const labelSpan = document.createElement('span');
    labelSpan.className = 'li-label';
    labelSpan.textContent = label;

    const countSpan = document.createElement('span');
    countSpan.className = 'li-count';
    countSpan.textContent = '×' + count;

    el.appendChild(labelSpan);
    el.appendChild(countSpan);
    el.onclick = () => {
      if (selectedKeys.has(key)) { selectedKeys.delete(key); el.classList.remove('active'); }
      else { selectedKeys.add(key); el.classList.add('active'); }
      renderList(searchInput.value.toLowerCase().trim());
      renderChips();
      onSelectionChange();
    };
    return el;
  }

  // Crea tutti gli elementi (il DOM viene gestito da renderList)
  if (noneCount > 0) itemEls.set('__none__', makeListItem('__none__', '— Nessun ' + grouper.label, noneCount, true));
  for (const item of pickerItems) itemEls.set(item.key, makeListItem(item.key, item.label, item.count));

  function renderList(query = ''): void {
    listEl.innerHTML = '';
    // __none__ sempre in cima
    const noneEl = itemEls.get('__none__');
    if (noneEl) listEl.appendChild(noneEl);
    // Selezionati per primi
    for (const item of pickerItems) {
      if (!selectedKeys.has(item.key)) continue;
      if (query && !item.label.toLowerCase().includes(query)) continue;
      listEl.appendChild(itemEls.get(item.key)!);
    }
    // Poi non selezionati
    for (const item of pickerItems) {
      if (selectedKeys.has(item.key)) continue;
      if (query && !item.label.toLowerCase().includes(query)) continue;
      listEl.appendChild(itemEls.get(item.key)!);
    }
  }

  searchInput.addEventListener('input', () => renderList(searchInput.value.toLowerCase().trim()));

  // Pulsante "Rimuovi selezione" — visibile solo quando c'è qualcosa di selezionato
  const resetRow = document.createElement('div');
  resetRow.className = 'random-quick-row';

  const resetBtn = document.createElement('button');
  resetBtn.className = 'group-btn random-reset-btn';
  resetBtn.textContent = '✕ Rimuovi selezione';
  resetBtn.style.display = selectedKeys.size > 0 ? '' : 'none';
  resetBtn.onclick = () => {
    selectedKeys.clear();
    itemEls.forEach(el => el.classList.remove('active'));
    renderChips();
    onSelectionChange();
  };

  resetRow.appendChild(resetBtn);
  body.appendChild(resetRow);

  function setOpen(open: boolean): void {
    isOpen = open;
    arrowEl.textContent = open ? '▾' : '▸';
    headerEl.classList.toggle('open', open);
    body.style.display = open ? 'flex' : 'none';
    chipsArea.style.display = open ? 'none' : 'flex';
    if (open) { searchInput.value = ''; renderList(); }
  }

  headerEl.onclick = () => setOpen(!isOpen);

  function renderChips(): void {
    resetBtn.style.display = selectedKeys.size > 0 ? '' : 'none';
    chipsArea.innerHTML = '';
    if (selectedKeys.size === 0) {
      const none = document.createElement('span');
      none.className = 'random-no-filter';
      none.textContent = '(nessun filtro)';
      chipsArea.appendChild(none);
      return;
    }
    for (const key of selectedKeys) {
      const label = key === '__none__' ? 'Nessun ' + grouper.label
        : (pickerItems.find(i => i.key === key)?.label ?? key);
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
        itemEls.get(key)?.classList.remove('active');
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
  renderList();
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
