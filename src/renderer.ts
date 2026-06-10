import { render, nothing } from 'lit';
import type { Movie } from './parser';
import type { Grouper } from './groupers';
import { matchesSearch } from './groupers';
import { coverUrl } from './utils';
import type { StoreAdapter } from './store';
import { mainTemplate } from './templates/row.templates';
import type { RowData } from './templates/row.templates';

type OpenModalFn = (id: number) => void;

/** Filtro per stato di visione applicato alla vista a gruppi. */
export type WatchFilter = 'all' | 'seen' | 'unseen';

// Id dei film la cui copertina ha fallito il caricamento: si renderizzano come
// placeholder e non si ritenta. Persiste tra i render finché non si carica una
// nuova collezione (resetRenderer).
const failedIds = new Set<number>();

interface RenderArgs {
  grouper: Grouper;
  searchTerm: string;
  embeddedImages: Map<string, string>;
  imgDir: string;
  store: StoreAdapter;
  onOpenModal: OpenModalFn;
  watchFilter: WatchFilter;
  allowedIds?: Set<number>;
}

let lastArgs: RenderArgs | null = null;
let rafPending = false;

function onImgError(id: number): void {
  failedIds.add(id);
  // Coalesce: più errori immagine in caricamento producono un solo re-render.
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; doRender(); });
}

function doRender(): void {
  if (!lastArgs) return;
  const { grouper, searchTerm, embeddedImages, imgDir, store, onOpenModal, watchFilter, allowedIds } = lastArgs;
  const rows: RowData[] = [];
  grouper.groups.forEach((g, i) => {
    const filtered = g.movies.filter(m => {
      if (allowedIds && !allowedIds.has(m.id)) return false;
      if (!matchesSearch(m, searchTerm)) return false;
      if (watchFilter === 'seen') return store.getStatus(m.id) === 'seen';
      if (watchFilter === 'unseen') return store.getStatus(m.id) !== 'seen';
      return true;
    });
    if (!filtered.length) return;
    rows.push({
      label: g.label,
      idx: i,
      totalCount: g.movies.length,
      filtered: filtered.map(m => ({
        movie: m,
        url: coverUrl(m, embeddedImages, imgDir),
        status: store.getStatus(m.id),
        failed: failedIds.has(m.id),
      })),
    });
  });
  const emptyMsg = watchFilter === 'seen' ? 'Nessun film visto'
    : watchFilter === 'unseen' ? 'Nessun film da vedere'
    : 'No targets found';
  render(mainTemplate(rows, emptyMsg, onOpenModal, onImgError), document.getElementById('main')!);
}

export function renderMain(
  grouper: Grouper,
  searchTerm: string,
  embeddedImages: Map<string, string>,
  imgDir: string,
  store: StoreAdapter,
  onOpenModal: OpenModalFn,
  watchFilter: WatchFilter = 'all',
  allowedIds?: Set<number>
): void {
  lastArgs = { grouper, searchTerm, embeddedImages, imgDir, store, onOpenModal, watchFilter, allowedIds };
  doRender();
}

/** Azzera lo stato del renderer e svuota #main (su Reload e a ogni nuova collezione). */
export function resetRenderer(): void {
  failedIds.clear();
  lastArgs = null;
  render(nothing, document.getElementById('main')!);
}
