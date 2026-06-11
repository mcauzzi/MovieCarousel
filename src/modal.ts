import { render } from 'lit';
import type { Movie } from './parser';
import { coverUrl } from './utils';
import type { StoreAdapter, WatchStatus, Rating } from './store';
import { showToast } from './toast';
import { modalTemplate } from './templates/modal.templates';
import type { FieldData, ModalHandlers } from './templates/modal.templates';

const modalEl = document.getElementById('modal')!;
const modalContent = document.getElementById('modalContent')!;

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
      rerender();
    },
  };

  rerender();
  // Riparti dall'inizio: senza questo il nuovo modal eredita lo scroll del
  // precedente (plot lungo + cast) e si apre già a metà pagina.
  modalContent.scrollTop = 0;
  modalEl.classList.add('show');
  document.body.style.overflow = 'hidden';
}

export function closeModal(): void {
  modalEl.classList.remove('show');
  document.body.style.overflow = '';
}

modalEl.addEventListener('click', e => { if (e.target === modalEl) closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !modalEl.classList.contains('show')) return;
  // Se un popup (FILTRI/RANDOM) è aperto sopra al modal, lascia che gestisca lui
  // l'Escape: chiude solo l'overlay in cima, non entrambi insieme.
  if (document.querySelector('.random-backdrop.show')) return;
  closeModal();
});
