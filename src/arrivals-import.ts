import { render } from 'lit';
import { readTellicoFile, imageBase64, IMAGE_NAME_RE } from './tellico-file';
import type { TellicoFile, ZipImage } from './tellico-file';
import { uploadTellicoImages, importTellico, goToLogin } from './api';
import { arrivalsBodyTemplate } from './templates/arrivals.templates';
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

/** Immagini da inviare (incorporate nell'XML e dello zip) e quante sono state
 *  scartate perché il nome non è accettato dall'API (che rifiuterebbe il lotto). */
function uploadableImages(tc: TellicoFile): { images: [string, string | ZipImage][]; invalid: number } {
  const all: [string, string | ZipImage][] = [...tc.embeddedImages, ...tc.zipImages];
  const images = all.filter(([name]) => IMAGE_NAME_RE.test(name));
  return { images, invalid: all.length - images.length };
}

export function createImportSection(ctx: SectionContext): Section {
  const body = sectionRoot('arrivals-import');

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

  /** Invia le immagini a lotti entro il budget, leggendo i byte di una alla
   *  volta (un'immagine più grande del budget va da sola). */
  async function uploadImages(images: [string, string | ZipImage][]): Promise<{ written: number; skipped: number; invalid: number }> {
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
      view.progress = { sent: (view.progress?.sent ?? 0) + count, total: view.progress?.total ?? images.length };
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
        view.progress = { sent: view.progress?.sent ?? 0, total: (view.progress?.total ?? images.length) - 1 };
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
      const { images, invalid } = uploadableImages(tc);
      view.phase = 'images';
      view.progress = { sent: 0, total: images.length };
      rerender();
      const up = await uploadImages(images);

      // 2. Campi e film in una sola richiesta.
      view.phase = 'movies';
      view.progress = null;
      rerender();
      const res = await importTellico(tc.fields, tc.movies);
      view.summary = {
        ...res, imagesWritten: up.written, imagesSkipped: up.skipped,
        imagesInvalid: invalid + up.invalid, movieCount: tc.movies.length,
      };

      // 3. Ricarica la collezione nella vista principale (un errore qui non
      //    annulla l'import: diventa un avviso).
      view.phase = 'reloading';
      rerender();
      const warn = await reloadCollection(ctx);
      view.phase = 'done';
      if (warn) { view.error = warn; view.sessionExpired = false; }
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
