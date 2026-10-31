import { render } from 'lit';
import { buildPanelShell } from './filters';
import type { PanelShell } from './filters';
import { readTellicoFile, base64FromDataUrl } from './tellico-file';
import { uploadTellicoImages, importTellico, SessionExpiredError, ApiError, goToLogin } from './api';
import { arrivalsBodyTemplate } from './templates/arrivals.templates';
import type { ImportView } from './templates/arrivals.templates';
import { currentCopy } from './copy';
import { trapTab, focusablesIn } from './utils';

/* Pannello ARRIVI (modalità DB, solo amministratore in questa fase).
   Stessa shell e stesse classi random-* di FILTRI/RANDOM; il pannello è
   cache-ato a livello modulo e rilasciato da resetArrivals() (Reload, nuova
   collezione). Lo stato dell'import vive nella closure del pannello: chiuderlo
   durante un import non lo interrompe, riaprendolo si ritrova l'avanzamento.
   Nessuno stato di dominio qui: a import riuscito `onImported` (main.ts)
   ricarica collezione e stato dall'API e ri-renderizza. */

export interface ArrivalsParams {
  /** Chiamato dopo un import riuscito: ricarica la collezione dall'API. */
  onImported: () => Promise<void>;
  /** Sessione scaduta durante una scrittura (toast ACCEDI di main). */
  onSessionExpired: () => void;
  /** Elemento a cui restituire il focus alla chiusura. */
  returnFocusTo: () => HTMLElement | null;
}

interface ArrivalsPanel {
  shell: PanelShell;
  rerender: () => void;
  destroy: () => void;
}

/** Budget di un lotto di immagini, in caratteri base64 (il contratto accetta
 *  lotti fino a ~20 MB: restiamo sotto con margine per JSON e chiavi). */
const BATCH_BUDGET = 16 * 1024 * 1024;

let panel: ArrivalsPanel | null = null;

export function resetArrivals(): void {
  panel?.destroy();
  panel = null;
}

/** Al cambio tema: aggiorna titolo e testi di colore del pannello già costruito. */
export function refreshArrivalsCopy(): void {
  if (!panel) return;
  const accent = panel.shell.panel.querySelector('.random-title-accent');
  if (accent) accent.textContent = currentCopy().arrivalsAccent;
  panel.rerender();
}

export function openArrivals(params: ArrivalsParams): void {
  if (!panel) {
    panel = buildArrivals(params);
    document.body.appendChild(panel.shell.backdrop);
  }
  panel.shell.backdrop.classList.add('show');
  const target = focusablesIn(panel.shell.panel).find(el => !el.classList.contains('random-close'))
    ?? panel.shell.panel.querySelector<HTMLElement>('.random-close');
  // Dopo il frame: il backdrop passa da pointer-events:none a visibile.
  requestAnimationFrame(() => target?.focus());
}

/** Divide le immagini in lotti entro il budget (un'immagine più grande va da sola). */
function batchImages(images: Map<string, string>): Record<string, string>[] {
  const batches: Record<string, string>[] = [];
  let cur: Record<string, string> = {};
  let size = 0;
  for (const [id, url] of images) {
    const b64 = base64FromDataUrl(url);
    if (!b64) continue;
    const cost = b64.length + id.length + 8;
    if (size > 0 && size + cost > BATCH_BUDGET) {
      batches.push(cur);
      cur = {};
      size = 0;
    }
    cur[id] = b64;
    size += cost;
  }
  if (size > 0) batches.push(cur);
  return batches;
}

function errorMessage(err: unknown): string {
  if (err instanceof SessionExpiredError) return 'Sessione scaduta: accedi di nuovo e ripeti l\'import.';
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Permesso negato: l\'import è riservato agli amministratori.';
    if (err.status === 413) return 'File troppo grande per l\'API (413).';
    return err.message;
  }
  return (err as Error)?.message || String(err);
}

function buildArrivals(params: ArrivalsParams): ArrivalsPanel {
  const shell = buildPanelShell('ARRIVI', currentCopy().arrivalsAccent);
  const { panel: panelEl, backdrop } = shell;
  panelEl.classList.add('arrivals-panel');
  panelEl.setAttribute('role', 'dialog');
  panelEl.setAttribute('aria-modal', 'true');
  panelEl.setAttribute('aria-label', 'ARRIVI · IMPORTA DA TELLICO');
  panelEl.querySelector('.random-close')?.setAttribute('aria-label', 'Chiudi ARRIVI');

  const body = document.createElement('div');
  body.className = 'arrivals-body';
  panelEl.appendChild(body);

  const view: ImportView = {
    phase: 'idle', fileName: null, progress: null, summary: null,
    error: null, sessionExpired: false, dragover: false,
  };

  const isBusy = (): boolean => ['reading', 'images', 'movies', 'reloading'].includes(view.phase);

  function rerender(): void {
    render(arrivalsBodyTemplate(view, {
      onFile: f => { void runImport(f); },
      onDragState: over => { view.dragover = over; rerender(); },
      onLogin: goToLogin,
    }), body);
  }

  function fail(err: unknown): void {
    console.error(err);
    view.phase = 'error';
    view.error = errorMessage(err);
    view.sessionExpired = err instanceof SessionExpiredError;
    view.progress = null;
    if (view.sessionExpired) params.onSessionExpired();
    rerender();
  }

  async function runImport(file: File): Promise<void> {
    if (isBusy()) return;
    Object.assign(view, {
      phase: 'reading', fileName: file.name, progress: null, summary: null,
      error: null, sessionExpired: false, dragover: false,
    });
    rerender();
    try {
      const tc = await readTellicoFile(file);
      if (!tc.movies.length) throw new Error('Nessun film trovato nel file');

      // 1. Immagini a lotti (prima e fuori dalla transazione dei film, §8).
      const batches = batchImages(tc.embeddedImages);
      const imageCount = batches.reduce((n, b) => n + Object.keys(b).length, 0);
      view.phase = 'images';
      view.progress = { done: 0, total: batches.length, images: imageCount };
      rerender();
      let written = 0;
      let skipped = 0;
      for (const batch of batches) {
        const r = await uploadTellicoImages(batch);
        written += r.written;
        skipped += r.skipped;
        view.progress = { ...view.progress, done: view.progress.done + 1 };
        rerender();
      }

      // 2. Campi e film in una sola richiesta.
      view.phase = 'movies';
      rerender();
      const res = await importTellico(tc.fields, tc.movies);
      view.summary = { ...res, imagesWritten: written, imagesSkipped: skipped, movieCount: tc.movies.length };

      // 3. Ricarica la collezione nella vista principale.
      view.phase = 'reloading';
      rerender();
      try {
        await params.onImported();
        view.phase = 'done';
      } catch (err) {
        // L'import è riuscito: un errore qui riguarda solo la ricarica.
        view.phase = 'done';
        view.error = 'Import riuscito, ma la ricarica della collezione non è andata: usa ↻ Reload. (' + errorMessage(err) + ')';
      }
      view.progress = null;
      rerender();
      body.querySelector<HTMLElement>('.arrivals-summary')?.focus();
    } catch (err) {
      fail(err);
    }
  }

  // Dialog: focus trap sul pannello e ritorno del focus al pulsante alla chiusura.
  const onKeydown = (e: KeyboardEvent): void => { if (e.key === 'Tab') trapTab(panelEl, e); };
  panelEl.addEventListener('keydown', onKeydown);
  const observer = new MutationObserver(() => {
    if (!backdrop.classList.contains('show') && backdrop.contains(document.activeElement))
      params.returnFocusTo()?.focus();
  });
  observer.observe(backdrop, { attributes: true, attributeFilter: ['class'] });

  rerender();
  return {
    shell,
    rerender,
    destroy: () => { observer.disconnect(); shell.destroy(); },
  };
}
