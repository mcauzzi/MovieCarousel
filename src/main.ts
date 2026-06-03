import './style.css';
import JSZip from 'jszip';
import { parseTellicoXml } from './parser';
import type { Movie } from './parser';
import { buildGroupers } from './groupers';
import type { Grouper } from './groupers';
import { renderMain, attachHandlers } from './renderer';
import type { WatchFilter } from './renderer';
import { openModal } from './modal';
import { LocalStorageAdapter } from './store';
import type { StoreAdapter, WatchStatus, Rating } from './store';
import { THEMES, applyTheme, getSavedTheme } from './themes';
import { initTransitions, withTransition } from './transitions';
import { initToast } from './toast';
import { openRandomPicker, resetRandomPicker } from './random';
import { computeStats, renderStats } from './stats';

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
let searchDebounce: ReturnType<typeof setTimeout> | undefined;

const store: StoreAdapter = new LocalStorageAdapter();

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

function render(): void {
  const grouper = groupers.find(g => g.name === currentGrouper);
  if (!grouper) return;
  isIntelView = false;
  renderMain(grouper, searchTerm, embeddedImages, imgDir, store, watchFilter);
  attachHandlers(
    movies, embeddedImages, imgDir,
    (id, mvs, embeds, dir) => { withTransition(() => openModal(id, mvs, embeds, dir, store)); }
  );
}

function initUI(): void {
  groupers = buildGroupers(movies, store);
  if (!groupers.length) { setStatus('✕ NO GROUPS', true); return; }
  currentGrouper = groupers[0].name;
  document.getElementById('countLabel')!.textContent = '▰ ' + movies.length + ' targets ▰';

  const groupSelect = document.getElementById('groupSelect')!;
  groupSelect.innerHTML = '';

  groupers.forEach(g => {
    const btn = document.createElement('button');
    btn.className = 'group-btn' + (g.name === currentGrouper ? ' active' : '');
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
    onPick: id => withTransition(() => openModal(id, movies, embeddedImages, imgDir, store)),
  });
  masthead.insertBefore(randomBtn, reloadBtn);

  // Filtri di visione — due toggle mutuamente esclusivi nella toolbar
  document.getElementById('watchFilterBox')?.remove();
  const filterBox = document.createElement('div');
  filterBox.id = 'watchFilterBox';
  filterBox.className = 'filter-box';
  const filterDefs: { label: string; value: Exclude<WatchFilter, 'all'> }[] = [
    { label: '● VISTI',     value: 'seen' },
    { label: '○ NON VISTI', value: 'unseen' },
  ];
  const filterBtns = filterDefs.map(def => {
    const btn = document.createElement('button');
    btn.className = 'group-btn filter-btn' + (watchFilter === def.value ? ' active' : '');
    btn.textContent = def.label;
    btn.onclick = () => {
      // Clic sul filtro attivo lo disattiva; altrimenti diventa l'unico attivo.
      watchFilter = watchFilter === def.value ? 'all' : def.value;
      filterBtns.forEach((b, i) => b.classList.toggle('active', watchFilter === filterDefs[i].value));
      if (!isIntelView) withTransition(() => render());
    };
    filterBox.appendChild(btn);
    return btn;
  });
  const toolbar = document.querySelector('.toolbar')!;
  toolbar.insertBefore(filterBox, groupSelect);

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
    movies.forEach((m, i) => { if (m.id == null) (m as Record<string, unknown>)['id'] = i; });
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

// Theme selector nel masthead
const masthead = document.querySelector<HTMLElement>('.masthead')!;
const themeSelect = document.createElement('div');
themeSelect.className = 'theme-select';
THEMES.forEach(t => {
  const btn = document.createElement('button');
  btn.className = 'theme-btn' + (getSavedTheme() === t.id ? ' active' : '');
  btn.textContent = t.label;
  btn.dataset.theme = t.id;
  btn.onclick = () => applyTheme(t.id);
  themeSelect.appendChild(btn);
});
const reloadBtn = document.getElementById('reloadBtn')!;
masthead.insertBefore(themeSelect, reloadBtn);

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
  resetRandomPicker();
  loaderEl.style.display = 'flex';
  headerEl.classList.remove('show');
  document.getElementById('main')!.innerHTML = '';
  setStatus('');
  fileInput.value = '';
});
document.getElementById('search')!.addEventListener('input', e => {
  searchTerm = (e.target as HTMLInputElement).value.toLowerCase().trim();
  if (!isIntelView) {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => render(), 300);
  }
});

tryAutoLoad();
