import './style.css';
import JSZip from 'jszip';
import { parseTellicoXml } from './parser';
import type { Movie } from './parser';
import { buildGroupers } from './groupers';
import type { Grouper } from './groupers';
import { renderMain, attachHandlers } from './renderer';
import { openModal } from './modal';


// Stato
let movies: Movie[] = [];
let embeddedImages = new Map<string, string>();
let imgDir = '';
let groupers: Grouper[] = [];
let currentGrouper = '';
let searchTerm = '';

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
  renderMain(grouper, searchTerm, embeddedImages, imgDir);
  attachHandlers(movies, embeddedImages, imgDir, openModal);
}

function initUI(): void {
  groupers = buildGroupers(movies);
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
      document.querySelectorAll<HTMLElement>('.group-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.name === g.name));
      render();
    };
    groupSelect.appendChild(btn);
  });
  loaderEl.style.display = 'none';
  headerEl.classList.add('show');
  render();
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
    imgDir = imgDirInput.value || '';
    if (imgDir && !imgDir.endsWith('/')) imgDir += '/';
    movies.forEach((m, i) => { if (m.id == null) (m as Record<string, unknown>)['id'] = i; });
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
      const cfg = await res.json() as { tcFile?: string };
      configuredFile = cfg.tcFile ?? null;
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

// Event listeners
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
document.getElementById('reloadBtn')!.addEventListener('click', () => {
  movies = [];
  embeddedImages = new Map();
  imgDir = '';
  groupers = [];
  currentGrouper = '';
  searchTerm = '';
  loaderEl.style.display = 'flex';
  headerEl.classList.remove('show');
  document.getElementById('main')!.innerHTML = '';
  setStatus('');
  fileInput.value = '';
});
document.getElementById('search')!.addEventListener('input', e => {
  searchTerm = (e.target as HTMLInputElement).value.toLowerCase().trim();
  render();
});

tryAutoLoad();
