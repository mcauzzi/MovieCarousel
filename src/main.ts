// Font self-hostati (bundlati da Vite): nessuna dipendenza da Google Fonts,
// così l'app funziona anche offline / in LAN sul NAS.
import '@fontsource/bebas-neue/400.css';
import '@fontsource/anton/400.css';
import '@fontsource/oswald/400.css';
import '@fontsource/oswald/500.css';
import '@fontsource/oswald/600.css';
import '@fontsource/oswald/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
// Font dei temi MEMENTO (P3: Barlow Condensed), MAYONAKA (P4: Baloo 2) e TOLUCA
// (sotto): il browser scarica i file solo quando il tema attivo li usa.
import '@fontsource/barlow-condensed/300.css';
import '@fontsource/barlow-condensed/300-italic.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/500-italic.css';
import '@fontsource/barlow-condensed/700-italic.css';
import '@fontsource/baloo-2/600.css';
import '@fontsource/baloo-2/800.css';
// Font del tema TOLUCA (SH2): serif per i titoli, macchina da scrivere per testo e memo.
import '@fontsource/eb-garamond/400.css';
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/eb-garamond/500.css';
import '@fontsource/special-elite/400.css';
import '@fontsource/courier-prime/400.css';
import '@fontsource/courier-prime/700.css';
import './style.css';
import { render as litRender } from 'lit';
import { toCollectionFields } from './parser';
import type { Movie, CollectionField } from './parser';
import { buildGroupers } from './groupers';
import type { Grouper } from './groupers';
import { renderMain, resetRenderer } from './renderer';
import type { WatchFilter } from './renderer';
import { countLabelTemplate, filterButtonTemplate, viewSelectorTemplate } from './templates/toolbar.templates';
import { ransomTemplate } from './templates/ransom.templates';
import { openModal } from './modal';
import { LocalStorageAdapter } from './store';
import type { StoreAdapter, WatchStatus, Rating } from './store';
import { THEMES, applyTheme, getSavedTheme } from './themes';
import { initTransitions, withTransition } from './transitions';
import { initToast, showToast } from './toast';
import { openRandomPicker, resetRandomPicker, refreshRandomPicker } from './random';
import { currentCopy } from './copy';
import type { ThemeCopy } from './copy';
import { openFilterPopup, resetFilterPopup } from './filter-popup';
import { buildPool } from './filters';
import { coverUrl } from './utils';
import { computeStats, renderStats } from './stats';
import { checkForNewVersion } from './version-check';
import { initBgm } from './bgm';
import { readTellicoFile } from './tellico-file';
import { setApiBase, getMe, getCollection, migrateState, goToLogin, SessionExpiredError } from './api';
import type { Me, MigrateRequest } from './api';
import { ApiStoreAdapter } from './api-store';
import { openArrivals, resetArrivals, refreshArrivalsCopy } from './arrivals';
import { confirmDialog, showSessionExpired } from './db-ui';
import { emptyCollectionTemplate } from './templates/db.templates';

// Stato
let movies: Movie[] = [];
let embeddedImages = new Map<string, string>();
let imgDir = '';
let configuredImgDir = '';
let configuredBgmDir = '';
let groupers: Grouper[] = [];
let currentGrouper = '';
let isViewMenuOpen = false;
let searchTerm = '';
let isIntelView = false;
let watchFilter: WatchFilter = 'all';
let filterSelections: Map<string, Set<string>> = new Map();
let searchDebounce: ReturnType<typeof setTimeout> | undefined;
/** Definizioni dei campi: dal parser in modalità .tc, dall'API in modalità DB. */
let collectionFields: CollectionField[] | undefined;
/** Modalità DB (config.json → apiBase): collezione e stato dall'API (§10). */
let dbMode = false;
/** Utente corrente (solo modalità DB). */
let me: Me | null = null;

// Store: localStorage in modalità .tc; in modalità DB lo sostituisce
// ApiStoreAdapter all'avvio (startDbMode), prima di caricare la collezione.
let store: StoreAdapter = new LocalStorageAdapter();
let apiStore: ApiStoreAdapter | null = null;
function useStore(s: StoreAdapter): void {
  store = s;
  // Sync multi-scheda (evento `storage`) o ricarica al ritorno in primo piano
  // (modalità DB): se stato/voto cambiano altrove, ri-renderizza qui.
  s.setOnExternalChange?.(() => { if (s === store && movies.length) onMovieChange(); });
}
useStore(store);

// DOM refs
const loaderEl = document.getElementById('loader') as HTMLElement;
const headerEl = document.getElementById('header') as HTMLElement;
const dropZone = document.getElementById('dropZone') as HTMLElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLElement;
const imgDirInput = document.getElementById('imgDir') as HTMLInputElement;
// Usati anche da initUI (riposizionamento del dropdown tema): dichiarati qui,
// prima di ogni funzione che li referenzia, per non dipendere dall'ordine di chiamata.
const masthead = document.querySelector<HTMLElement>('.masthead')!;
const reloadBtn = document.getElementById('reloadBtn')!;
const themeWrap = document.createElement('div');
const loaderTitle = document.querySelector<HTMLElement>('#loader h1');
const imgConfigEl = document.querySelector<HTMLElement>('#loader .img-config');
const mastTitle = document.querySelector<HTMLElement>('.masthead h1');

// Titolo "a lettera anonima" nel loader e nel masthead (.accent). Le lettere
// sono aria-hidden: il nome accessibile va in aria-label sull'h1. Al primo
// render si svuota il testo statico di index.html (lit non lo rimuove da sé).
let titleMounted = false;
function renderTitle(title: string): void {
  const targets: [HTMLElement | null, HTMLElement | null][] = [
    [loaderTitle, loaderTitle],
    [mastTitle, mastTitle?.querySelector<HTMLElement>('.accent') ?? null],
  ];
  for (const [heading, host] of targets) {
    if (!heading || !host) continue;
    if (!titleMounted) host.textContent = '';
    heading.setAttribute('aria-label', title);
    litRender(ransomTemplate(title), host);
  }
  titleMounted = true;
}

// Testi statici di index.html che cambiano col tema: gli elementi con
// data-copy="<chiave>" ricevono la stringa omonima di ThemeCopy.
type CopyTextKey = { [K in keyof ThemeCopy]: ThemeCopy[K] extends string ? K : never }[keyof ThemeCopy];
function applyStaticCopy(): void {
  const c = currentCopy();
  document.querySelectorAll<HTMLElement>('[data-copy]').forEach(el => {
    const text = c[el.dataset.copy as CopyTextKey];
    if (typeof text === 'string') el.textContent = text;
  });
  (document.getElementById('search') as HTMLInputElement).placeholder = c.searchPlaceholder;
}

// Cambio tema: oltre a data-theme aggiorna i testi "di colore" (copy.ts) già a
// schermo. Il picker RANDOM ha il titolo costruito una volta: si rilascia e
// verrà ricostruito alla prossima apertura (un biglietto aperto resta).
function onThemeChange(id: string): void {
  applyTheme(id);
  applyStaticCopy();
  refreshArrivalsCopy();
  if (!headerEl.classList.contains('show')) return;
  litRender(countLabelTemplate(movies.length), document.getElementById('countLabel')!);
  refreshRandomPicker();
  renderView();
}

function setStatus(msg: string, error = false): void {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (error ? ' error' : '');
}

function updateFilterBadge(): void {
  const filterBtn = document.getElementById('filterBtn');
  if (!filterBtn) return;
  const count = [...filterSelections.values()].reduce((sum, s) => sum + s.size, 0)
    + (watchFilter !== 'all' ? 1 : 0);
  litRender(filterButtonTemplate(count), filterBtn);
}

// Riferimento stabile (non ricreato a ogni render): il renderer lo invoca
// tramite un handler stabile, evitando il ri-aggancio dei listener sulle card.
// Niente withTransition: l'apertura ha già il suo cut-in (modal.ts).
const onOpenModal = (id: number) =>
  openModal(id, movies, embeddedImages, imgDir, store, onMovieChange, collectionFields);

// Chiamato dopo una modifica a stato/voto (dal modal o da un'altra scheda).
// Un cambio di voto può spostare un film tra i gruppi del grouper "Voto",
// quindi ricostruiamo i grouper prima di ri-renderizzare la vista corrente.
function onMovieChange(): void {
  rebuildGroupers();
  renderView();
}

/** Ri-renderizza la vista corrente: INTEL, carosello o (modalità DB) collezione vuota. */
function renderView(): void {
  const main = document.getElementById('main')!;
  if (!groupers.length) {
    if (dbMode) litRender(emptyCollectionTemplate(isAdmin()), main);
  } else if (isIntelView) {
    renderStats(main, computeStats(movies, store));
  } else {
    render();
  }
}

function isAdmin(): boolean {
  return !!me?.roles.includes('admin');
}

// Ricostruisce i grouper (e quindi i gruppi del "Voto") conservando selezioni
// filtro e grouper corrente; resetta il popup filtri perché cache-a pannelli
// costruiti sui grouper ormai stantii.
function rebuildGroupers(): void {
  if (!groupers.length) return;
  groupers = buildGroupers(movies, store, collectionFields);
  if (!groupers.some(g => g.name === currentGrouper))
    currentGrouper = groupers[0]?.name ?? '';
  const next = new Map<string, Set<string>>();
  for (const g of groupers) next.set(g.name, filterSelections.get(g.name) ?? new Set<string>());
  filterSelections = next;
  refreshRandomPicker();
  resetFilterPopup();
  renderGroupButtons();
}

function updateToolbarActions(): void {
  document.getElementById('intelBtn')?.classList.toggle('active', isIntelView);
}

function renderGroupButtons(): void {
  const groupSelect = document.getElementById('groupSelect')!;
  litRender(viewSelectorTemplate(
    groupers,
    currentGrouper,
    isViewMenuOpen,
    !isIntelView,
    {
      onToggle: () => {
        isViewMenuOpen = !isViewMenuOpen;
        renderGroupButtons();
      },
      onSelect: name => {
        currentGrouper = name;
        isIntelView = false;
        isViewMenuOpen = false;
        renderGroupButtons();
        withTransition(() => render());
      },
    }
  ), groupSelect);
  updateToolbarActions();
}

function render(): void {
  const grouper = groupers.find(g => g.name === currentGrouper);
  if (!grouper) return;
  isIntelView = false;
  const hasFilter = [...filterSelections.values()].some(s => s.size > 0);
  const allowedIds = hasFilter
    ? new Set(buildPool(movies, groupers, filterSelections, store, 'all').map(m => m.id))
    : undefined;
  renderMain(grouper, searchTerm, embeddedImages, imgDir, store, onOpenModal, watchFilter, allowedIds);
}

/** Costruisce grouper e toolbar per la collezione caricata e mostra la vista.
 *  `preserveView` (Reload in modalità DB, dopo un import): resta su grouper,
 *  filtri, ricerca e INTEL correnti invece di ripartire da zero, senza loader
 *  né transizione. */
function initUI(preserveView = false): void {
  resetRenderer();
  resetRandomPicker();
  const prevGrouper = currentGrouper;
  const prevSelections = filterSelections;
  groupers = buildGroupers(movies, store, collectionFields);
  // In modalità DB una collezione vuota (primo avvio) mostra comunque l'header:
  // l'amministratore deve poter aprire ARRIVI per importarla.
  if (!groupers.length && !dbMode) { setStatus('✕ NO GROUPS', true); return; }
  currentGrouper = preserveView && groupers.some(g => g.name === prevGrouper)
    ? prevGrouper
    : groupers[0]?.name ?? '';
  isViewMenuOpen = false;
  if (!preserveView) {
    watchFilter = 'all';
    isIntelView = false;
  }
  filterSelections = new Map(groupers.map(g => [
    g.name,
    preserveView ? prevSelections.get(g.name) ?? new Set<string>() : new Set<string>(),
  ]));
  resetFilterPopup();
  litRender(countLabelTemplate(movies.length), document.getElementById('countLabel')!);

  renderGroupButtons();
  const toolbar = document.querySelector('.toolbar')!;
  for (const id of ['intelBtn', 'randomBtn', 'filterBtn', 'arrivalsBtn']) document.getElementById(id)?.remove();
  // Mantiene il dropdown tema nel masthead subito prima di reload.
  masthead.insertBefore(themeWrap, reloadBtn);
  // ARRIVI — solo modalità DB e, in questa fase, solo amministratore.
  const arrivalsBtn = dbMode && isAdmin() ? createArrivalsButton() : null;
  if (!groupers.length) {
    if (arrivalsBtn) toolbar.appendChild(arrivalsBtn);
    showView(preserveView);
    return;
  }

  // INTEL tab — azione compatta nella toolbar, separata dal selettore Vista.
  const intelBtn = document.createElement('button');
  intelBtn.id = 'intelBtn';
  intelBtn.className = 'group-btn';
  intelBtn.textContent = 'INTEL';
  intelBtn.onclick = () => {
    isIntelView = true;
    isViewMenuOpen = false;
    renderGroupButtons();
    updateToolbarActions();
    const stats = computeStats(movies, store);
    withTransition(() => renderStats(document.getElementById('main')!, stats));
  };

  // Bottone RANDOM nella toolbar
  const randomBtn = document.createElement('button');
  randomBtn.id = 'randomBtn';
  randomBtn.className = 'group-btn';
  randomBtn.textContent = '◈ RANDOM';
  randomBtn.onclick = () => openRandomPicker({
    movies,
    groupers,
    store,
    initialWatchFilter: watchFilter,
    onPick: onOpenModal,
    coverFor: m => coverUrl(m, embeddedImages, imgDir),
  });

  // Bottone FILTRI — apre il popup filtri avanzati
  const filterBtn = document.createElement('button');
  filterBtn.id = 'filterBtn';
  filterBtn.className = 'group-btn';
  litRender(filterButtonTemplate(0), filterBtn);
  filterBtn.onclick = () => openFilterPopup({
    movies,
    groupers,
    store,
    filterSelections,
    watchFilter,
    onFilterChange: () => {
      updateFilterBadge();
      if (!isIntelView) render();
    },
    onWatchFilterChange: (f) => {
      watchFilter = f;
      updateFilterBadge();
      if (!isIntelView) render();
    },
  });
  toolbar.appendChild(filterBtn);
  toolbar.appendChild(randomBtn);
  toolbar.appendChild(intelBtn);
  if (arrivalsBtn) toolbar.appendChild(arrivalsBtn);
  updateFilterBadge();
  updateToolbarActions();
  showView(preserveView);
}

function showView(preserveView: boolean): void {
  const show = (): void => {
    loaderEl.style.display = 'none';
    headerEl.classList.add('show');
    renderView();
  };
  if (preserveView) show(); else withTransition(show);
}

function createArrivalsButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 'arrivalsBtn';
  btn.className = 'group-btn';
  btn.textContent = '⇣ ARRIVI';
  btn.setAttribute('aria-label', 'ARRIVI');
  btn.onclick = () => openArrivals({
    onImported: () => loadFromApi(true),
    onSessionExpired: () => showSessionExpired(goToLogin),
    returnFocusTo: () => document.getElementById('arrivalsBtn'),
  });
  return btn;
}

async function handleFile(file: File): Promise<void> {
  // In modalità DB la collezione arriva solo dall'API (l'import passa da ARRIVI).
  if (dbMode) return;
  setStatus(currentCopy().statusReading);
  try {
    // Zip (tellico.xml + immagini in images/) o XML grezzo: tellico-file.ts.
    const result = await readTellicoFile(file, phase =>
      setStatus(phase === 'extracting' ? currentCopy().statusExtracting : currentCopy().statusParsing));
    if (!result.movies.length) throw new Error('Nessun film trovato');
    movies = result.movies;
    embeddedImages = result.embeddedImages;
    collectionFields = toCollectionFields(result.fields);
    imgDir = imgDirInput.value || configuredImgDir;
    if (imgDir && !imgDir.endsWith('/')) imgDir += '/';
    // Gli id sono già garantiti numerici dal parser (anche quelli sintetici).
    // Stato di base "visto" dal file .tc: i film con <visto>true</visto> partono come SEEN.
    const seed: Record<number, WatchStatus> = {};
    movies.forEach(m => { if (m.visto === 'true' && typeof m.id === 'number') seed[m.id] = 'seen'; });
    store.setSeed(seed);
    // Voto di base dal file .tc (campo "Valutazione personale", 1-5).
    const ratingSeed: Record<number, Rating> = {};
    movies.forEach(m => {
      if (typeof m.id === 'number' && typeof m.rating === 'number' && m.rating >= 1 && m.rating <= 5)
        ratingSeed[m.id] = m.rating as Rating;
    });
    store.setSeedRating(ratingSeed);
    setStatus(currentCopy().statusLoaded(movies.length));
    setTimeout(() => initUI(), 400);
  } catch (err) {
    console.error(err);
    setStatus('✕ ERROR: ' + (err as Error).message, true);
  }
}

async function tryAutoLoad(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const paramFile = params.get('file');

  let configuredFile: string | null = null;
  let configuredApiBase: string | null = null;
  try {
    const res = await fetch('config.json', { cache: 'no-cache' });
    if (res.ok) {
      const cfg = await res.json() as {
        tcFile?: string; imgDir?: string; title?: string; bgmDir?: string; apiBase?: string;
      };
      configuredFile = cfg.tcFile ?? null;
      configuredApiBase = typeof cfg.apiBase === 'string' && cfg.apiBase.trim() ? cfg.apiBase.trim() : null;
      configuredImgDir = cfg.imgDir ?? '';
      configuredBgmDir = cfg.bgmDir ?? '';
      if (cfg.title) {
        document.title = cfg.title;
        renderTitle(cfg.title);
      }
    }
  } catch (_) { /* config.json assente o non raggiungibile */ }

  // Monta il widget musicale (indipendente dalla collezione): scopre le tracce
  // in bgmDir e si aggancia al masthead. Se non ci sono tracce, è un no-op.
  void initBgm(masthead, themeWrap, configuredBgmDir);

  // apiBase presente ⇒ modalità DB, senza ripiego sul .tc: un'API rotta deve
  // vedersi, non essere nascosta da una collezione locale (§10).
  if (configuredApiBase) {
    await startDbMode(configuredApiBase);
    return;
  }

  const htmlBase = location.pathname.split('/').pop()!.replace(/-p\d+\.html$|\.html$/i, '');
  const autoName = configuredFile ?? (htmlBase || 'collection') + '.tc';
  const candidates = paramFile ? [paramFile] : [autoName];

  for (const name of candidates) {
    try {
      const probe = await fetch(name, { method: 'HEAD', cache: 'no-cache' });
      if (!probe.ok) continue;
      setStatus('▶ AUTO-CARICAMENTO IN CORSO...');
      const res = await fetch(name, { cache: 'no-cache' });
      const blob = await res.blob();
      await handleFile(new File([blob], name, { type: blob.type }));
      return;
    } catch (_) { /* file assente o server non raggiungibile */ }
  }
  setStatus('▶ File .tc non trovato: trascina il file per caricarlo');
}

// --- Modalità DB (§10) ---

function errorText(err: unknown): string {
  return (err as Error)?.message || String(err);
}

/** Errore di una scrittura di stato/voto (già annullata dall'ApiStoreAdapter). */
function onStoreWriteError(err: unknown): void {
  console.error(err);
  if (err instanceof SessionExpiredError) showSessionExpired(goToLogin);
  else showToast('✕ Modifica non salvata: ' + errorText(err));
}

async function startDbMode(apiBase: string): Promise<void> {
  dbMode = true;
  setApiBase(apiBase);
  // Niente drop zone né cartella copertine (imgDir viene da config.json).
  dropZone.hidden = true;
  if (imgConfigEl) imgConfigEl.hidden = true;
  apiStore = new ApiStoreAdapter(onStoreWriteError);
  useStore(apiStore);
  setStatus('▶ CONNESSIONE ALL\'ARCHIVIO...');
  try {
    me = await getMe();
    await loadFromApi(false);
    setStatus(currentCopy().statusLoaded(movies.length));
  } catch (err) {
    // Lettura con sessione scaduta: api.ts sta già navigando al login.
    if (err instanceof SessionExpiredError) { setStatus('▶ ACCESSO IN CORSO...'); return; }
    console.error(err);
    setStatus('✕ ERROR: ' + errorText(err), true);
    return;
  }
  await maybeMigrateLocalChoices(me);
}

/** Carica collezione e stato dall'API e costruisce la vista (nessun seed, §5). */
async function loadFromApi(preserveView: boolean): Promise<void> {
  const [collection] = await Promise.all([getCollection(), apiStore!.load()]);
  movies = collection.movies.filter(m => Number.isFinite(m.id));
  collectionFields = collection.fields;
  embeddedImages = new Map();
  imgDir = configuredImgDir;
  if (imgDir && !imgDir.endsWith('/')) imgDir += '/';
  initUI(preserveView);
}

/** Reload in modalità DB: ricarica dall'API restando nella vista. */
async function reloadFromApi(): Promise<void> {
  if (!apiStore) return;
  resetArrivals();
  try {
    await loadFromApi(true);
    showToast('✓ Collezione ricaricata');
  } catch (err) {
    if (err instanceof SessionExpiredError) return;
    console.error(err);
    showToast('✕ Ricarica non riuscita: ' + errorText(err));
  }
}

/** Override manuali di localStorage (modalità .tc) migrabili: solo valori validi
 *  e non nulli (in modalità DB non c'è seed da sovrascrivere). */
function readLocalChoices(): { data: MigrateRequest; count: number; present: boolean } {
  const data: MigrateRequest = { status: {}, rating: {} };
  let present = false;
  const read = (key: string): Record<string, unknown> => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return {};
      present = true;
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  };
  for (const [id, v] of Object.entries(read('cm_status')))
    if (/^\d+$/.test(id) && (v === 'seen' || v === 'watchlist')) data.status[id] = v;
  for (const [id, v] of Object.entries(read('cm_rating')))
    if (/^\d+$/.test(id) && typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5)
      data.rating[id] = v as 1 | 2 | 3 | 4 | 5;
  const count = Object.keys(data.status).length + Object.keys(data.rating).length;
  return { data, count, present };
}

/** Migrazione una tantum (per utente) delle scelte salvate in questo browser.
 *  Chiede sempre conferma: su un browser condiviso potrebbero essere di altri. */
async function maybeMigrateLocalChoices(user: Me): Promise<void> {
  const flagKey = 'cm_migrated_db:' + user.sub;
  const setFlag = (): void => {
    try { localStorage.setItem(flagKey, new Date().toISOString()); } catch { /* storage non disponibile */ }
  };
  try { if (localStorage.getItem(flagKey) !== null) return; } catch { return; }
  const { data, count, present } = readLocalChoices();
  if (!count) {
    if (present) setFlag();
    return;
  }
  const yes = await confirmDialog({
    title: 'SCELTE',
    accent: 'LOCALI',
    message: `Importare nel tuo profilo ${count} scelte salvate in questo browser?`,
    yesLabel: 'SÌ',
    noLabel: 'NO',
  });
  if (!yes) {
    setFlag();
    showToast('Scelte locali non importate');
    return;
  }
  try {
    const res = await migrateState(data);
    setFlag();
    await apiStore!.load();
    onMovieChange();
    showToast(`✓ ${res.imported} scelte importate nel tuo profilo`);
  } catch (err) {
    // Flag non impostato: la domanda si ripresenterà al prossimo avvio.
    if (err instanceof SessionExpiredError) showSessionExpired(goToLogin);
    else showToast('✕ Importazione non riuscita: ' + errorText(err));
  }
}

// --- Init ---
initTransitions();
initToast();
applyTheme(getSavedTheme());
applyStaticCopy();
// Titolo di default (testo statico di index.html); config.json può sovrascriverlo.
renderTitle(mastTitle?.textContent?.trim() || 'CineManager');

// Theme dropdown nel masthead
themeWrap.className = 'theme-dropdown-wrap';
const themeDropdown = document.createElement('select');
themeDropdown.className = 'theme-dropdown';
themeDropdown.setAttribute('aria-label', 'Tema');
THEMES.forEach(t => {
  const opt = document.createElement('option');
  opt.value = t.id;
  opt.textContent = t.label;
  if (getSavedTheme() === t.id) opt.selected = true;
  themeDropdown.appendChild(opt);
});
themeDropdown.onchange = () => onThemeChange(themeDropdown.value);
themeWrap.appendChild(themeDropdown);
masthead.insertBefore(themeWrap, reloadBtn);

// --- Event listeners ---
fileInput.addEventListener('change', e => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) handleFile(f);
});
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const f = e.dataTransfer?.files[0];
  if (f) handleFile(f);
});
reloadBtn.addEventListener('click', () => {
  if (dbMode) { void reloadFromApi(); return; }
  movies = [];
  embeddedImages = new Map();
  imgDir = '';
  groupers = [];
  currentGrouper = '';
  isViewMenuOpen = false;
  searchTerm = '';
  isIntelView = false;
  watchFilter = 'all';
  filterSelections = new Map();
  resetRandomPicker();
  resetFilterPopup();
  resetArrivals();
  resetRenderer();
  collectionFields = undefined;
  loaderEl.style.display = 'flex';
  headerEl.classList.remove('show');
  setStatus('');
  fileInput.value = '';
  // Svuota anche l'input di ricerca: senza questo mostrerebbe il testo vecchio
  // mentre searchTerm è già azzerato (UI e stato divergerebbero).
  (document.getElementById('search') as HTMLInputElement).value = '';
});
document.getElementById('search')!.addEventListener('input', e => {
  searchTerm = (e.target as HTMLInputElement).value.toLowerCase().trim();
  if (!isIntelView) {
    clearTimeout(searchDebounce);
    // Ricontrolla isIntelView al fire: l'utente potrebbe passare a INTEL/RANDOM
    // entro i 300 ms, e un render() tardivo sovrascriverebbe la vista statistiche.
    searchDebounce = setTimeout(() => { if (!isIntelView) render(); }, 300);
  }
});

document.addEventListener('click', e => {
  if (!isViewMenuOpen) return;
  const groupSelect = document.getElementById('groupSelect');
  if (groupSelect?.contains(e.target as Node)) return;
  isViewMenuOpen = false;
  if (groupers.length) renderGroupButtons();
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !isViewMenuOpen) return;
  isViewMenuOpen = false;
  if (groupers.length) renderGroupButtons();
});

// Prima il controllo versione: se rileva un bundle stantio ricarica la pagina,
// così evitiamo di lanciare l'auto-load (parsing del .tc) subito prima del reload.
checkForNewVersion().then(reloading => { if (!reloading) tryAutoLoad(); });
