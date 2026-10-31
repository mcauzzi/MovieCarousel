import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import type { ApiField, ExportScope } from '../api';
import { currentCopy } from '../copy';
import { errorTemplate, statusTemplate } from './arrivals-common.templates';
import type { Notice } from './arrivals-common.templates';

/* Schede solo amministratore del pannello ARRIVI: ESPORTA CSV (§9) e CAMPI
   (§5.1: preferenze dei campi, nuovo campo `local`, eliminazione). */

// ------------------------------------------------------------------ export

export interface ExportSummary {
  filename: string;
  count: number;
  scope: ExportScope;
  /** Film segnati come esportati; null = non previsto (scope all) o non ancora. */
  marked: number | null;
  /** export/mark fallito: il CSV è scaricato ma i film restano "nuovi". */
  markFailed: boolean;
}

export interface ExportView extends Notice {
  scope: ExportScope;
  busy: boolean;
  status: string;
  summary: ExportSummary | null;
}

export interface ExportHandlers {
  onScope: (s: ExportScope) => void;
  onExport: () => void;
  onRetryMark: () => void;
  onLogin: () => void;
}

const EXPORT_SCOPES: { id: ExportScope; label: string; hint: string }[] = [
  { id: 'new', label: 'Nuovi', hint: 'film dall\'app mai esportati; dopo il download vengono segnati come esportati' },
  { id: 'app', label: 'Tutti gli arrivi', hint: 'film dall\'app non ancora collegati a Tellico, anche se già esportati' },
  { id: 'all', label: 'Intera collezione', hint: 'backup completo; non segna nulla come esportato' },
];

function exportSummary(s: ExportSummary, h: ExportHandlers): TemplateResult {
  return html`
    <div class="arrivals-summary" tabindex="-1">
      <h4 class="arrivals-summary-title">${currentCopy().arrivalsExportDone}</h4>
      <dl class="arrivals-stats">
        <div class="arrivals-stat"><dt>File</dt><dd class="arrivals-stat-file">${s.filename}</dd></div>
        <div class="arrivals-stat"><dt>Film nel CSV</dt><dd>${s.count}</dd></div>
        ${s.scope !== 'all' ? html`
          <div class="arrivals-stat"><dt>Segnati come esportati</dt><dd>${s.marked ?? '—'}</dd></div>` : nothing}
      </dl>
      ${s.markFailed ? html`
        <p class="arrivals-note">Il CSV è stato scaricato ma i film non sono stati segnati come esportati:
          restano tra i «nuovi».</p>
        <button type="button" class="group-btn" @click=${h.onRetryMark}>↻ SEGNA COME ESPORTATI</button>` : nothing}
    </div>`;
}

export function exportTemplate(v: ExportView, h: ExportHandlers): TemplateResult {
  return html`
    <section class="arrivals-section" aria-labelledby="arrivalsExportTitle">
      <h3 class="arrivals-section-title" id="arrivalsExportTitle">ESPORTA CSV</h3>
      <p class="arrivals-lede">${currentCopy().arrivalsExportLede}
        Il CSV usa i titoli dei campi della tua collezione, così Tellico abbina le colonne da solo.</p>
      <fieldset class="arrivals-fieldset">
        <legend>Cosa esportare</legend>
        ${EXPORT_SCOPES.map(s => html`
          <label class="arrivals-radio">
            <input type="radio" name="arrivalsExportScope" value=${s.id} .checked=${v.scope === s.id}
              ?disabled=${v.busy} @change=${() => h.onScope(s.id)}>
            <span><b>${s.label}</b> — ${s.hint}</span>
          </label>`)}
      </fieldset>
      <div class="arrivals-actions">
        <button type="button" class="random-extract-btn" ?disabled=${v.busy} @click=${h.onExport}>
          ${v.busy ? 'ESPORTAZIONE…' : '⇩ ESPORTA CSV'}
        </button>
      </div>
      ${statusTemplate(v.status)}
      ${errorTemplate(v, h.onLogin)}
      ${v.summary ? exportSummary(v.summary, h) : nothing}
    </section>`;
}

// ------------------------------------------------------------------ campi

export interface FieldDraft {
  title: string;
  groupable: boolean;
  groupMinSize: string;
  inForm: boolean;
}

export interface NewFieldDraft {
  name: string;
  title: string;
  type: string;
  multiple: boolean;
  allowed: string;
}

export interface FieldsView extends Notice {
  /** null = in lettura. */
  fields: ApiField[] | null;
  drafts: Record<string, FieldDraft>;
  /** Nome del campo con un'azione in corso ('__new__' per la creazione). */
  busy: string | null;
  status: string;
  newField: NewFieldDraft;
  newError: string | null;
}

export interface FieldsHandlers {
  onDraft: (name: string, patch: Partial<FieldDraft>) => void;
  onSave: (f: ApiField) => void;
  onDelete: (f: ApiField) => void;
  onNewDraft: (patch: Partial<NewFieldDraft>) => void;
  onCreate: () => void;
  onLogin: () => void;
}

/** Tipi selezionabili per un nuovo campo `local`. */
export const NEW_FIELD_TYPES: { id: string; label: string }[] = [
  { id: 'line', label: 'Testo breve' },
  { id: 'para', label: 'Testo lungo' },
  { id: 'choice', label: 'Scelta (valori ammessi)' },
  { id: 'bool', label: 'Sì/No' },
  { id: 'number', label: 'Numero' },
  { id: 'date', label: 'Data' },
  { id: 'url', label: 'Link (URL)' },
  { id: 'rating', label: 'Voto (1–10)' },
];

export function isDirty(f: ApiField, d: FieldDraft | undefined): boolean {
  if (!d) return false;
  return d.title.trim() !== (f.title ?? '')
    || d.groupable !== !!f.groupable
    || d.inForm !== !!f.inForm
    || d.groupMinSize.trim() !== String(f.groupMinSize ?? '');
}

function fieldRow(f: ApiField, v: FieldsView, h: FieldsHandlers): TemplateResult {
  const d = v.drafts[f.name] ?? { title: f.title ?? '', groupable: !!f.groupable, groupMinSize: String(f.groupMinSize ?? ''), inForm: !!f.inForm };
  const label = f.title || f.name;
  const busy = v.busy !== null;
  const dirty = isDirty(f, d);
  return html`
    <tr class=${dirty ? 'dirty' : ''}>
      <th scope="row">
        <code class="arrivals-field-name">${f.name}</code>
      </th>
      <td>
        <input class="arrivals-field-title-input" type="text" .value=${d.title} ?disabled=${busy}
          aria-label=${`Titolo del campo ${f.name}`}
          @input=${(e: Event) => h.onDraft(f.name, { title: (e.currentTarget as HTMLInputElement).value })}>
      </td>
      <td>${f.origin}</td>
      <td>${f.type}${f.multiple ? ' · multiplo' : ''}</td>
      <td>
        <input type="checkbox" .checked=${d.groupable} ?disabled=${busy}
          aria-label=${`Raggruppabile: ${label}`}
          @change=${(e: Event) => h.onDraft(f.name, { groupable: (e.currentTarget as HTMLInputElement).checked })}>
      </td>
      <td>
        <input class="arrivals-num" type="number" min="1" max="1000" inputmode="numeric" .value=${d.groupMinSize}
          ?disabled=${busy} aria-label=${`Soglia minima di film per gruppo: ${label}`}
          @input=${(e: Event) => h.onDraft(f.name, { groupMinSize: (e.currentTarget as HTMLInputElement).value })}>
      </td>
      <td>
        <input type="checkbox" .checked=${d.inForm} ?disabled=${busy}
          aria-label=${`Nel modulo dell'app: ${label}`}
          @change=${(e: Event) => h.onDraft(f.name, { inForm: (e.currentTarget as HTMLInputElement).checked })}>
      </td>
      <td class="arrivals-field-actions">
        <button type="button" class="group-btn" ?disabled=${busy || !dirty}
          aria-label=${`Salva ${label}`} @click=${() => h.onSave(f)}>SALVA</button>
        ${f.origin === 'local' ? html`
          <button type="button" class="group-btn arrivals-danger" ?disabled=${busy}
            aria-label=${`Elimina il campo ${label}`} @click=${() => h.onDelete(f)}>ELIMINA</button>` : nothing}
      </td>
    </tr>`;
}

function newFieldForm(v: FieldsView, h: FieldsHandlers): TemplateResult {
  const n = v.newField;
  const busy = v.busy !== null;
  const onSubmit = (e: Event): void => { e.preventDefault(); h.onCreate(); };
  const text = (key: 'name' | 'title' | 'allowed') => (e: Event): void =>
    h.onNewDraft({ [key]: (e.currentTarget as HTMLInputElement).value });
  return html`
    <form class="arrivals-form arrivals-newfield" aria-labelledby="arrivalsNewFieldTitle" novalidate @submit=${onSubmit}>
      <h4 class="arrivals-form-title" id="arrivalsNewFieldTitle">Nuovo campo personalizzato</h4>
      <div class="arrivals-form-grid">
        <div class="arrivals-form-row">
          <label class="arrivals-form-label" for="nfName">Nome</label>
          <input id="nfName" type="text" required autocomplete="off" spellcheck="false"
            pattern="[a-z][a-z0-9\\-]{0,40}" .value=${n.name} aria-describedby="nfNameHint" @input=${text('name')}>
          <span class="arrivals-hint" id="nfNameHint">Minuscole, cifre e «-», inizia con una lettera (es. edizione).</span>
        </div>
        <div class="arrivals-form-row">
          <label class="arrivals-form-label" for="nfTitle">Titolo</label>
          <input id="nfTitle" type="text" required .value=${n.title} @input=${text('title')}>
        </div>
        <div class="arrivals-form-row">
          <label class="arrivals-form-label" for="nfType">Tipo</label>
          <select id="nfType" @change=${(e: Event) => h.onNewDraft({ type: (e.currentTarget as HTMLSelectElement).value })}>
            ${NEW_FIELD_TYPES.map(t => html`<option value=${t.id} ?selected=${t.id === n.type}>${t.label}</option>`)}
          </select>
        </div>
        <div class="arrivals-form-row arrivals-form-bool">
          <label class="arrivals-check">
            <input type="checkbox" .checked=${n.multiple}
              @change=${(e: Event) => h.onNewDraft({ multiple: (e.currentTarget as HTMLInputElement).checked })}>
            Valori multipli
          </label>
        </div>
        ${n.type === 'choice' ? html`
          <div class="arrivals-form-row arrivals-form-wide">
            <label class="arrivals-form-label" for="nfAllowed">Valori ammessi</label>
            <input id="nfAllowed" type="text" .value=${n.allowed} aria-describedby="nfAllowedHint" @input=${text('allowed')}>
            <span class="arrivals-hint" id="nfAllowedHint">Separati da «;» (es. DVD; Blu-ray; 4K).</span>
          </div>` : nothing}
      </div>
      ${v.newError ? html`<div class="arrivals-error" role="alert"><span>✕ ${v.newError}</span></div>` : nothing}
      <div class="arrivals-actions">
        <button type="submit" class="random-extract-btn" ?disabled=${busy}>
          ${v.busy === '__new__' ? 'CREAZIONE…' : '＋ AGGIUNGI CAMPO'}
        </button>
      </div>
    </form>`;
}

export function fieldsTemplate(v: FieldsView, h: FieldsHandlers): TemplateResult {
  const list = v.fields;
  return html`
    <section class="arrivals-section" aria-labelledby="arrivalsFieldsTitle">
      <h3 class="arrivals-section-title" id="arrivalsFieldsTitle" tabindex="-1">CAMPI</h3>
      <p class="arrivals-lede">Raggruppabile: il campo diventa una vista del carosello (se ha almeno la soglia
        di film per gruppo). Nel modulo: l'app lo chiede quando aggiungi un film. I campi «tellico» vengono
        dall'import; solo i campi «local» si possono eliminare.</p>
      ${list === null
        ? html`<p class="arrivals-muted">Carico i campi…</p>`
        : html`
          <div class="arrivals-table-wrap" role="region" aria-labelledby="arrivalsFieldsTitle" tabindex="0">
            <table class="arrivals-table">
              <thead>
                <tr>
                  <th scope="col">Campo</th>
                  <th scope="col">Titolo</th>
                  <th scope="col">Origine</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Raggruppabile</th>
                  <th scope="col">Soglia</th>
                  <th scope="col">Nel modulo</th>
                  <th scope="col"><span class="visually-hidden">Azioni</span></th>
                </tr>
              </thead>
              <tbody>${list.map(f => fieldRow(f, v, h))}</tbody>
            </table>
          </div>`}
      ${statusTemplate(v.status)}
      ${errorTemplate(v, h.onLogin)}
      ${newFieldForm(v, h)}
    </section>`;
}
