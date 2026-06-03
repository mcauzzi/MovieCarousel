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

function buildPicker(_params: PickerParams): HTMLElement {
  return document.createElement('div'); // stub — Task 3
}
