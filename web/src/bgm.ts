// Widget musica di sottofondo (BGM) — controller leaf auto-contenuto.
// Lo stato del player (tracce, traccia corrente, play/pausa, volume) è UI-locale
// e resta incapsulato qui, sullo stesso modello di toast.ts/transitions.ts; lo
// stato di dominio dell'app vive invece esclusivamente in main.ts.
import { render } from 'lit';
import { bgmWidgetTemplate } from './templates/bgm.templates';
import type { BgmTrack } from './templates/bgm.templates';

const VOL_KEY = 'cm_bgm_vol';
const TRACK_KEY = 'cm_bgm_track';
const DEFAULT_VOLUME = 0.5;
const AUDIO_EXT = /\.(mp3|ogg|m4a|aac|opus|flac|wav|webm)$/i;

/**
 * Monta il widget musicale nel `masthead`, subito prima di `anchorEl`.
 * Scopre le tracce in `bgmDir` (default ./assets/bgm/): se non ne trova
 * nessuna, il widget non viene montato affatto (degrado pulito).
 */
export async function initBgm(
  masthead: HTMLElement,
  anchorEl: HTMLElement,
  bgmDir?: string,
): Promise<void> {
  const dir = normalizeDir(bgmDir);
  const tracks = await discoverTracks(dir);
  if (!tracks.length) return;

  const audio = new Audio();
  audio.loop = true;

  let currentFile: string | null = null;
  let isPlaying = false;
  let volume = loadVolume();
  audio.volume = volume;

  const container = document.createElement('div');
  container.className = 'bgm-widget';
  masthead.insertBefore(container, anchorEl);

  // Gli eventi dell'elemento audio sono l'unica fonte di verità per isPlaying:
  // così il pulsante resta coerente anche se la riproduzione si ferma da sola.
  audio.addEventListener('play', () => { isPlaying = true; rerender(); });
  audio.addEventListener('pause', () => { isPlaying = false; rerender(); });

  function rerender(): void {
    render(
      bgmWidgetTemplate(
        { tracks, currentFile, isPlaying, volume },
        { onSelect: selectTrack, onToggle: toggle, onVolume: setVolume },
      ),
      container,
    );
    // Imposta la selezione dopo il render: il binding sul `<select>` verrebbe
    // committato da lit prima che le `<option>` dinamiche esistano, quindi la
    // traccia ripristinata non risulterebbe selezionata al primo render.
    const sel = container.querySelector<HTMLSelectElement>('.bgm-select');
    if (sel) sel.value = currentFile ?? '';
    paintVolume();
  }

  // Dipinge il riempimento dello slider (rosso fino al valore, rosso scuro dopo):
  // il track nativo non mostra il livello, così lo rendiamo visibile e "Persona".
  function paintVolume(): void {
    const vol = container.querySelector<HTMLInputElement>('.bgm-volume');
    if (!vol) return;
    const pct = Math.round(volume * 100);
    vol.style.background =
      `linear-gradient(to right, var(--hot) 0 ${pct}%, var(--hot-deep) ${pct}% 100%)`;
  }

  function selectTrack(file: string): void {
    const track = tracks.find(t => t.file === file);
    if (!track) return;
    const wasPlaying = !audio.paused;
    currentFile = file;
    audio.src = track.url;
    persist(TRACK_KEY, file);
    // Se stava suonando, continua sulla nuova traccia; altrimenti resta in pausa.
    if (wasPlaying) audio.play().catch(() => {});
    rerender();
  }

  function toggle(): void {
    if (currentFile === null) return;
    // play/pause emettono gli eventi che aggiornano isPlaying e ri-renderizzano.
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }

  function setVolume(v: number): void {
    volume = Math.min(1, Math.max(0, v));
    audio.volume = volume;
    persist(VOL_KEY, String(volume));
    // Nessun rerender (lo slider ha già il suo valore), ma ridipingiamo il
    // riempimento perché segua il trascinamento.
    paintVolume();
  }

  // Ripristina l'ultima traccia scelta senza avviarla (autoplay bloccato dai
  // browser finché non c'è un gesto dell'utente).
  const savedTrack = loadTrack();
  const restored = savedTrack ? tracks.find(t => t.file === savedTrack) : undefined;
  if (restored) {
    currentFile = restored.file;
    audio.src = restored.url;
  }

  rerender();
}

function normalizeDir(dir?: string): string {
  const d = dir && dir.trim() ? dir.trim() : './assets/bgm/';
  return d.endsWith('/') ? d : d + '/';
}

async function discoverTracks(dir: string): Promise<BgmTrack[]> {
  // 1) Autoindex del web server: prova a leggere la pagina di directory listing.
  try {
    const res = await fetch(dir, { cache: 'no-cache' });
    const ct = res.headers.get('Content-Type') ?? '';
    if (res.ok && ct.includes('text/html')) {
      const parsed = parseAutoindex(await res.text(), dir);
      if (parsed.length) return parsed;
    }
  } catch { /* autoindex assente o server non raggiungibile */ }

  // 2) Fallback: manifest esplicito bgm/tracks.json.
  try {
    const res = await fetch(dir + 'tracks.json', { cache: 'no-cache' });
    if (res.ok) {
      const parsed = parseManifest(await res.json(), dir);
      if (parsed.length) return parsed;
    }
  } catch { /* manifest assente o non valido */ }

  return [];
}

function parseAutoindex(htmlText: string, dir: string): BgmTrack[] {
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  const out: BgmTrack[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    const clean = href.split('?')[0].split('#')[0];
    if (!clean || clean.includes('../') || clean.endsWith('/')) continue;
    if (!AUDIO_EXT.test(clean)) continue;
    const file = decodeURIComponent(clean.split('/').pop() ?? '');
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push({ url: dir + encodeURIComponent(file), file, label: prettify(file) });
  }
  return out;
}

function parseManifest(data: unknown, dir: string): BgmTrack[] {
  if (!Array.isArray(data)) return [];
  const out: BgmTrack[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    let file: string | undefined;
    let title: string | undefined;
    if (typeof entry === 'string') {
      file = entry;
    } else if (entry && typeof entry === 'object') {
      const rec = entry as Record<string, unknown>;
      if (typeof rec.file === 'string') file = rec.file;
      if (typeof rec.title === 'string') title = rec.title;
    }
    if (!file) continue;
    file = file.split('/').pop() ?? '';
    if (!file || !AUDIO_EXT.test(file) || seen.has(file)) continue;
    seen.add(file);
    out.push({ url: dir + encodeURIComponent(file), file, label: title ?? prettify(file) });
  }
  return out;
}

function prettify(file: string): string {
  return file.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
}

function persist(key: string, value: string): void {
  // localStorage può lanciare (modalità privata, quota piena): la sessione
  // continua comunque, si perde solo la persistenza.
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn('cm: impossibile salvare le impostazioni BGM', e);
  }
}

function loadVolume(): number {
  try {
    const raw = localStorage.getItem(VOL_KEY);
    const v = raw === null ? NaN : Number(raw);
    if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
  } catch { /* localStorage non accessibile */ }
  return DEFAULT_VOLUME;
}

function loadTrack(): string | null {
  try {
    return localStorage.getItem(TRACK_KEY);
  } catch {
    return null;
  }
}
