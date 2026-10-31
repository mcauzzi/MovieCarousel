import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import type { ImportResponse } from '../api';
import { currentCopy } from '../copy';
import { errorTemplate } from './arrivals-common.templates';

/* Pannello ARRIVI (modalità DB): scheda IMPORTA DA TELLICO e guscio a schede
   (le altre schede in arrivals-phone/-list/-admin.templates.ts).
   Etichette funzionali (ARRIVI, IMPORTA DA TELLICO) uguali in ogni tema; le
   frasi di colore arrivano da copy.ts. Tutto interpolato con lit (titoli dei
   film mancanti compresi): niente unsafeHTML. */

export type ImportPhase = 'idle' | 'reading' | 'images' | 'movies' | 'reloading' | 'done' | 'error';

export interface ImportView {
  phase: ImportPhase;
  fileName: string | null;
  /** Avanzamento dell'upload immagini (immagini inviate / da inviare). */
  progress: { sent: number; total: number } | null;
  summary: (ImportResponse & {
    imagesWritten: number;
    imagesSkipped: number;
    /** Immagini saltate perché il nome non è accettato dall'API. */
    imagesInvalid: number;
    movieCount: number;
  }) | null;
  error: string | null;
  /** La sessione è scaduta durante l'import: mostra il pulsante ACCEDI. */
  sessionExpired: boolean;
  dragover: boolean;
}

export interface ImportHandlers {
  onFile: (file: File) => void;
  onDragState: (over: boolean) => void;
  onLogin: () => void;
}

function busy(phase: ImportPhase): boolean {
  return phase === 'reading' || phase === 'images' || phase === 'movies' || phase === 'reloading';
}

function progressText(v: ImportView): string {
  switch (v.phase) {
    case 'reading': return `Lettura di ${v.fileName ?? 'file'}…`;
    case 'images': {
      const p = v.progress;
      if (!p || p.total === 0) return 'Invio immagini…';
      return `Invio immagini: ${p.sent} di ${p.total}…`;
    }
    case 'movies': return 'Import di campi e film…';
    case 'reloading': return 'Import completato. Ricarico la collezione…';
    case 'done': return 'Import completato.';
    default: return '';
  }
}

function summaryTemplate(s: NonNullable<ImportView['summary']>): TemplateResult {
  const rows: [string, number][] = [
    ['Film nel file', s.movieCount],
    ['Inseriti', s.inserted],
    ['Aggiornati', s.updated],
    ['Collegati', s.linked],
    ['Invariati', s.unchanged],
    ['Mancanti nel file', s.missing.length],
    ['Campi aggiornati', s.fieldsUpdated],
    ['Immagini scritte', s.imagesWritten],
    ['Immagini già presenti', s.imagesSkipped],
  ];
  if (s.imagesInvalid) rows.push(['Immagini con nome non valido (saltate)', s.imagesInvalid]);
  return html`
    <div class="arrivals-summary" tabindex="-1">
      <h4 class="arrivals-summary-title">${currentCopy().arrivalsDone}</h4>
      <dl class="arrivals-stats">
        ${rows.map(([label, n]) => html`<div class="arrivals-stat"><dt>${label}</dt><dd>${n}</dd></div>`)}
      </dl>
      ${s.missing.length ? html`
        <details class="arrivals-missing">
          <summary>Nel database ma non nel file (${s.missing.length}): non vengono cancellati</summary>
          <ul>${s.missing.map(m => html`<li><span class="arrivals-missing-id">#${m.id}</span> ${m.title || '(senza titolo)'}</li>`)}</ul>
        </details>` : nothing}
    </div>`;
}

export function arrivalsBodyTemplate(v: ImportView, h: ImportHandlers): TemplateResult {
  const isBusy = busy(v.phase);
  const p = v.progress;
  const onChange = (e: Event): void => {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (f) h.onFile(f);
  };
  const onDragOver = (e: DragEvent): void => {
    e.preventDefault();
    if (!isBusy && !v.dragover) h.onDragState(true);
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    h.onDragState(false);
    const f = e.dataTransfer?.files[0];
    if (f && !isBusy) h.onFile(f);
  };
  return html`
    <section class="arrivals-section" aria-labelledby="arrivalsImportTitle">
      <h3 class="arrivals-section-title" id="arrivalsImportTitle">IMPORTA DA TELLICO</h3>
      <p class="arrivals-lede">${currentCopy().arrivalsLede}
        I film già presenti vengono aggiornati, quelli nuovi aggiunti; nessun film viene cancellato.</p>
      <label
        class="arrivals-drop ${v.dragover ? 'dragover' : ''} ${isBusy ? 'busy' : ''}"
        @dragover=${onDragOver}
        @dragleave=${() => h.onDragState(false)}
        @drop=${onDrop}>
        <input
          class="visually-hidden"
          type="file"
          accept=".tc,.zip,.xml"
          ?disabled=${isBusy}
          aria-label="Scegli il file .tc di Tellico da importare"
          @change=${onChange}>
        <span class="arrivals-drop-text">
          ${v.fileName && v.phase !== 'idle' ? html`File: <b>${v.fileName}</b>` : html`Trascina qui il file <b>.tc</b> di Tellico`}
        </span>
        <span class="group-btn arrivals-drop-cta" aria-hidden="true">${isBusy ? 'IMPORT IN CORSO…' : '▶ SCEGLI FILE .TC'}</span>
      </label>
      <div class="arrivals-progress" role="status" aria-live="polite">
        ${v.phase === 'images' && p && p.total > 0
          ? html`<progress class="arrivals-bar" max=${p.total} value=${p.sent} aria-label="Immagini inviate"></progress>`
          : nothing}
        <span class="arrivals-progress-text">${progressText(v)}</span>
      </div>
      ${errorTemplate(v, h.onLogin)}
      ${v.summary ? summaryTemplate(v.summary) : nothing}
    </section>`;
}

// ------------------------------------------------------------ schede del pannello

export interface ArrivalsTab {
  id: string;
  label: string;
  /** Elemento radice della sezione (costruito e aggiornato dal suo controller). */
  el: HTMLElement;
}

export interface TabsHandlers {
  onSelect: (id: string, focus: boolean) => void;
}

/** Schede accessibili (role="tablist", tab a focus mobile, frecce/Home/Fine)
 *  con i pannelli delle sezioni interpolati come nodi DOM: lit li mantiene al
 *  loro posto tra un render e l'altro, conservandone lo stato interno. */
export function arrivalsShellTemplate(tabs: ArrivalsTab[], active: string, h: TabsHandlers): TemplateResult {
  const onKeydown = (e: KeyboardEvent): void => {
    const i = tabs.findIndex(t => t.id === active);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    h.onSelect(tabs[next].id, true);
  };
  return html`
    ${tabs.length > 1 ? html`
      <div class="arrivals-tabs" role="tablist" aria-label="Sezioni di ARRIVI" @keydown=${onKeydown}>
        ${tabs.map(t => html`
          <button type="button" role="tab" class="arrivals-tab ${t.id === active ? 'active' : ''}"
            id=${`arrivalsTab-${t.id}`} aria-controls=${`arrivalsPanel-${t.id}`}
            aria-selected=${t.id === active ? 'true' : 'false'} tabindex=${t.id === active ? '0' : '-1'}
            @click=${() => h.onSelect(t.id, false)}>${t.label}</button>`)}
      </div>` : nothing}
    ${tabs.map(t => html`
      <div class="arrivals-tabpanel" role=${tabs.length > 1 ? 'tabpanel' : nothing}
        id=${`arrivalsPanel-${t.id}`}
        aria-labelledby=${tabs.length > 1 ? `arrivalsTab-${t.id}` : nothing}
        ?hidden=${t.id !== active}>${t.el}</div>`)}
    <p class="arrivals-note arrivals-tmdb" lang="en">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>`;
}
