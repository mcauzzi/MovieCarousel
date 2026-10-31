import { render } from 'lit';
import { getArrivals, getFields, patchMovie, deleteMovie, goToLogin } from './api';
import type { ApiField, Arrival } from './api';
import { listTemplate } from './templates/arrivals-list.templates';
import type { DraftValue, FormField, ListView } from './templates/arrivals-list.templates';
import { confirmDialog } from './db-ui';
import { coverUrl, isTrueValue } from './utils';
import { sectionRoot, noticeFrom, reloadCollection } from './arrivals-shared';
import type { Section, SectionContext } from './arrivals-shared';

/* Scheda ARRIVI: lista dei film dall'app (propri per l'utente, tutti per
   l'amministratore: lo decide l'API), correzione con un modulo costruito dai
   campi `inForm` e eliminazione. Dopo ogni modifica la collezione principale
   viene ricaricata (ctx.onCollectionChanged). */

/** Tipi mai modificabili dal modulo. */
const SKIP_TYPES = new Set(['image', 'dependent']);

function toFormFields(fields: ApiField[]): FormField[] {
  return fields
    .filter(f => f.inForm && !SKIP_TYPES.has(f.type))
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
    .map(f => {
      const allowed = (f.allowed ?? []).filter(Boolean);
      let control: FormField['control'];
      let hint: string | null = null;
      if (f.type === 'table') {
        control = 'table';
        hint = 'Righe separate da «;», colonne da «::» (es. Attore::Ruolo; Attrice::Ruolo).';
      } else if (f.type === 'bool') control = 'bool';
      else if (f.multiple) {
        control = 'list';
        hint = 'Più valori separati da «;».' + (allowed.length ? ` Ammessi: ${allowed.join(', ')}.` : '');
      } else if (f.type === 'para') control = 'textarea';
      else if (f.type === 'number' || f.type === 'rating') control = 'number';
      else if (f.type === 'date') control = 'date';
      else if (f.type === 'choice' && allowed.length) control = 'choice';
      else control = 'text';
      return { name: f.name, label: f.title || f.name, control, allowed, hint };
    });
}

function rowsOf(v: unknown): string[][] {
  if (!Array.isArray(v)) return v ? [[String(v)]] : [];
  return v.map(r => {
    if (Array.isArray(r)) return r.map(c => String(c ?? ''));
    if (r && typeof r === 'object') {
      const o = r as { actor?: unknown; role?: unknown };
      return [String(o.actor ?? ''), String(o.role ?? '')];
    }
    return [String(r ?? '')];
  });
}

/** Valore del modulo per un campo del film. */
function draftOf(f: FormField, raw: unknown): DraftValue {
  switch (f.control) {
    case 'bool': return isTrueValue(raw);
    case 'table':
      return rowsOf(raw).map(r => r.join('::').replace(/(::)+$/, '')).filter(Boolean).join('; ');
    case 'list': return Array.isArray(raw) ? raw.map(String).join('; ') : raw == null ? '' : String(raw);
    default: return raw == null ? '' : Array.isArray(raw) ? raw.map(String).join('; ') : String(raw);
  }
}

const splitList = (s: string): string[] => s.split(';').map(x => x.trim()).filter(Boolean);

/** Valore da inviare all'API (null = svuota un campo singolo, [] uno multiplo). */
function apiValue(f: FormField, v: DraftValue): unknown {
  if (f.control === 'bool') return v === true ? true : null;
  const s = String(v).trim();
  switch (f.control) {
    case 'list': return splitList(s);
    case 'table': {
      const rows = splitList(s).map(r => r.split('::').map(c => c.trim()));
      return f.name === 'cast' ? rows.map(([actor, ...role]) => ({ actor, role: role.join('::') })) : rows;
    }
    case 'number': {
      if (!s) return null;
      const n = Number(s.replace(',', '.'));
      if (!Number.isFinite(n)) throw new Error(`«${f.label}»: non è un numero`);
      return n;
    }
    default: return s || null;
  }
}

export interface ListSection extends Section {
  /** Le definizioni dei campi sono cambiate (scheda CAMPI): rileggile. */
  invalidateFields: () => void;
  /** Gli arrivi sono cambiati altrove (es. export segnato): ricarica alla prossima attivazione. */
  invalidate: () => void;
}

export function createListSection(ctx: SectionContext): ListSection {
  const el = sectionRoot('arrivals-arrivals');
  const empty = new Map<string, string>();

  const view: ListView = {
    scope: 'new',
    items: null,
    coverFor: a => coverUrl(a.movie, empty, ctx.imgDir),
    edit: null,
    busyId: null,
    status: '',
    error: null,
    sessionExpired: false,
  };
  let formFields: FormField[] | null = null;
  let original: Record<string, DraftValue> = {};
  let stale = true;
  let seq = 0;

  function rerender(): void {
    render(listTemplate(view, {
      onScope: s => { if (s !== view.scope) { view.scope = s; view.edit = null; void load(); } },
      onEdit: a => { void startEdit(a); },
      onCancelEdit: () => cancelEdit(),
      onDraft: (name, value) => { if (view.edit) view.edit.draft[name] = value; },
      onSave: () => { void save(); },
      onDelete: a => { void remove(a); },
      onLogin: goToLogin,
    }), el);
  }

  async function load(): Promise<void> {
    const n = ++seq;
    stale = false;
    view.items = view.items && view.items.length ? view.items : null;
    rerender();
    try {
      const items = await getArrivals(view.scope);
      if (n !== seq) return;
      view.items = [...items].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
      view.error = null;
      view.sessionExpired = false;
    } catch (err) {
      if (n !== seq) return;
      view.items = view.items ?? [];
      Object.assign(view, noticeFrom(err, ctx));
    }
    rerender();
  }

  function focusItemButton(id: number): void {
    const idx = view.items?.findIndex(a => a.id === id) ?? -1;
    const btn = idx >= 0 ? el.querySelectorAll<HTMLElement>('.arrivals-item')[idx]?.querySelector<HTMLElement>('button') : null;
    (btn ?? el.querySelector<HTMLElement>('#arrivalsListTitle'))?.focus();
  }

  async function startEdit(a: Arrival): Promise<void> {
    view.edit = { movieId: a.id, fields: formFields, draft: {}, saving: false, error: null };
    rerender();
    if (!formFields) {
      try {
        formFields = toFormFields(await getFields());
      } catch (err) {
        view.edit = null;
        Object.assign(view, noticeFrom(err, ctx));
        rerender();
        return;
      }
      if (view.edit?.movieId !== a.id) return;
    }
    original = {};
    for (const f of formFields) original[f.name] = draftOf(f, a.movie[f.name]);
    view.edit = { movieId: a.id, fields: formFields, draft: { ...original }, saving: false, error: null };
    rerender();
    el.querySelector<HTMLElement>('.arrivals-form-title')?.focus();
  }

  function cancelEdit(): void {
    const id = view.edit?.movieId;
    if (view.edit?.saving) return;
    view.edit = null;
    rerender();
    if (id !== undefined) focusItemButton(id);
  }

  async function save(): Promise<void> {
    const e = view.edit;
    if (!e || !e.fields || e.saving) return;
    const patch: Record<string, unknown> = {};
    try {
      for (const f of e.fields) {
        if (e.draft[f.name] === original[f.name]) continue;
        patch[f.name] = apiValue(f, e.draft[f.name]);
      }
    } catch (err) {
      e.error = (err as Error).message;
      rerender();
      return;
    }
    const item = view.items?.find(a => a.id === e.movieId);
    const title = item?.movie.title || 'film';
    if (!Object.keys(patch).length) {
      view.status = 'Nessuna modifica da salvare.';
      cancelEdit();
      return;
    }
    e.saving = true;
    e.error = null;
    view.error = null;
    rerender();
    try {
      const updated = await patchMovie(e.movieId, patch);
      if (view.items && updated && typeof updated === 'object' && 'movie' in updated)
        view.items = view.items.map(a => (a.id === updated.id ? updated : a));
      else stale = true;
      view.edit = null;
      view.status = `«${updated?.movie?.title || title}» aggiornato.`;
      rerender();
      focusItemButton(e.movieId);
      const warn = await reloadCollection(ctx);
      if (warn) { view.error = warn; view.sessionExpired = false; }
      if (stale) await load(); else rerender();
    } catch (err) {
      e.saving = false;
      const n = noticeFrom(err, ctx);
      e.error = n.error;
      view.sessionExpired = n.sessionExpired;
      if (n.sessionExpired) view.error = n.error;
      rerender();
    }
  }

  async function remove(a: Arrival): Promise<void> {
    const title = a.movie.title || 'senza titolo';
    const ok = await confirmDialog({
      title: 'ELIMINA', accent: 'ARRIVO', danger: true,
      message: `Eliminare «${title}»${a.ean ? ` (EAN ${a.ean})` : ''} dalla collezione? L'operazione non si può annullare.`,
      yesLabel: 'ELIMINA', noLabel: 'ANNULLA',
    });
    if (!ok) return;
    view.busyId = a.id;
    view.error = null;
    view.status = '';
    rerender();
    try {
      await deleteMovie(a.id);
      if (view.edit?.movieId === a.id) view.edit = null;
      view.items = view.items?.filter(x => x.id !== a.id) ?? null;
      view.status = `«${title}» eliminato.`;
      view.busyId = null;
      rerender();
      el.querySelector<HTMLElement>('#arrivalsListTitle')?.focus();
      const warn = await reloadCollection(ctx);
      if (warn) { view.error = warn; view.sessionExpired = false; rerender(); }
    } catch (err) {
      view.busyId = null;
      Object.assign(view, noticeFrom(err, ctx));
      rerender();
      focusItemButton(a.id);
    }
  }

  rerender();
  return {
    el,
    activate: () => { if (stale || view.items === null) void load(); },
    rerender,
    destroy: () => { seq++; },
    invalidateFields: () => { formFields = null; if (view.edit) view.edit = null; },
    invalidate: () => { stale = true; },
  };
}

