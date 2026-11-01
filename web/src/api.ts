/* Client dell'API (modalità DB). Foglia: importa solo tipi.
   - Stesso origin, cookie di sessione dell'API (credentials: 'same-origin').
   - redirect: 'manual': se la sessione di Authelia è scaduta il forward auth di
     Caddy risponde con un redirect cross-origin che fetch non può seguire; con
     'manual' arriva come risposta `opaqueredirect` e lo trattiamo come un 401.
   - Sessione scaduta: le LETTURE navigano a auth/login?returnUrl=<pagina>; le
     SCRITTURE lanciano SessionExpiredError e decide il chiamante (toast ACCEDI).
   - Tutte le richieste non-GET portano l'header anti-CSRF `X-CM-Request: 1`.
   - Errori in application/problem+json → ApiError con title/detail. */

import type { Movie, CollectionField, TellicoField } from './parser';
import type { WatchStatus, Rating } from './store';

export interface Me {
  sub: string;
  name: string;
  roles: string[];
}

/** Definizione di campo come la restituisce l'API: superset di CollectionField. */
export type ApiField = CollectionField & { origin: string; inForm: boolean; ordinal: number };

export interface CollectionResponse {
  movies: Movie[];
  fields: ApiField[];
}

export interface StateResponse {
  status: Record<string, Exclude<WatchStatus, null>>;
  rating: Record<string, Exclude<Rating, null>>;
}

export type MigrateRequest = StateResponse;

export interface ImportResponse {
  inserted: number;
  updated: number;
  linked: number;
  unchanged: number;
  missing: { id: number; title: string }[];
  fieldsUpdated: number;
  /** Avvisi dell'import (es. EAN non validi ignorati), al più ~50 righe. */
  warnings?: string[];
}

/** Errore HTTP dell'API. `status` 0 = errore di rete. */
export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string | null;
  constructor(status: number, title: string, detail: string | null = null) {
    super(detail ? `${title}: ${detail}` : title);
    this.name = 'ApiError';
    this.status = status;
    this.title = title;
    this.detail = detail;
  }
}

/** Sessione dell'API (o del forward auth) scaduta: serve rifare il login. */
export class SessionExpiredError extends ApiError {
  constructor() {
    super(401, 'Sessione scaduta');
    this.name = 'SessionExpiredError';
  }
}

let apiBase = '';
let redirecting = false;

/** Prefisso degli endpoint (da config.json → apiBase, es. "./api/"). */
export function setApiBase(base: string): void {
  apiBase = base.endsWith('/') ? base : base + '/';
}

/** Navigazione completa al login OIDC con ritorno alla pagina corrente (solo
 *  percorso locale); una sola volta, anche con più letture in volo. */
export function goToLogin(): void {
  if (redirecting) return;
  redirecting = true;
  location.assign(apiUrl('auth/login?returnUrl=' + encodeURIComponent(location.pathname + location.search)));
}

interface RequestOptions {
  /** Per le letture: false = in caso di sessione scaduta lancia invece di navigare
   *  (ricariche in background, dove una navigazione farebbe perdere il contesto). */
  navigateOnExpiry?: boolean;
  /** Header Accept (default JSON). */
  accept?: string;
}

async function problemFrom(res: Response): Promise<ApiError> {
  let title = `HTTP ${res.status}`;
  let detail: string | null = null;
  const type = res.headers.get('content-type') ?? '';
  try {
    if (type.includes('json')) {
      const body = await res.json() as {
        title?: unknown; detail?: unknown; reason?: unknown; existingId?: unknown; errors?: unknown;
      };
      if (res.status === 409 && body.reason === 'ean') {
        // 409 dei film (docs/api.md): JSON semplice, `title` è il titolo del film già presente.
        const film = typeof body.title === 'string' && body.title ? `«${body.title}»` : 'un altro film';
        const id = typeof body.existingId === 'number' ? ` (#${body.existingId})` : '';
        return new ApiError(409, 'EAN già presente', `lo usa ${film}${id}`);
      }
      if (typeof body.title === 'string' && body.title) title = body.title;
      if (typeof body.detail === 'string' && body.detail) detail = body.detail;
      // Validation problem: { errors: { "<campo>": ["…"] } } → elenco leggibile.
      if (body.errors && typeof body.errors === 'object') {
        const list = Object.entries(body.errors as Record<string, unknown>)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' ') : String(v)}`);
        if (list.length) detail = list.join('; ');
      }
    } else {
      const text = (await res.text()).trim();
      if (text && text.length < 300) detail = text;
    }
  } catch { /* corpo illeggibile: resta il codice HTTP */ }
  if (res.status === 403 && title === `HTTP 403`) title = 'Permesso negato';
  return new ApiError(res.status, title, detail);
}

/** Invia una richiesta all'API e restituisce la risposta già verificata (2xx):
 *  sessione scaduta, errori di rete e problem+json diventano eccezioni. */
async function send(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<Response> {
  const isRead = method === 'GET';
  const headers: Record<string, string> = { Accept: opts.accept ?? 'application/json' };
  if (!isRead) headers['X-CM-Request'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(apiBase + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch (err) {
    // Errore di rete vero (API giù, offline). Con redirect:'manual' il redirect
    // del forward auth NON arriva qui ma come opaqueredirect (sotto), quindi non
    // lo trattiamo come sessione scaduta: navigare al login nasconderebbe un'API
    // irraggiungibile (e con l'API giù il login fallirebbe comunque).
    throw new ApiError(0, 'API non raggiungibile', (err as Error).message || null);
  }

  if (res.status === 401 || res.type === 'opaqueredirect') {
    if (isRead && opts.navigateOnExpiry !== false) goToLogin();
    throw new SessionExpiredError();
  }
  if (!res.ok) throw await problemFrom(res);
  return res;
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const res = await send(method, path, body, opts);
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    // Un 200 non JSON su un endpoint API è quasi sempre la pagina di login di un
    // proxy o l'index.html servito al posto dell'API: meglio un errore chiaro.
    throw new ApiError(res.status, 'Risposta inattesa dall\'API', type || null);
  }
  return await res.json() as T;
}

export const getMe = (): Promise<Me> => request('GET', 'me');
export const getCollection = (): Promise<CollectionResponse> => request('GET', 'collection');
export const getState = (opts?: RequestOptions): Promise<StateResponse> => request('GET', 'state', undefined, opts);

/** Un solo campo per richiesta: `{ status }` oppure `{ rating }` (null = azzera). */
export const putState = (id: number, patch: { status: WatchStatus } | { rating: Rating }): Promise<void> =>
  request('PUT', `state/${id}`, patch);

export const migrateState = (data: MigrateRequest): Promise<{ imported: number }> =>
  request('POST', 'state/migrate', data);

export const uploadTellicoImages = (images: Record<string, string>): Promise<{ written: number; skipped: number }> =>
  request('POST', 'import/tellico/images', { images });

export const importTellico = (fields: TellicoField[], movies: Movie[]): Promise<ImportResponse> =>
  request('POST', 'import/tellico', { fields, movies });

// --- Fase 3: abbinamento, dispositivi, arrivi, export, campi (§6.2) ---

/** URL assoluto di un endpoint (per <img src>, es. il QR di download). */
export function apiUrl(path: string): string {
  return new URL(apiBase + path, location.href).href;
}

export interface PairingResponse {
  code: string;
  /** Scadenza del codice (ISO 8601). */
  expiresAt: string;
  /** QR di abbinamento come documento SVG (solo qui il codice esiste in chiaro). */
  qrSvg: string;
}

export interface Device {
  /** uuid. */
  id: string;
  name: string;
  userSub: string;
  userName: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export type ArrivalScope = 'new' | 'app';
export type ExportScope = ArrivalScope | 'all';

export interface Arrival {
  id: number;
  ean: string | null;
  tmdbId: number | null;
  source: string;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  exportedAt: string | null;
  movie: Movie;
}

export interface NewFieldRequest {
  name: string;
  title: string;
  type: string;
  multiple: boolean;
  allowed: string[] | null;
}

export interface FieldPatch {
  title?: string;
  groupable?: boolean;
  groupMinSize?: number;
  inForm?: boolean;
  ordinal?: number;
  allowed?: string[] | null;
}

export interface ExportResult {
  blob: Blob;
  /** Istante di taglio dell'export (header X-CM-Export-Cutoff, ISO 8601). */
  cutoff: string;
  /** Righe del CSV che arrivano dall'app (header X-CM-Export-Count). */
  count: number;
  filename: string;
}

/** Parte di /app/version.json (immagine del sito con l'APK, §11.1) usata dal
 *  sito: il file ha anche versionCode, minSupportedCode e commit. */
export interface AppVersion {
  version: string;
  sha256: string;
}

const seg = (v: string | number): string => encodeURIComponent(String(v));

export const createPairing = (): Promise<PairingResponse> => request('POST', 'pairing');

/** Dispositivi dell'utente; `all` (solo amministratore) quelli di tutti. */
export const getDevices = (all = false): Promise<Device[]> => request('GET', all ? 'devices?all=true' : 'devices');
export const revokeDevice = (id: Device['id']): Promise<void> => request('DELETE', `devices/${seg(id)}`);
export const revokeUserDevices = (sub: string): Promise<void> => request('DELETE', `users/${seg(sub)}/devices`);
export const revokeUserSessions = (sub: string): Promise<void> => request('DELETE', `users/${seg(sub)}/sessions`);

export const getArrivals = (scope: ArrivalScope): Promise<Arrival[]> => request('GET', `arrivals?scope=${scope}`);

/** Correzione di un arrivo: `movie` contiene solo i campi modificati
 *  (null = svuota un campo singolo, [] un campo multiplo). */
export const patchMovie = (id: number, movie: Record<string, unknown>): Promise<Arrival> =>
  request('PATCH', `movies/${seg(id)}`, { movie });

export const deleteMovie = (id: number): Promise<void> => request('DELETE', `movies/${seg(id)}`);

/** Nome del file da Content-Disposition (filename* RFC 5987 prima di filename). */
function filenameFrom(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* malformato */ }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(header);
  const name = (plain?.[2] ?? plain?.[1] ?? '').trim();
  // Solo il nome, mai un percorso.
  return name ? name.replace(/^.*[\\/]/, '') || fallback : fallback;
}

/** Scarica il CSV per Tellico. Non segna nulla: dopo il download completo,
 *  per gli scope new/app con `count` > 0, il chiamante invoca
 *  markExported(scope, cutoff) (§9). Sessione scaduta: lancia senza navigare
 *  (è un'azione esplicita dell'utente nel pannello, decide il chiamante). */
export async function exportCsv(scope: ExportScope): Promise<ExportResult> {
  const res = await send('GET', `export/csv?scope=${seg(scope)}`, undefined,
    { accept: 'text/csv', navigateOnExpiry: false });
  const cutoff = res.headers.get('X-CM-Export-Cutoff') ?? '';
  const rawCount = Number(res.headers.get('X-CM-Export-Count'));
  const count = Number.isInteger(rawCount) && rawCount > 0 ? rawCount : 0;
  const blob = await res.blob();
  const date = new Date().toISOString().slice(0, 10);
  return { blob, cutoff, count, filename: filenameFrom(res.headers.get('Content-Disposition'), `cinemanager-${scope}-${date}.csv`) };
}

/** Segna come esportati gli arrivi dello scope fino al cutoff restituito
 *  dall'export (header X-CM-Export-Cutoff, passato così com'è). */
export const markExported = (scope: ArrivalScope, cutoff: string): Promise<{ marked: number }> =>
  request('POST', 'export/mark', { scope, cutoff });

export const getFields = (): Promise<ApiField[]> => request('GET', 'fields');
export const createField = (def: NewFieldRequest): Promise<ApiField> => request('POST', 'fields', def);
export const patchField = (name: string, patch: FieldPatch): Promise<ApiField> =>
  request('PATCH', `fields/${seg(name)}`, patch);
export const deleteField = (name: string, purge: boolean): Promise<void> =>
  request('DELETE', `fields/${seg(name)}?purge=${purge}`);

/** URL dell'APK e della sua versione: file statici dell'immagine del sito,
 *  relativi alla pagina (non passano dall'API). */
export const APK_URL = 'app/cinemanager.apk';
const VERSION_URL = 'app/version.json';

/** Legge /app/version.json. null = app non disponibile in questa build (404,
 *  index.html servito al suo posto in sviluppo, JSON non valido, rete). */
export async function getAppVersion(): Promise<AppVersion | null> {
  try {
    const res = await fetch(VERSION_URL, { cache: 'no-cache', credentials: 'same-origin', redirect: 'manual' });
    if (!res.ok) return null;
    const v = await res.json() as Partial<AppVersion>;
    if (!v || typeof v.version !== 'string' || !v.version) return null;
    return { version: v.version, sha256: typeof v.sha256 === 'string' ? v.sha256 : '' };
  } catch {
    return null;
  }
}
