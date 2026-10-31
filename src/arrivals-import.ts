import { render } from 'lit';
import { readTellicoFile, imageBase64, IMAGE_NAME_RE } from './tellico-file';
import type { ZipImage } from './tellico-file';
import { uploadTellicoImages, importTellico, goToLogin } from './api';
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
    error: null, sessionExpired: false, dragover: false,
  };

  function rerender(): void {
    render(arrivalsBodyTemplate(view, {
      onFile: f => { void runImport(f); },
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
    if (importBusy(view.phase)) return;
    Object.assign(view, {
      phase: 'reading', fileName: file.name, progress: null, summary: null,
      error: null, sessionExpired: false, dragover: false,
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

  rerender();
  return { el: body, activate: () => {}, rerender, destroy: () => {} };
}
