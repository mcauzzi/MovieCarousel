import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import type { Arrival, ArrivalScope } from '../api';
import { currentCopy } from '../copy';
import { errorTemplate, fmtDateTime, statusTemplate } from './arrivals-common.templates';
import type { Notice } from './arrivals-common.templates';

/* Scheda ARRIVI: film aggiunti dall'app (scope new/app), con CORREGGI (modulo
   in linea costruito dai campi `inForm`) ed ELIMINA. Titoli, EAN e nomi sono
   dati utente: solo interpolazioni lit. */

/** Controllo del modulo per un campo (dal tipo del campo della collezione). */
export type FormControl = 'text' | 'textarea' | 'number' | 'date' | 'bool' | 'choice' | 'list' | 'table';

export interface FormField {
  name: string;
  label: string;
  control: FormControl;
  allowed: string[];
  /** Testo di aiuto (formato dei valori multipli, tabella). */
  hint: string | null;
}

export type DraftValue = string | boolean;

export interface EditView {
  movieId: number;
  /** null = definizioni dei campi in lettura. */
  fields: FormField[] | null;
  draft: Record<string, DraftValue>;
  saving: boolean;
  error: string | null;
}

export interface ListView extends Notice {
  scope: ArrivalScope;
  /** null = in lettura. */
  items: Arrival[] | null;
  /** Url della copertina per un arrivo (null = segnaposto). */
  coverFor: (a: Arrival) => string | null;
  edit: EditView | null;
  /** Id in eliminazione: disabilita i pulsanti. */
  busyId: number | null;
  status: string;
}

export interface ListHandlers {
  onScope: (s: ArrivalScope) => void;
  onEdit: (a: Arrival) => void;
  onCancelEdit: () => void;
  onDraft: (name: string, value: DraftValue) => void;
  onSave: () => void;
  onDelete: (a: Arrival) => void;
  onLogin: () => void;
}

const SCOPES: { id: ArrivalScope; label: string }[] = [
  { id: 'new', label: 'MAI ESPORTATI' },
  { id: 'app', label: 'NON ANCORA IN TELLICO' },
];

/** id DOM-safe per i controlli del modulo. */
function ctrlId(movieId: number, name: string): string {
  return `af-${movieId}-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function controlTemplate(f: FormField, e: EditView, h: ListHandlers): TemplateResult {
  const id = ctrlId(e.movieId, f.name);
  const hintId = f.hint ? id + '-hint' : undefined;
  const value = e.draft[f.name];
  const str = typeof value === 'string' ? value : '';
  const onText = (ev: Event): void =>
    h.onDraft(f.name, (ev.currentTarget as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value);
  const hint = f.hint ? html`<span class="arrivals-hint" id=${hintId!}>${f.hint}</span>` : nothing;

  if (f.control === 'bool') {
    return html`
      <div class="arrivals-form-row arrivals-form-bool">
        <label class="arrivals-check" for=${id}>
          <input id=${id} type="checkbox" .checked=${value === true}
            @change=${(ev: Event) => h.onDraft(f.name, (ev.currentTarget as HTMLInputElement).checked)}>
          ${f.label}
        </label>
      </div>`;
  }

  let control: TemplateResult;
  switch (f.control) {
    case 'textarea':
    case 'table':
      control = html`<textarea id=${id} rows=${f.control === 'table' ? 3 : 4} .value=${str}
        aria-describedby=${hintId ?? nothing} @input=${onText}></textarea>`;
      break;
    case 'number':
      control = html`<input id=${id} type="number" inputmode="numeric" .value=${str}
        aria-describedby=${hintId ?? nothing} @input=${onText}>`;
      break;
    case 'date':
      control = html`<input id=${id} type="date" .value=${str} @input=${onText}>`;
      break;
    case 'choice': {
      // Un valore attuale fuori dagli ammessi resta selezionabile (non lo perdiamo).
      const opts = str && !f.allowed.includes(str) ? [str, ...f.allowed] : f.allowed;
      control = html`
        <select id=${id} @change=${onText}>
          <option value="" ?selected=${!str}>—</option>
          ${opts.map(o => html`<option value=${o} ?selected=${o === str}>${o}</option>`)}
        </select>`;
      break;
    }
    default:
      control = html`<input id=${id} type="text" .value=${str}
        aria-describedby=${hintId ?? nothing} @input=${onText}>`;
  }
  return html`
    <div class="arrivals-form-row">
      <label class="arrivals-form-label" for=${id}>${f.label}</label>
      ${control}
      ${hint}
    </div>`;
}

function editTemplate(a: Arrival, e: EditView, h: ListHandlers): TemplateResult {
  const titleId = `arrivalsEdit-${a.id}`;
  if (!e.fields) return html`<p class="arrivals-muted">Carico i campi del modulo…</p>`;
  const onSubmit = (ev: Event): void => { ev.preventDefault(); h.onSave(); };
  const onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); h.onCancelEdit(); }
  };
  return html`
    <form class="arrivals-form" aria-labelledby=${titleId} @submit=${onSubmit} @keydown=${onKeydown}>
      <h4 class="arrivals-form-title" id=${titleId} tabindex="-1">Correggi «${a.movie.title || 'senza titolo'}»</h4>
      ${e.fields.length
        ? html`<div class="arrivals-form-grid">${e.fields.map(f => controlTemplate(f, e, h))}</div>`
        : html`<p class="arrivals-muted">Nessun campo modificabile (nessun campo con «nel modulo» attivo).</p>`}
      ${e.error ? html`<div class="arrivals-error" role="alert"><span>✕ ${e.error}</span></div>` : nothing}
      <div class="arrivals-actions">
        <button type="button" class="group-btn" @click=${h.onCancelEdit}>ANNULLA</button>
        <button type="submit" class="random-extract-btn arrivals-save" ?disabled=${e.saving || !e.fields.length}>
          ${e.saving ? 'SALVATAGGIO…' : '✓ SALVA'}
        </button>
      </div>
    </form>`;
}

function itemTemplate(a: Arrival, v: ListView, h: ListHandlers): TemplateResult {
  const m = a.movie;
  const title = m.title || 'Senza titolo';
  const url = v.coverFor(a);
  const editing = v.edit?.movieId === a.id;
  const busy = v.busyId !== null || !!v.edit?.saving;
  return html`
    <li class="arrivals-item ${editing ? 'editing' : ''}">
      <div class="arrivals-item-row">
        ${url
          ? html`<img class="arrivals-cover" src=${url} alt="" loading="lazy" width="54" height="80">`
          : html`<div class="arrivals-cover arrivals-cover-none" aria-hidden="true">${currentCopy().noCover}</div>`}
        <div class="arrivals-item-main">
          <span class="arrivals-item-title">${title}${m.year ? html` <span class="arrivals-item-year">(${m.year})</span>` : nothing}</span>
          <dl class="arrivals-item-meta">
            <div><dt>EAN</dt><dd>${a.ean || '—'}</dd></div>
            <div><dt>Aggiunto da</dt><dd>${a.createdByName || a.createdBy || '—'}</dd></div>
            <div><dt>Il</dt><dd>${fmtDateTime(a.createdAt) || '—'}</dd></div>
            <div><dt>Esportato</dt><dd>${a.exportedAt ? `sì, ${fmtDateTime(a.exportedAt)}` : 'no'}</dd></div>
          </dl>
        </div>
        <div class="arrivals-actions arrivals-item-actions">
          <button type="button" class="group-btn" aria-expanded=${editing ? 'true' : 'false'}
            aria-label=${`Correggi ${title}`} ?disabled=${busy && !editing}
            @click=${() => (editing ? h.onCancelEdit() : h.onEdit(a))}>CORREGGI</button>
          <button type="button" class="group-btn arrivals-danger" aria-label=${`Elimina ${title}`}
            ?disabled=${busy} @click=${() => h.onDelete(a)}>ELIMINA</button>
        </div>
      </div>
      ${editing && v.edit ? editTemplate(a, v.edit, h) : nothing}
    </li>`;
}

export function listTemplate(v: ListView, h: ListHandlers): TemplateResult {
  const items = v.items;
  return html`
    <section class="arrivals-section" aria-labelledby="arrivalsListTitle">
      <h3 class="arrivals-section-title" id="arrivalsListTitle" tabindex="-1">ARRIVI DALL'APP</h3>
      <p class="arrivals-lede">${currentCopy().arrivalsListLede}</p>
      <div class="arrivals-segmented" role="group" aria-label="Quali arrivi mostrare">
        ${SCOPES.map(s => html`
          <button type="button" class="group-btn ${v.scope === s.id ? 'active' : ''}"
            aria-pressed=${v.scope === s.id ? 'true' : 'false'}
            @click=${() => h.onScope(s.id)}>${s.label}</button>`)}
      </div>
      ${items === null
        ? html`<p class="arrivals-muted">Carico gli arrivi…</p>`
        : items.length
          ? html`<ul class="arrivals-list">${items.map(a => itemTemplate(a, v, h))}</ul>`
          : html`<p class="arrivals-muted">${currentCopy().arrivalsEmpty}</p>`}
      ${statusTemplate(v.status)}
      ${errorTemplate(v, h.onLogin)}
    </section>`;
}
