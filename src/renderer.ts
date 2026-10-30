import { render, nothing } from 'lit';
import type { Grouper } from './groupers';
import { matchesSearch } from './groupers';
import { coverUrl, seededRandom } from './utils';
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

// Forma "tagliata a mano" per-card (poligono irregolare + inclinazione),
// deterministica dall'id: stessa card, stessa forma a ogni render. Memoizzata
// perché il render ricalcola tutte le card (badge, filtri, ricerca).
interface CardShape { clip: string; tilt: string }
const shapes = new Map<number, CardShape>();

function cardShape(id: number): CardShape {
  let s = shapes.get(id);
  if (!s) {
    const rnd = seededRandom('card' + id);
    const j = (n: number) => (rnd() * n).toFixed(1);
    s = {
      clip: `polygon(${j(4)}% ${j(3)}%, ${(100 - rnd() * 3).toFixed(1)}% ${j(2)}%, 100% ${(100 - rnd() * 4).toFixed(1)}%, ${j(3)}% 100%)`,
      tilt: (rnd() * 4 - 2).toFixed(2),
    };
    shapes.set(id, s);
  }
  return s;
}

let lastArgs: RenderArgs | null = null;
let rafPending = false;

function scheduleRerender(): void {
  // Coalesce: più errori immagine in caricamento producono un solo re-render.
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; doRender(); });
}

// Handler stabili condivisi da tutte le card: l'id si ricava dal data-id sul
// .card, così l'identità delle funzioni non cambia tra i render e lit non
// ri-aggancia i listener (nemmeno sui re-render del badge dal modal).
function cardClick(e: Event): void {
  const id = parseInt((e.currentTarget as HTMLElement).dataset.id!, 10);
  lastArgs?.onOpenModal(id);
}

function imgError(e: Event): void {
  const card = (e.currentTarget as HTMLElement).closest('.card') as HTMLElement | null;
  if (!card) return;
  failedIds.add(parseInt(card.dataset.id!, 10));
  scheduleRerender();
}

// Attiva la card da tastiera: le card sono div con role="button" tabindex="0",
// quindi Enter/Spazio devono comportarsi come un click (Spazio senza scrollare).
function cardKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    cardClick(e);
  }
}

function doRender(): void {
  if (!lastArgs) return;
  const { grouper, searchTerm, embeddedImages, imgDir, store, watchFilter, allowedIds } = lastArgs;
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
      key: g.key,
      label: g.label,
      idx: i,
      totalCount: g.movies.length,
      filtered: filtered.map(m => ({
        movie: m,
        url: coverUrl(m, embeddedImages, imgDir),
        status: store.getStatus(m.id),
        failed: failedIds.has(m.id),
        ...cardShape(m.id),
      })),
    });
  });
  // Stringhe di stato vuoto in italiano, uguali in ogni tema (i testi "di colore"
  // dipendenti dal tema stanno in copy.ts).
  const emptyMsg = watchFilter === 'seen' ? 'Nessun film visto'
    : watchFilter === 'unseen' ? 'Nessun film da vedere'
    : 'Nessun film trovato';
  render(mainTemplate(rows, emptyMsg, cardClick, cardKeydown, imgError), document.getElementById('main')!);
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
  shapes.clear();
  lastArgs = null;
  render(nothing, document.getElementById('main')!);
}
