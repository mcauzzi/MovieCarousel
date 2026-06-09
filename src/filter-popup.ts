import type { Movie } from './parser';
import type { Grouper } from './groupers';
import type { StoreAdapter } from './store';
import type { WatchFilter } from './renderer';

export interface FilterPopupParams {
  movies: Movie[];
  groupers: Grouper[];
  store: StoreAdapter;
  filterSelections: Map<string, Set<string>>;
  watchFilter: WatchFilter;
  onFilterChange: () => void;
  onWatchFilterChange: (f: WatchFilter) => void;
}

// Shared panel builder — used by both the filter popup and the random picker.
export function buildGrouperPanel(
  grouper: Grouper,
  selectedKeys: Set<string>,
  onSelectionChange: () => void,
  allMovies: Movie[]
): HTMLElement {
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

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'random-search';
  searchInput.placeholder = 'Cerca ' + grouper.label.toLowerCase() + '...';
  body.appendChild(searchInput);

  const listEl = document.createElement('div');
  listEl.className = 'random-list';
  body.appendChild(listEl);

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

  if (noneCount > 0) itemEls.set('__none__', makeListItem('__none__', '— Nessun ' + grouper.label, noneCount, true));
  for (const item of pickerItems) itemEls.set(item.key, makeListItem(item.key, item.label, item.count));

  function renderList(query = ''): void {
    listEl.innerHTML = '';
    const noneEl = itemEls.get('__none__');
    if (noneEl) listEl.appendChild(noneEl);
    for (const item of pickerItems) {
      if (!selectedKeys.has(item.key)) continue;
      if (query && !item.label.toLowerCase().includes(query)) continue;
      listEl.appendChild(itemEls.get(item.key)!);
    }
    for (const item of pickerItems) {
      if (selectedKeys.has(item.key)) continue;
      if (query && !item.label.toLowerCase().includes(query)) continue;
      listEl.appendChild(itemEls.get(item.key)!);
    }
  }

  searchInput.addEventListener('input', () => renderList(searchInput.value.toLowerCase().trim()));

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

let filterBackdropEl: HTMLElement | null = null;
let filterKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
let setFilterWatchFilter: ((f: WatchFilter) => void) | null = null;

export function resetFilterPopup(): void {
  if (filterKeydownHandler) {
    document.removeEventListener('keydown', filterKeydownHandler);
    filterKeydownHandler = null;
  }
  filterBackdropEl?.remove();
  filterBackdropEl = null;
  setFilterWatchFilter = null;
}

export function openFilterPopup(params: FilterPopupParams): void {
  if (!filterBackdropEl) {
    const { backdrop, setWatchFilter } = buildFilterPanel(params);
    filterBackdropEl = backdrop;
    setFilterWatchFilter = setWatchFilter;
    document.body.appendChild(filterBackdropEl);
  } else {
    setFilterWatchFilter?.(params.watchFilter);
  }
  filterBackdropEl.classList.add('show');
}

function buildFilterPanel(params: FilterPopupParams): {
  backdrop: HTMLElement;
  setWatchFilter: (f: WatchFilter) => void;
} {
  const { movies, groupers, filterSelections, watchFilter, onFilterChange, onWatchFilterChange } = params;
  let currentWatchFilter: WatchFilter = watchFilter;

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
  titleEl.innerHTML = 'FILTRI <span class="random-title-accent">AVANZATI</span>';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'random-close';
  closeBtn.textContent = '✕';
  closeBtn.onclick = () => close();

  headerEl.appendChild(titleEl);
  headerEl.appendChild(closeBtn);
  panel.appendChild(headerEl);

  // Groups grid — reuses the same panel builder as the random picker
  const grid = document.createElement('div');
  grid.className = 'random-groups-grid';
  panel.appendChild(grid);

  for (const grouper of groupers) {
    const sel = filterSelections.get(grouper.name)!;
    grid.appendChild(buildGrouperPanel(grouper, sel, onFilterChange, movies));
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
      onWatchFilterChange(opt.value);
    };
    watchBtns.push(btn);
    watchRow.appendChild(btn);
  }
  panel.appendChild(watchRow);

  function close(): void {
    backdrop.classList.remove('show');
  }

  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  filterKeydownHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && backdrop.classList.contains('show')) close();
  };
  document.addEventListener('keydown', filterKeydownHandler);

  function setWatchFilter(f: WatchFilter): void {
    currentWatchFilter = f;
    watchBtns.forEach((b, i) => b.classList.toggle('active', watchOpts[i].value === f));
  }

  return { backdrop, setWatchFilter };
}
