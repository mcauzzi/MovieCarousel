import { render } from 'lit';
import type { Movie } from './parser';
import type { Grouper } from './groupers';
import type { StoreAdapter } from './store';
import type { WatchFilter } from './renderer';
import { buildPool, buildGrouperPanel, buildPanelShell, buildWatchRow } from './filters';
import type { PanelShell } from './filters';
import { randomPickerBodyTemplate } from './templates/popup.templates';
import { attackBurstTemplate, callingCardTemplate } from './templates/attack.templates';
import type { CallingCardHandlers } from './templates/attack.templates';
import { trapTab } from './utils';

interface PickerParams {
  movies: Movie[];
  groupers: Grouper[];
  store: StoreAdapter;
  initialWatchFilter: WatchFilter;
  onPick: (id: number) => void;
  /** URL della copertina per la miniatura del biglietto (null → segnaposto). */
  coverFor: (m: Movie) => string | null;
}

interface Picker {
  shell: PanelShell;
  setWatchFilter: (f: WatchFilter) => void;
  /** Pool corrente: stesse selezioni private e stesso filtro visione del picker. */
  getPool: () => Movie[];
}

interface AttackOverlay {
  launch: (pool: Movie[]) => void;
  destroy: () => void;
}

/* Picker e overlay All-Out Attack sono cache-ati a livello modulo.
   resetRandomPicker (Reload, nuova collezione) li rilascia entrambi;
   refreshRandomPicker (rebuild dei grouper, anche da un'altra scheda) rilascia
   solo il picker, così il biglietto aperto sopravvive: RITENTA ripiega sul pool
   del lancio finché non esiste un nuovo picker. */
let picker: Picker | null = null;
let attack: AttackOverlay | null = null;

export function resetRandomPicker(): void {
  refreshRandomPicker();
  attack?.destroy();
  attack = null;
}

export function refreshRandomPicker(): void {
  picker?.shell.destroy();
  picker = null;
}

export function openRandomPicker(params: PickerParams): void {
  if (!picker) {
    picker = buildPicker(params, pool => {
      attack ??= buildAttack(params, () => picker?.getPool() ?? null, reopenPicker);
      attack.launch(pool);
    });
    document.body.appendChild(picker.shell.backdrop);
  } else {
    picker.setWatchFilter(params.initialWatchFilter);
  }
  picker.shell.backdrop.classList.add('show');
}

/** MODIFICA: riapre il picker cached così com'è (selezioni intatte). Se nel
 *  frattempo è stato rilasciato (rebuild dei grouper), passa dal bottone RANDOM,
 *  che lo ricostruisce con i parametri aggiornati di main. */
function reopenPicker(): void {
  if (!picker) { document.getElementById('randomBtn')?.click(); return; }
  picker.shell.backdrop.classList.add('show');
  picker.shell.panel.querySelector<HTMLButtonElement>('.random-extract-btn')?.focus();
}

function buildPicker(params: PickerParams, onLaunch: (pool: Movie[]) => void): Picker {
  const { movies, groupers, store, initialWatchFilter } = params;

  const selections = new Map<string, Set<string>>();
  let currentWatchFilter: WatchFilter = initialWatchFilter;
  let poolCount = 0;
  let extractDisabled = true;

  const shell = buildPanelShell('RANDOM', 'TARGET');
  const { panel, close } = shell;

  const body = document.createElement('div');
  panel.appendChild(body);

  // Pannelli grouper: elementi vivi creati una volta, interpolati nel template.
  const panelEls: HTMLElement[] = [];
  for (const grouper of groupers) {
    const sel = new Set<string>();
    selections.set(grouper.name, sel);
    panelEls.push(buildGrouperPanel(grouper, sel, updatePool, movies).el);
  }

  const watchRow = buildWatchRow(currentWatchFilter, f => {
    currentWatchFilter = f;
    updatePool();
  });

  const getPool = (): Movie[] => buildPool(movies, groupers, selections, store, currentWatchFilter);

  // ESTRAI chiude il picker e lancia l'All-Out Attack (l'estrazione la fa l'overlay).
  function onExtract(): void {
    const pool = getPool();
    if (!pool.length) return;
    close();
    onLaunch(pool);
  }

  function rerenderBody(): void {
    render(randomPickerBodyTemplate(panelEls, watchRow.row, poolCount, extractDisabled, onExtract), body);
  }

  function updatePool(): void {
    const pool = getPool();
    poolCount = pool.length;
    extractDisabled = pool.length === 0;
    rerenderBody();
  }

  updatePool();

  function setWatchFilter(f: WatchFilter): void {
    currentWatchFilter = f;
    watchRow.setValue(f);
    updatePool();
  }

  return { shell, setWatchFilter, getPool };
}

/* Overlay "ALL-OUT ATTACK!": raffica (~1.1s) → biglietto da visita col film.
   RITENTA ri-estrae subito dallo stesso pool con un flip breve; con
   prefers-reduced-motion niente raffica: il biglietto appare subito.
   La tastiera è gestita in capture su document: Escape chiude SOLO l'overlay
   (stopPropagation → non arriva agli handler di modal, shell dei popup, menu Vista). */
function buildAttack(params: PickerParams, getPool: () => Movie[] | null, onEdit: () => void): AttackOverlay {
  const { onPick, coverFor } = params;
  const BURST_MS = 1100;

  const root = document.createElement('div');
  root.className = 'aoa';
  root.hidden = true;
  root.tabIndex = -1;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  document.body.appendChild(root);

  let phase: 'burst' | 'card' = 'burst';
  let movie: Movie | null = null;
  // Pool del lancio: ripiego per RITENTA se il picker è stato rilasciato.
  let launchedPool: Movie[] = [];
  let poolCount = 0;
  let coverFailed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const handlers: CallingCardHandlers = {
    onOpen,
    onRetry,
    onEdit: () => { hide(); onEdit(); },
    onClose,
    onCoverError: () => { coverFailed = true; rerender(); },
  };

  function rerender(): void {
    if (phase === 'card' && movie) {
      root.setAttribute('aria-label', 'Film estratto: ' + (movie.title || 'Senza titolo'));
      render(callingCardTemplate({ movie, cover: coverFailed ? null : coverFor(movie), poolCount }, handlers), root);
    } else {
      root.setAttribute('aria-label', 'All-Out Attack');
      render(attackBurstTemplate(), root);
    }
  }

  /** Estrazione casuale; con pool > 1 evita di ripescare il film appena uscito. */
  function draw(pool: Movie[], avoidId?: number): Movie {
    const others = avoidId !== undefined ? pool.filter(m => m.id !== avoidId) : pool;
    // Con id duplicati nel .tc il filtro può svuotare il pool: si ripesca da tutto.
    const candidates = others.length ? others : pool;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  function clearTimer(): void {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  const focusOpen = (): void => { root.querySelector<HTMLButtonElement>('[data-cc="open"]')?.focus(); };

  function showCard(): void {
    timer = null;
    phase = 'card';
    rerender();
    focusOpen();
  }

  function launch(pool: Movie[]): void {
    if (!pool.length) return;
    clearTimer();
    movie = draw(pool);
    launchedPool = pool;
    poolCount = pool.length;
    coverFailed = false;
    root.classList.remove('aoa-reroll');
    root.hidden = false;
    document.body.style.overflow = 'hidden';
    if (reducedMotion()) { showCard(); return; }
    phase = 'burst';
    rerender();
    root.focus();
    timer = setTimeout(showCard, BURST_MS);
  }

  function onRetry(): void {
    if (phase !== 'card' || !movie) return;
    const pool = getPool() ?? launchedPool;
    if (!pool.length) return;
    movie = draw(pool, movie.id);
    poolCount = pool.length;
    coverFailed = false;
    rerender();
    if (reducedMotion()) return;
    // Riavvia l'animazione breve anche a colpi ravvicinati.
    root.classList.remove('aoa-reroll');
    void root.offsetWidth;
    root.classList.add('aoa-reroll');
  }

  function hide(): void {
    clearTimer();
    root.hidden = true;
    root.classList.remove('aoa-reroll');
    document.body.style.overflow = '';
  }

  const restoreFocus = (): void => { document.getElementById('randomBtn')?.focus(); };

  function onClose(): void {
    hide();
    restoreFocus();
  }

  function onOpen(): void {
    if (!movie) return;
    const id = movie.id;
    hide();
    // Il modal memorizza l'elemento attivo all'apertura: così alla sua chiusura
    // il focus torna a RANDOM.
    restoreFocus();
    onPick(id);
  }

  const keydownHandler = (e: KeyboardEvent): void => {
    if (root.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab') {
      trapTab(root, e);
    } else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
      e.preventDefault();
      // Il focus resta dov'è: R, R, R… poi Invio su APRI SCHEDA.
      onRetry();
    }
  };
  document.addEventListener('keydown', keydownHandler, true);
  // Click durante la raffica: salta direttamente al biglietto.
  root.addEventListener('click', () => { if (phase === 'burst' && timer) { clearTimer(); showCard(); } });

  function destroy(): void {
    if (!root.hidden) hide();
    document.removeEventListener('keydown', keydownHandler, true);
    root.remove();
  }

  return { launch, destroy };
}
