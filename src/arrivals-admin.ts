import { render } from 'lit';
import { exportCsv, markExported, getFields, createField, patchField, deleteField, goToLogin } from './api';
import type { ApiField, ArrivalScope, FieldPatch } from './api';
import { exportTemplate, fieldsTemplate, isDirty } from './templates/arrivals-admin.templates';
import type { ExportView, FieldDraft, FieldsView, NewFieldDraft } from './templates/arrivals-admin.templates';
import { confirmWithOption } from './db-ui';
import { sectionRoot, noticeFrom, errorMessage, reloadCollection } from './arrivals-shared';
import type { Section, SectionContext } from './arrivals-shared';

/* Schede solo amministratore: ESPORTA CSV e CAMPI.
   Export (§9): il CSV arriva come blob; lo si salva come file e solo dopo,
   per gli scope new/app con righe dall'app, si chiama export/mark con lo
   scope e il cutoff dell'header X-CM-Export-Cutoff. Un mark fallito lascia i
   film "nuovi" e offre di riprovare. */

/** Salva un blob come file (link temporaneo con download). */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoca differita: alcuni browser leggono l'URL dopo il click.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function createExportSection(ctx: SectionContext, onMarked: () => void): Section {
  const el = sectionRoot('arrivals-export');
  const view: ExportView = { scope: 'new', busy: false, status: '', summary: null, error: null, sessionExpired: false };
  /** Mark ancora da fare (o da riprovare) dopo l'ultimo export. */
  let pendingMark: { scope: ArrivalScope; cutoff: string } | null = null;

  function rerender(): void {
    render(exportTemplate(view, {
      onScope: s => { view.scope = s; rerender(); },
      onExport: () => { void run(); },
      onRetryMark: () => { void mark(); },
      onLogin: goToLogin,
    }), el);
  }

  async function mark(): Promise<void> {
    const s = view.summary;
    const p = pendingMark;
    if (!s || !p) return;
    view.busy = true;
    view.error = null;
    rerender();
    try {
      const res = await markExported(p.scope, p.cutoff);
      s.marked = typeof res?.marked === 'number' ? res.marked : s.count;
      s.markFailed = false;
      pendingMark = null;
      view.status = `${s.marked} film segnati come esportati.`;
      onMarked();
    } catch (err) {
      s.markFailed = true;
      Object.assign(view, noticeFrom(err, ctx));
      view.error = 'CSV scaricato, ma i film non sono stati segnati come esportati: ' + errorMessage(err);
    }
    view.busy = false;
    rerender();
  }

  async function run(): Promise<void> {
    if (view.busy) return;
    const scope = view.scope;
    Object.assign(view, { busy: true, status: 'Preparo il CSV…', summary: null, error: null, sessionExpired: false });
    pendingMark = null;
    rerender();
    try {
      const res = await exportCsv(scope);
      if (scope !== 'all' && !res.count) {
        view.busy = false;
        view.status = 'Nessun film da esportare per questa scelta.';
        rerender();
        return;
      }
      saveBlob(res.blob, res.filename);
      // Il blob è già stato ricevuto per intero: ora si può segnare (§9).
      view.summary = { filename: res.filename, count: res.count, scope, marked: null, markFailed: false };
      view.status = `CSV scaricato: ${res.filename}.`;
      view.busy = false;
      if (scope !== 'all') {
        if (!res.cutoff) {
          // Header mancante (API vecchia o proxy che lo filtra): non si può segnare.
          view.summary.markFailed = true;
          view.error = 'CSV scaricato, ma l\'API non ha indicato il cutoff dell\'export: film non segnati come esportati.';
          rerender();
        } else {
          pendingMark = { scope, cutoff: res.cutoff };
          await mark();
        }
      } else {
        rerender();
      }
      el.querySelector<HTMLElement>('.arrivals-summary')?.focus();
    } catch (err) {
      view.busy = false;
      view.status = '';
      Object.assign(view, noticeFrom(err, ctx));
      rerender();
    }
  }

  rerender();
  return { el, activate: () => {}, rerender, destroy: () => {} };
}

// ------------------------------------------------------------------ campi

/** Come l'API (docs/api.md): minuscole, cifre e «-», lettera iniziale, max 41. */
const NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
const EMPTY_NEW: NewFieldDraft = { name: '', title: '', type: 'line', multiple: false, allowed: '' };

function draftOf(f: ApiField): FieldDraft {
  return { title: f.title ?? '', groupable: !!f.groupable, groupMinSize: String(f.groupMinSize ?? ''), inForm: !!f.inForm };
}

export function createFieldsSection(ctx: SectionContext, onFieldsChanged: () => void): Section {
  const el = sectionRoot('arrivals-fields');
  const view: FieldsView = {
    fields: null, drafts: {}, busy: null, status: '', newField: { ...EMPTY_NEW }, newError: null,
    error: null, sessionExpired: false,
  };
  let seq = 0;

  function rerender(): void {
    render(fieldsTemplate(view, {
      onDraft: (name, patch) => {
        const f = view.fields?.find(x => x.name === name);
        if (!f) return;
        view.drafts[name] = { ...(view.drafts[name] ?? draftOf(f)), ...patch };
        rerender();
      },
      onSave: f => { void save(f); },
      onDelete: f => { void remove(f); },
      onNewDraft: patch => { view.newField = { ...view.newField, ...patch }; rerender(); },
      onCreate: () => { void create(); },
      onLogin: goToLogin,
    }), el);
  }

  /** Bozze con modifiche non salvate (sopravvivono a load). */
  function dirtyNames(): Set<string> {
    return new Set((view.fields ?? []).filter(f => isDirty(f, view.drafts[f.name])).map(f => f.name));
  }

  /** Nuove definizioni dal server (già ordinate per ordinal, poi nome). Le bozze
   *  modificate e non salvate delle altre righe restano; `saved` (riga appena
   *  salvata) riparte dal valore del server. */
  function setFields(list: ApiField[], saved?: string): void {
    const keep = dirtyNames();
    if (saved) keep.delete(saved);
    const drafts: Record<string, FieldDraft> = {};
    for (const f of list) drafts[f.name] = keep.has(f.name) ? view.drafts[f.name] : draftOf(f);
    view.fields = list;
    view.drafts = drafts;
  }

  async function load(saved?: string): Promise<void> {
    const n = ++seq;
    try {
      const list = await getFields();
      if (n !== seq) return;
      setFields(list, saved);
      view.error = null;
      view.sessionExpired = false;
    } catch (err) {
      if (n !== seq) return;
      view.fields = view.fields ?? [];
      Object.assign(view, noticeFrom(err, ctx));
    }
    rerender();
  }

  /** Dopo una modifica riuscita: rilegge i campi, avvisa le altre schede e
   *  ricarica la collezione (raggruppamenti e scheda film dipendono dai campi). */
  async function afterChange(status: string, saved?: string): Promise<void> {
    view.status = status;
    onFieldsChanged();
    await load(saved);
    const warn = await reloadCollection(ctx);
    if (warn) { view.error = warn; view.sessionExpired = false; rerender(); }
  }

  async function save(f: ApiField): Promise<void> {
    const d = view.drafts[f.name];
    if (!d || !isDirty(f, d) || view.busy) return;
    const patch: FieldPatch = {};
    const title = d.title.trim();
    if (title !== (f.title ?? '')) {
      if (!title) {
        view.error = `«${f.name}»: il titolo non può essere vuoto.`;
        view.sessionExpired = false;
        rerender();
        return;
      }
      patch.title = title;
    }
    if (d.groupable !== !!f.groupable) patch.groupable = d.groupable;
    if (d.inForm !== !!f.inForm) patch.inForm = d.inForm;
    if (d.groupMinSize.trim() !== String(f.groupMinSize ?? '')) {
      const n = Number(d.groupMinSize);
      if (!Number.isInteger(n) || n < 1 || n > 1000) {
        view.error = `«${f.title || f.name}»: la soglia deve essere un numero intero da 1 a 1000.`;
        view.sessionExpired = false;
        rerender();
        return;
      }
      patch.groupMinSize = n;
    }
    view.busy = f.name;
    view.error = null;
    view.status = '';
    rerender();
    try {
      await patchField(f.name, patch);
      view.busy = null;
      await afterChange(`Campo «${f.title || f.name}» aggiornato.`, f.name);
    } catch (err) {
      view.busy = null;
      Object.assign(view, noticeFrom(err, ctx));
      rerender();
    }
  }

  async function remove(f: ApiField): Promise<void> {
    if (view.busy) return;
    const label = f.title || f.name;
    const { yes, checked } = await confirmWithOption({
      title: 'ELIMINA', accent: 'CAMPO', danger: true,
      message: `Eliminare il campo «${label}» (${f.name})? Sparisce da modulo, raggruppamenti e scheda film.`,
      option: 'Cancella anche i valori di questo campo da tutti i film',
      yesLabel: 'ELIMINA', noLabel: 'ANNULLA',
    });
    if (!yes) return;
    view.busy = f.name;
    view.error = null;
    view.status = '';
    rerender();
    try {
      await deleteField(f.name, checked);
      view.busy = null;
      await afterChange(`Campo «${label}» eliminato${checked ? ' insieme ai suoi valori' : ''}.`, f.name);
      el.querySelector<HTMLElement>('#arrivalsFieldsTitle')?.focus();
    } catch (err) {
      view.busy = null;
      Object.assign(view, noticeFrom(err, ctx));
      rerender();
    }
  }

  async function create(): Promise<void> {
    if (view.busy) return;
    const n = view.newField;
    const name = n.name.trim();
    const title = n.title.trim();
    const allowed = n.type === 'choice' ? n.allowed.split(';').map(s => s.trim()).filter(Boolean) : null;
    let problem: string | null = null;
    if (!NAME_RE.test(name)) problem = 'Nome non valido: minuscole, cifre e «-», con una lettera all\'inizio (max 41 caratteri).';
    else if (view.fields?.some(f => f.name === name)) problem = `Esiste già un campo «${name}».`;
    else if (!title) problem = 'Il titolo è obbligatorio.';
    else if (allowed && !allowed.length) problem = 'Un campo a scelta richiede almeno un valore ammesso.';
    if (problem) {
      view.newError = problem;
      rerender();
      el.querySelector<HTMLElement>(problem.startsWith('Nome') || problem.startsWith('Esiste') ? '#nfName'
        : problem.startsWith('Il titolo') ? '#nfTitle' : '#nfAllowed')?.focus();
      return;
    }
    view.busy = '__new__';
    view.newError = null;
    view.error = null;
    view.status = '';
    rerender();
    try {
      await createField({ name, title, type: n.type, multiple: n.multiple, allowed });
      view.busy = null;
      view.newField = { ...EMPTY_NEW };
      await afterChange(`Campo «${title}» aggiunto.`);
    } catch (err) {
      view.busy = null;
      const notice = noticeFrom(err, ctx);
      view.newError = notice.error;
      view.sessionExpired = notice.sessionExpired;
      if (notice.sessionExpired) view.error = notice.error;
      rerender();
    }
  }

  rerender();
  return {
    el,
    // Con bozze non salvate non si ricarica: le definizioni mostrate sono quelle
    // su cui l'utente sta lavorando (si aggiornano al prossimo salvataggio).
    activate: () => { if (view.fields === null || !dirtyNames().size) void load(); },
    rerender,
    destroy: () => { seq++; },
  };
}
