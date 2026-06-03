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

export function resetRandomPicker(): void {
  backdropEl?.remove();
  backdropEl = null;
}

export function openRandomPicker(params: PickerParams): void {
  if (!backdropEl) {
    backdropEl = buildPicker(params);
    document.body.appendChild(backdropEl);
  }
  backdropEl.classList.add('show');
}

function buildGrouperPanel(
  grouper: Grouper,
  selectedKeys: Set<string>,
  onSelectionChange: () => void
): HTMLElement {
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
    renderChips();
    onSelectionChange();
  };

  const noneBtn = document.createElement('button');
  noneBtn.className = 'group-btn';
  noneBtn.textContent = 'NESSUNO';
  noneBtn.onclick = () => {
    selectedKeys.clear();
    groupBtns.forEach(b => b.classList.remove('active'));
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
      const group = grouper.groups.find(g => g.key === key);
      if (!group) continue;
      const chip = document.createElement('span');
      chip.className = 'random-chip';

      const chipLabel = document.createElement('span');
      chipLabel.textContent = group.label;

      const chipRemove = document.createElement('button');
      chipRemove.className = 'random-chip-remove';
      chipRemove.textContent = '×';
      chipRemove.onclick = (e) => {
        e.stopPropagation();
        selectedKeys.delete(key);
        groupBtns.get(key)?.classList.remove('active');
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

function buildPicker(_params: PickerParams): HTMLElement {
  return document.createElement('div'); // stub — Task 3
}
