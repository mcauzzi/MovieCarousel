import { render } from 'lit';
import type { Movie } from './parser';
import { coverUrl } from './utils';
import type { StoreAdapter, WatchStatus, Rating } from './store';
import { showToast } from './toast';
import { modalTemplate } from './templates/modal.templates';
import type { FieldData, ModalHandlers } from './templates/modal.templates';

const modalEl = document.getElementById('modal')!;
const modalContent = document.getElementById('modalContent')!;

// Elemento che aveva il focus prima dell'apertura: vi torna il focus alla chiusura.
let lastFocused: HTMLElement | null = null;

function focusables(): HTMLElement[] {
  return Array.from(
    modalContent.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])'),
  ).filter(el => !el.hasAttribute('disabled'));
}

export function openModal(
  id: number,
  movies: Movie[],
  embeddedImages: Map<string, string>,
  imgDir: string,
  store: StoreAdapter,
  onStatusChange?: () => void
): void {
  const m = movies.find(x => x.id === id);
  if (!m) return;

  const meta: string[] = [];
  if (m.year) meta.push(String(m.year));
  if (m['running-time']) meta.push(m['running-time'] + ' min');
  if (m.nationality?.length) meta.push(m.nationality.join(', '));

  const fields: FieldData[] = [];
  function addField(label: string, val: unknown, pills = false): void {
    if (!val) return;
    const arr = Array.isArray(val) ? (val as string[]) : [String(val)];
    if (!arr.length) return;
    fields.push({ label, values: arr, pills });
  }
  addField('Regista', m.director);
  addField('Genere', m.genre, true);
  addField('Studio', m.studio);
  addField('Sceneggiatura', m.writer);
  addField('Musiche', m.composer);
  addField('Produttore', m.producer);
  addField('Lingue', m.language, true);

  const data = {
    movie: m,
    url: coverUrl(m, embeddedImages, imgDir),
    meta: meta.join(' · '),
    fields,
    cast: m.cast ?? [],
  };

  let status = store.getStatus(id);
  let rating = store.getRating(id);

  const rerender = (): void => { render(modalTemplate(data, { status, rating }, handlers), modalContent); };

  const handlers: ModalHandlers = {
    onClose: closeModal,
    onStatus: (v: WatchStatus) => {
      status = v;
      store.setStatus(id, v);
      showToast(v === 'seen' ? 'TARGET NEUTRALIZED' : v === 'watchlist' ? 'ADDED TO WATCHLIST' : 'TARGET CLEARED');
      onStatusChange?.();
      rerender();
    },
    onRating: (i: number) => {
      rating = (rating === i ? null : i) as Rating;
      store.setRating(id, rating);
      showToast('INTEL UPDATED');
      onStatusChange?.();
      rerender();
    },
  };

  rerender();
  // Riparti dall'inizio: senza questo il nuovo modal eredita lo scroll del
  // precedente (plot lungo + cast) e si apre già a metà pagina.
  modalContent.scrollTop = 0;
  modalEl.classList.add('show');
  document.body.style.overflow = 'hidden';
  // Sposta il focus dentro il dialog (e ricordati da dove veniva, per ripristinarlo).
  lastFocused = document.activeElement as HTMLElement | null;
  focusables()[0]?.focus();
}

export function closeModal(): void {
  modalEl.classList.remove('show');
  document.body.style.overflow = '';
  lastFocused?.focus();
  lastFocused = null;
}

// Focus trap: con il dialog aperto, Tab/Shift+Tab restano dentro al modal.
modalContent.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const items = focusables();
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
});

modalEl.addEventListener('click', e => { if (e.target === modalEl) closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !modalEl.classList.contains('show')) return;
  // Se un popup (FILTRI/RANDOM) è aperto sopra al modal, lascia che gestisca lui
  // l'Escape: chiude solo l'overlay in cima, non entrambi insieme.
  if (document.querySelector('.random-backdrop.show')) return;
  closeModal();
});
