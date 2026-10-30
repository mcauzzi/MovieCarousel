import { render } from 'lit';
import type { Movie } from './parser';
import { coverUrl, focusablesIn, trapTab } from './utils';
import type { StoreAdapter, WatchStatus, Rating } from './store';
import { showToast } from './toast';
import { currentCopy } from './copy';
import { modalTemplate, cutinTemplate } from './templates/modal.templates';
import type { FieldData, ModalData, ModalHandlers } from './templates/modal.templates';

const modalEl = document.getElementById('modal')!;
const modalContent = document.getElementById('modalContent')!;
// Focusabile da script: durante il cut-in il focus sta sul dialog stesso.
modalContent.tabIndex = -1;

// Cut-in d'apertura: banda --hot che attraversa lo schermo col titolo, sopra al
// backdrop (fuori da #modal, così non eredita la dissolvenza in opacità).
// Solo decorativo: aria-hidden, pointer-events:none via CSS.
const cutinEl = document.createElement('div');
cutinEl.className = 'modal-cutin';
cutinEl.setAttribute('aria-hidden', 'true');
document.body.appendChild(cutinEl);

// Tempi del cut-in (devono combaciare con le animazioni CSS "MODAL — CUT-IN").
const SLAM_AT = 400;    // il dossier sbatte in posizione a metà della banda
const CUTIN_MS = 760;   // durata della banda
let slamTimer = 0;
let cutinTimer = 0;

// Elemento che aveva il focus prima dell'apertura: vi torna il focus alla chiusura.
let lastFocused: HTMLElement | null = null;

/** Ferma un cut-in in corso (timer + banda): riapertura o chiusura non lasciano stati a metà. */
function cancelCutin(): void {
  clearTimeout(slamTimer);
  clearTimeout(cutinTimer);
  cutinEl.classList.remove('go');
}

/** Dossier visibile: parte lo "slam" e il focus va al primo controllo, a meno
 *  che l'utente non si sia già spostato su un controllo durante il cut-in. */
function showDossier(): void {
  modalContent.classList.add('in');
  const active = document.activeElement;
  if (active === modalContent || !modalContent.contains(active)) focusablesIn(modalContent)[0]?.focus();
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

  // Un tag per pezzo; i campi assenti non producono tag.
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

  const data: ModalData = {
    movie: m,
    url: coverUrl(m, embeddedImages, imgDir),
    meta,
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
      const c = currentCopy();
      showToast(v === 'seen' ? c.toastSeen : v === 'watchlist' ? c.toastWatchlist : c.toastCleared);
      onStatusChange?.();
      rerender();
    },
    onRating: (i: number) => {
      rating = (rating === i ? null : i) as Rating;
      store.setRating(id, rating);
      showToast(currentCopy().toastRating);
      onStatusChange?.();
      rerender();
    },
  };

  // Ricordati da dove veniva il focus, per ripristinarlo alla chiusura. Se il
  // modal è già aperto (riapertura su un altro film) teniamo l'origine iniziale.
  if (!modalEl.classList.contains('show')) lastFocused = document.activeElement as HTMLElement | null;
  cancelCutin();
  modalContent.classList.remove('in');
  modalContent.setAttribute('aria-label', m.title || 'Dettagli film');

  rerender();
  // Riparti dall'inizio: senza questo il nuovo modal eredita lo scroll del
  // precedente (plot lungo + cast) e si apre già a metà pagina. Scorre il backdrop.
  modalEl.scrollTop = 0;
  modalEl.classList.add('show');
  document.body.style.overflow = 'hidden';

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { showDossier(); return; }
  // Il focus entra subito nel dialog (trap attivo, la card dietro non riceve
  // più Invio/Spazio); passerà al primo controllo quando il dossier è visibile.
  modalContent.focus({ preventScroll: true });
  // Cut-in: banda col titolo; a metà corsa il dossier sbatte in posizione.
  render(cutinTemplate(m.title ?? ''), cutinEl);
  void cutinEl.offsetWidth; // riavvia l'animazione anche se era già in corso
  cutinEl.classList.add('go');
  slamTimer = window.setTimeout(showDossier, SLAM_AT);
  cutinTimer = window.setTimeout(() => cutinEl.classList.remove('go'), CUTIN_MS);
}

export function closeModal(): void {
  cancelCutin();
  modalEl.classList.remove('show');
  document.body.style.overflow = '';
  lastFocused?.focus();
  lastFocused = null;
}

// Focus trap: con il dialog aperto, Tab/Shift+Tab restano dentro al modal.
modalContent.addEventListener('keydown', e => { if (e.key === 'Tab') trapTab(modalContent, e); });

// Click sul backdrop = chiudi, ma solo a dossier visibile: durante il cut-in il
// dossier è pointer-events:none e un doppio click sulla card (o su APRI SCHEDA)
// finirebbe sul backdrop chiudendo subito la scheda appena aperta.
modalEl.addEventListener('click', e => {
  if (e.target === modalEl && modalContent.classList.contains('in')) closeModal();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !modalEl.classList.contains('show')) return;
  // Se un popup (FILTRI/RANDOM) è aperto sopra al modal, lascia che gestisca lui
  // l'Escape: chiude solo l'overlay in cima, non entrambi insieme.
  if (document.querySelector('.random-backdrop.show')) return;
  closeModal();
});
