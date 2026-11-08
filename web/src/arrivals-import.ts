import { render } from 'lit';
import { readTellicoFile, imageBase64, IMAGE_NAME_RE } from './tellico-file';
import type { ZipImage } from './tellico-file';
import { uploadTellicoImages, importTellico, removeMissing, goToLogin } from './api';
import { confirmDialog } from './db-ui';
import { arrivalsBodyTemplate, importBusy } from './templates/arrivals.templates';
import type { ImportView } from './templates/arrivals.templates';
import { sectionRoot, noticeFrom, reloadCollection } from './arrivals-shared';
import type { Section, SectionContext } from './arrivals-shared';

/* Scheda IMPORTA (solo amministratore): IMPORTA DA TELLICO (§8).
   Lo stato dell'import vive nella closure della sezione: chiudere il pannello
   durante un import non lo interrompe, riaprendolo si ritrova l'avanzamento.
   A import riuscito ctx.onCollectionChanged (main.ts) ricarica collezione e
   stato dall'API e ri-renderizza. */

/** Budget di un lotto di immagini, in caratteri base64 (il contratto accetta
 *  corpi fino a 32 MB sugli endpoint di import: restiamo sotto con margine per
 *  JSON e chiavi). */
const BATCH_BUDGET = 16 * 1024 * 1024;

export function createImportSection(ctx: SectionContext): Section {
  const body = sectionRoot('arrivals-import');

  const view: ImportView = {
    phase: 'idle', fileName: null, progress: null, summary: null,
    error: null, sessionExpired: false, dragover: false, removing: false, removedStatus: '',
  };

  function rerender(): void {
    render(arrivalsBodyTemplate(view, {
      onFile: f => { void runImport(f); },
      onRemoveMissing: () => { void runRemoveMissing(); },
      onDragState: over => { view.dragover = over; rerender(); },
      onLogin: goToLogin,
    }), body);
  }

  /** Invia le immagini a lotti entro il budget, leggendo i byte di una alla
   *  volta (un'immagine più grande del budget va da sola). */
  async function uploadImages(images: [string, string | ZipImage][]): Promise<{ written: number; skipped: number; invalid: number }> {
    const progress = view.progress = { sent: 0, total: images.length };
    rerender();
    let written = 0;
    let skipped = 0;
    let invalid = 0;
    let batch: Record<string, string> = {};
    let count = 0;
    let size = 0;
    const flush = async (): Promise<void> => {
      if (!count) return;
      const r = await uploadTellicoImages(batch);
      written += r.written;
      skipped += r.skipped;
      progress.sent += count;
      rerender();
      batch = {};
      count = 0;
      size = 0;
    };
    for (const [name, img] of images) {
      const b64 = await imageBase64(img);
      if (!b64) {
        // Data URL non base64: l'API non saprebbe decodificarla.
        invalid++;
        progress.total--;
        continue;
      }
      const cost = b64.length + name.length + 8;
      if (count > 0 && size + cost > BATCH_BUDGET) await flush();
      batch[name] = b64;
      count++;
      size += cost;
    }
    await flush();
    return { written, skipped, invalid };
  }

  async function runImport(file: File): Promise<void> {
    // Niente import mentre la rimozione dei mancanti è in corso (riepilogo e stato si mescolerebbero).
    if (importBusy(view.phase) || view.removing) return;
    Object.assign(view, {
      phase: 'reading', fileName: file.name, progress: null, summary: null,
      error: null, sessionExpired: false, dragover: false, removing: false, removedStatus: '',
    });
    rerender();
    try {
      const tc = await readTellicoFile(file);
      if (!tc.movies.length) throw new Error('Nessun film trovato nel file');

      // 1. Immagini a lotti (prima e fuori dalla transazione dei film, §8),
      //    senza quelle con un nome che l'API rifiuterebbe (con tutto il lotto).
      const all = [...tc.embeddedImages, ...tc.zipImages];
      const images = all.filter(([name]) => IMAGE_NAME_RE.test(name));
      view.phase = 'images';
      const up = await uploadImages(images);

      // 2. Campi e film in una sola richiesta.
      view.phase = 'movies';
      view.progress = null;
      rerender();
      const res = await importTellico(tc.fields, tc.movies);
      view.summary = {
        ...res, imagesWritten: up.written, imagesSkipped: up.skipped,
        imagesInvalid: all.length - images.length + up.invalid, movieCount: tc.movies.length,
      };

      // 3. Ricarica la collezione nella vista principale (un errore qui non
      //    annulla l'import: diventa un avviso).
      view.phase = 'reloading';
      rerender();
      await reloadCollection(ctx, view);
      view.phase = 'done';
      rerender();
      body.querySelector<HTMLElement>('.arrivals-summary')?.focus();
    } catch (err) {
      Object.assign(view, noticeFrom(err, ctx), { phase: 'error', progress: null });
      rerender();
    }
  }

  /** "Rimuovi i mancanti" (§16): elimina dal DB i film del riepilogo che non sono più nel .tc,
   *  con il loro stato visto/voto, dopo una conferma che dice quanti sono. */
  async function runRemoveMissing(): Promise<void> {
    const missing = view.summary?.missing ?? [];
    if (!missing.length || view.removing || importBusy(view.phase)) return;
    const n = missing.length;
    const ok = await confirmDialog({
      title: 'RIMUOVI', accent: 'MANCANTI', danger: true,
      message: `Eliminare dalla collezione ${n === 1 ? 'il film che non è' : `i ${n} film che non sono`} più nel file di Tellico? `
        + 'Spariscono anche visto e voti di tutti gli utenti. L\'operazione non si può annullare.',
      yesLabel: 'RIMUOVI', noLabel: 'ANNULLA',
    });
    if (!ok) return;
    Object.assign(view, { removing: true, removedStatus: '', error: null, sessionExpired: false });
    rerender();
    try {
      const { removed } = await removeMissing(missing.map(m => m.id));
      if (view.summary) view.summary = { ...view.summary, missing: [] };
      view.removing = false;
      view.removedStatus = removed === n
        ? `${removed === 1 ? 'Rimosso 1 film mancante' : `Rimossi ${removed} film mancanti`}.`
        : `Rimossi ${removed} film su ${n}: gli altri erano già stati eliminati o non vengono più da Tellico.`;
      rerender();
      body.querySelector<HTMLElement>('.arrivals-summary')?.focus();
      if (await reloadCollection(ctx, view)) rerender();
    } catch (err) {
      Object.assign(view, noticeFrom(err, ctx), { removing: false });
      rerender();
    }
  }

  rerender();
  return { el: body, activate: () => {}, rerender, destroy: () => {} };
}
