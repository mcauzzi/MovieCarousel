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
import './style.css';
import JSZip from 'jszip';
import { render as litRender } from 'lit';
import { parseTellicoXml } from './parser';
import type { Movie } from './parser';
import { buildGroupers } from './groupers';
import type { Grouper } from './groupers';
import { renderMain, resetRenderer } from './renderer';
import type { WatchFilter } from './renderer';
import { filterButtonTemplate } from './templates/toolbar.templates';
import { openModal } from './modal';
import { LocalStorageAdapter } from './store';
import type { StoreAdapter, WatchStatus, Rating } from './store';
import { THEMES, applyTheme, getSavedTheme } from './themes';
import { initTransitions, withTransition } from './transitions';
import { initToast } from './toast';
import { openRandomPicker, resetRandomPicker } from './random';
import { openFilterPopup, resetFilterPopup } from './filter-popup';
import { buildPool } from './filters';
import { computeStats, renderStats } from './stats';
import { checkForNewVersion } from './version-check';

// Stato
let movies: Movie[] = [];
let embeddedImages = new Map<string, string>();
let imgDir = '';
let configuredImgDir = '';
let groupers: Grouper[] = [];
let currentGrouper = '';
let searchTerm = '';
let isIntelView = false;
let watchFilter: WatchFilter = 'all';
let filterSelections: Map<string, Set<string>> = new Map();
let searchDebounce: ReturnType<typeof setTimeout> | undefined;

const store: StoreAdapter = new LocalStorageAdapter();
// Sync multi-scheda: se un'altra tab cambia stato/voto, ri-renderizza qui.
store.setOnExternalChange?.(() => { if (movies.length) onMovieChange(); });

// DOM refs
const loaderEl = document.getElementById('loader') as HTMLElement;
const headerEl = document.getElementById('header') as HTMLElement;
const dropZone = document.getElementById('dropZone') as HTMLElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLElement;
const imgDirInput = document.getElementById('imgDir') as HTMLInputElement;

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
const onOpenModal = (id: number) =>
  withTransition(() => openModal(id, movies, embeddedImages, imgDir, store, onMovieChange));

// Chiamato dopo una modifica a stato/voto (dal modal o da un'altra scheda).
// Un cambio di voto può spostare un film tra i gruppi del grouper "Voto",
// quindi ricostruiamo i grouper prima di ri-renderizzare la vista corrente.
function onMovieChange(): void {
  rebuildGroupers();
  if (isIntelView) {
    renderStats(document.getElementById('main')!, computeStats(movies, store));
  } else {
    render();
  }
}

// Ricostruisce i grouper (e quindi i gruppi del "Voto") conservando selezioni
// filtro e grouper corrente; resetta il popup filtri perché cache-a pannelli
// costruiti sui grouper ormai stantii.
function rebuildGroupers(): void {
  if (!groupers.length) return;
  groupers = buildGroupers(movies, store);
  if (!groupers.some(g => g.name === currentGrouper))
    currentGrouper = groupers[0]?.name ?? '';
  const next = new Map<string, Set<string>>();
  for (const g of groupers) next.set(g.name, filterSelections.get(g.name) ?? new Set<string>());
  filterSelections = next;
  resetRandomPicker();
  resetFilterPopup();
  renderGroupButtons();
}

function renderGroupButtons(): void {
  const groupSelect = document.getElementById('groupSelect')!;
  groupSelect.innerHTML = '';
  groupers.forEach(g => {
    const btn = document.createElement('button');
    btn.className = 'group-btn' + (!isIntelView && g.name === currentGrouper ? ' active' : '');
    btn.textContent = g.label;
    btn.dataset.name = g.name;
    btn.onclick = () => {
      currentGrouper = g.name;
      isIntelView = false;
      document.querySelectorAll<HTMLElement>('.group-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.name === g.name));
      document.getElementById('intelBtn')?.classList.remove('active');
      withTransition(() => render());
    };
    groupSelect.appendChild(btn);
  });
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

function initUI(): void {
  resetRenderer();
  resetRandomPicker();
  groupers = buildGroupers(movies, store);
  if (!groupers.length) { setStatus('✕ NO GROUPS', true); return; }
  currentGrouper = groupers[0].name;
  watchFilter = 'all';
  filterSelections = new Map(groupers.map(g => [g.name, new Set<string>()]));
  resetFilterPopup();
  document.getElementById('countLabel')!.textContent = '▰ ' + movies.length + ' targets ▰';

  const groupSelect = document.getElementById('groupSelect')!;
  renderGroupButtons();

  // INTEL tab — nel masthead, separato dai bottoni di raggruppamento
  document.getElementById('intelBtn')?.remove();
  const intelBtn = document.createElement('button');
  intelBtn.id = 'intelBtn';
  intelBtn.className = 'group-btn';
  intelBtn.textContent = 'INTEL';
  intelBtn.onclick = () => {
    isIntelView = true;
    document.querySelectorAll<HTMLElement>('.group-btn').forEach(b => b.classList.remove('active'));
    intelBtn.classList.add('active');
    const stats = computeStats(movies, store);
    withTransition(() => renderStats(document.getElementById('main')!, stats));
  };
  masthead.insertBefore(intelBtn, reloadBtn);

  // Bottone RANDOM nel masthead
  document.getElementById('randomBtn')?.remove();
  const randomBtn = document.createElement('button');
  randomBtn.id = 'randomBtn';
  randomBtn.className = 'group-btn';
  randomBtn.textContent = '◈ RANDOM';
  randomBtn.onclick = () => openRandomPicker({
    movies,
    groupers,
    store,
    initialWatchFilter: watchFilter,
    onPick: id => withTransition(() => openModal(id, movies, embeddedImages, imgDir, store, onMovieChange)),
  });
  masthead.insertBefore(randomBtn, reloadBtn);
  // Riposiziona il dropdown tema a destra di RANDOM, subito prima di reload.
  // Va rifatto a ogni initUI perché i bottoni INTEL/RANDOM vengono ricreati.
  masthead.insertBefore(themeWrap, reloadBtn);

  // Bottone FILTRI — apre il popup filtri avanzati
  document.getElementById('filterBtn')?.remove();
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
  const toolbar = document.querySelector('.toolbar')!;
  toolbar.insertBefore(filterBtn, groupSelect);

  withTransition(() => {
    loaderEl.style.display = 'none';
    headerEl.classList.add('show');
    render();
  });
}

async function handleFile(file: File): Promise<void> {
  setStatus('▶ READING TARGET...');
  try {
    const arrayBuf = await file.arrayBuffer();
    let xmlString: string;
    try {
      const zip = await JSZip.loadAsync(arrayBuf);
      const xmlFile = zip.file('tellico.xml');
      if (!xmlFile) throw new Error('tellico.xml non trovato nello zip');
      xmlString = await xmlFile.async('string');
      setStatus('▶ EXTRACTING DATA...');
    } catch (zipErr) {
      const text = new TextDecoder('utf-8').decode(arrayBuf);
      if (text.trim().startsWith('<?xml') || text.includes('<tellico')) {
        xmlString = text;
        setStatus('▶ PARSING DIRECT XML...');
      } else throw zipErr;
    }
    const result = parseTellicoXml(xmlString);
    if (!result.movies.length) throw new Error('Nessun film trovato');
    movies = result.movies;
    embeddedImages = result.embeddedImages;
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
    setStatus(`✓ ${movies.length} TARGETS ACQUIRED`);
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
  try {
    const res = await fetch('config.json', { cache: 'no-cache' });
    if (res.ok) {
      const cfg = await res.json() as { tcFile?: string; imgDir?: string; title?: string };
      configuredFile = cfg.tcFile ?? null;
      configuredImgDir = cfg.imgDir ?? '';
      if (cfg.title) {
        document.title = cfg.title;
        const loaderH1 = document.querySelector<HTMLElement>('#loader h1');
        if (loaderH1) loaderH1.textContent = cfg.title;
        const accentEl = document.querySelector<HTMLElement>('.masthead .accent');
        if (accentEl) accentEl.textContent = cfg.title;
      }
    }
  } catch (_) { /* config.json assente o non raggiungibile */ }

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

// --- Init ---
initTransitions();
initToast();
applyTheme(getSavedTheme());

// Theme dropdown nel masthead
const masthead = document.querySelector<HTMLElement>('.masthead')!;
const themeWrap = document.createElement('div');
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
themeDropdown.onchange = () => applyTheme(themeDropdown.value);
themeWrap.appendChild(themeDropdown);
const reloadBtn = document.getElementById('reloadBtn')!;
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
  movies = [];
  embeddedImages = new Map();
  imgDir = '';
  groupers = [];
  currentGrouper = '';
  searchTerm = '';
  isIntelView = false;
  watchFilter = 'all';
  filterSelections = new Map();
  resetRandomPicker();
  resetFilterPopup();
  resetRenderer();
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

// Prima il controllo versione: se rileva un bundle stantio ricarica la pagina,
// così evitiamo di lanciare l'auto-load (parsing del .tc) subito prima del reload.
checkForNewVersion().then(reloading => { if (!reloading) tryAutoLoad(); });
