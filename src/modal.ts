import { render } from 'lit';
import type { Movie, CollectionField } from './parser';
import { coverUrl, focusablesIn, isTrueValue, trapTab } from './utils';
import type { StoreAdapter, WatchStatus, Rating } from './store';
import { showToast } from './toast';
import { currentCopy } from './copy';
import { modalTemplate, cutinTemplate } from './templates/modal.templates';
import type { ExtraFieldData, ExtraValue, FieldData, ModalData, ModalHandlers } from './templates/modal.templates';

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

/** Campi che la scheda mostra già (testata, meta, elenco fisso, trama, cast,
 *  RANK, stato di visione) o che non hanno senso per chi guarda (id, date di
 *  sistema, copertina): esclusi da "Altri campi". */
const SHOWN_FIELDS = new Set([
  'id', 'title', 'cover', 'year', 'running-time', 'nationality', 'plot', 'cast',
  'director', 'genre', 'studio', 'writer', 'composer', 'producer', 'language',
  'rating', 'visto', 'cdate', 'mdate',
]);
/** Tipi mai mostrati in "Altri campi" (le immagini non sono testo). */
const HIDDEN_TYPES = new Set(['image']);

/** Data `AAAA-MM-GG` (o `AAAA-MM`) in formato locale it-IT; il resto invariato. */
function formatDate(v: string): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v.trim());
  if (!m) return v;
  const [, y, mo, d] = m;
  // Costruttore locale (non Date.parse, che leggerebbe AAAA-MM-GG come UTC).
  const date = new Date(Number(y), Number(mo) - 1, d ? Number(d) : 1);
  if (isNaN(date.getTime())) return v;
  return d
    ? date.toLocaleDateString('it-IT')
    : date.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
}

/** Link solo per URL assoluti http/https: `javascript:` & co. restano testo. */
function urlValue(v: string): ExtraValue {
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' || u.protocol === 'https:') return { text: v, href: u.href };
  } catch { /* non è un URL assoluto: testo */ }
  return { text: v };
}

/** Valore di un campo personalizzato formattato per tipo (null = niente da mostrare). */
function extraField(m: Movie, f: CollectionField): ExtraFieldData | null {
  const raw = m[f.name];
  if (raw === undefined || raw === null || raw === '') return null;
  const label = f.title || f.name;

  if (f.type === 'table') {
    // string[][] dal parser; una lista piatta diventa una riga per valore.
    const list = Array.isArray(raw) ? raw : [raw];
    const rows = list
      .map(r => (Array.isArray(r) ? r : [r]).map(c => String(c ?? '').trim()))
      .filter(r => r.some(Boolean));
    return rows.length ? { label, values: [], rows } : null;
  }

  const list = (Array.isArray(raw) ? raw : [raw])
    .filter(v => v !== null && v !== undefined && String(v).trim() !== '');
  let values: ExtraValue[];
  if (f.type === 'bool') {
    // Solo il vero: Tellico non scrive i bool falsi, quindi "No" non compare.
    values = list.some(isTrueValue) ? [{ text: 'Sì' }] : [];
  } else if (f.type === 'url') {
    values = list.map(v => urlValue(String(v).trim()));
  } else if (f.type === 'date') {
    values = list.map(v => ({ text: formatDate(String(v)) }));
  } else {
    values = list.map(v => ({ text: String(v) }));
  }
  return values.length ? { label, values } : null;
}

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
  onStatusChange?: () => void,
  /** Definizioni dei campi della collezione: abilitano la sezione "Altri campi". */
  collectionFields?: CollectionField[]
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

  // "Altri campi": i campi della collezione con un valore che la scheda non
  // mostra già, nell'ordine delle definizioni (senza `fields`, nessuna sezione).
  const extra: ExtraFieldData[] = [];
  for (const f of collectionFields ?? []) {
    if (SHOWN_FIELDS.has(f.name) || HIDDEN_TYPES.has(f.type)) continue;
    const x = extraField(m, f);
    if (x) extra.push(x);
  }

  const data: ModalData = {
    movie: m,
    url: coverUrl(m, embeddedImages, imgDir),
    meta,
    fields,
    cast: m.cast ?? [],
    extra,
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
