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

export interface MigrateRequest {
  status: Record<string, Exclude<WatchStatus, null>>;
  rating: Record<string, Exclude<Rating, null>>;
}

export interface ImagesResponse {
  written: number;
  skipped: number;
}

export interface ImportResponse {
  inserted: number;
  updated: number;
  linked: number;
  unchanged: number;
  missing: { id: number; title: string }[];
  fieldsUpdated: number;
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

/** URL di login con ritorno alla pagina corrente (solo percorso locale). */
export function loginUrl(): string {
  const returnUrl = location.pathname + location.search;
  return new URL(apiBase + 'auth/login?returnUrl=' + encodeURIComponent(returnUrl), location.href).href;
}

/** Navigazione completa al login OIDC (una sola volta, anche con più letture in volo). */
export function goToLogin(): void {
  if (redirecting) return;
  redirecting = true;
  location.assign(loginUrl());
}

interface RequestOptions {
  /** Per le letture: false = in caso di sessione scaduta lancia invece di navigare
   *  (ricariche in background, dove una navigazione farebbe perdere il contesto). */
  navigateOnExpiry?: boolean;
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

interface SendOptions extends RequestOptions {
  /** Header Accept (default JSON). */
  accept?: string;
}

/** Invia una richiesta all'API e restituisce la risposta già verificata (2xx):
 *  sessione scaduta, errori di rete e problem+json diventano eccezioni. */
async function send(method: string, path: string, body?: unknown, opts: SendOptions = {}): Promise<Response> {
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

export function getMe(): Promise<Me> {
  return request<Me>('GET', 'me');
}

export function getCollection(): Promise<CollectionResponse> {
  return request<CollectionResponse>('GET', 'collection');
}

export function getState(opts?: RequestOptions): Promise<StateResponse> {
  return request<StateResponse>('GET', 'state', undefined, opts);
}

export function putStatus(id: number, status: WatchStatus): Promise<void> {
  return request<void>('PUT', `state/${id}`, { status });
}

export function putRating(id: number, rating: Rating): Promise<void> {
  return request<void>('PUT', `state/${id}`, { rating });
}

export function migrateState(data: MigrateRequest): Promise<{ imported: number }> {
  return request<{ imported: number }>('POST', 'state/migrate', data);
}

export function uploadTellicoImages(images: Record<string, string>): Promise<ImagesResponse> {
  return request<ImagesResponse>('POST', 'import/tellico/images', { images });
}

export function importTellico(fields: TellicoField[], movies: Movie[]): Promise<ImportResponse> {
  return request<ImportResponse>('POST', 'import/tellico', { fields, movies });
}

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
  /** Id dei film inclusi nel CSV (header X-CM-Movie-Ids). */
  ids: number[];
  filename: string;
}

/** Contenuto di /app/version.json (immagine del sito con l'APK, §11.1). */
export interface AppVersion {
  version: string;
  versionCode: number;
  minSupportedCode: number;
  sha256: string;
  commit: string;
}

const seg = (v: string | number): string => encodeURIComponent(String(v));

export function createPairing(): Promise<PairingResponse> {
  return request<PairingResponse>('POST', 'pairing');
}

/** Dispositivi dell'utente; `all` (solo amministratore) quelli di tutti. */
export function getDevices(all = false): Promise<Device[]> {
  return request<Device[]>('GET', all ? 'devices?all=true' : 'devices');
}

export function revokeDevice(id: Device['id']): Promise<void> {
  return request<void>('DELETE', `devices/${seg(id)}`);
}

export function revokeUserDevices(sub: string): Promise<void> {
  return request<void>('DELETE', `users/${seg(sub)}/devices`);
}

export function revokeUserSessions(sub: string): Promise<void> {
  return request<void>('DELETE', `users/${seg(sub)}/sessions`);
}

export function getArrivals(scope: ArrivalScope): Promise<Arrival[]> {
  return request<Arrival[]>('GET', `arrivals?scope=${scope}`);
}

/** Correzione di un arrivo: `movie` contiene solo i campi modificati
 *  (null = svuota un campo singolo, [] un campo multiplo). */
export function patchMovie(id: number, movie: Record<string, unknown>): Promise<Arrival> {
  return request<Arrival>('PATCH', `movies/${seg(id)}`, { movie });
}

export function deleteMovie(id: number): Promise<void> {
  return request<void>('DELETE', `movies/${seg(id)}`);
}

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

/** Scarica il CSV per Tellico. Non segna nulla: dopo il download completo il
 *  chiamante invoca markExported(ids) (§9). */
export async function exportCsv(scope: ExportScope): Promise<ExportResult> {
  const res = await send('POST', 'export/csv', { scope }, { accept: 'text/csv' });
  const ids = (res.headers.get('X-CM-Movie-Ids') ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0);
  const blob = await res.blob();
  const date = new Date().toISOString().slice(0, 10);
  return { blob, ids, filename: filenameFrom(res.headers.get('Content-Disposition'), `cinemanager-${scope}-${date}.csv`) };
}

export function markExported(ids: number[]): Promise<{ marked: number }> {
  return request<{ marked: number }>('POST', 'export/mark', { ids });
}

export function getFields(): Promise<ApiField[]> {
  return request<ApiField[]>('GET', 'fields');
}

export function createField(def: NewFieldRequest): Promise<ApiField> {
  return request<ApiField>('POST', 'fields', def);
}

export function patchField(name: string, patch: FieldPatch): Promise<ApiField> {
  return request<ApiField>('PATCH', `fields/${seg(name)}`, patch);
}

export function deleteField(name: string, purge: boolean): Promise<void> {
  return request<void>('DELETE', `fields/${seg(name)}?purge=${purge}`);
}

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
    return {
      version: v.version,
      versionCode: Number(v.versionCode) || 0,
      minSupportedCode: Number(v.minSupportedCode) || 0,
      sha256: typeof v.sha256 === 'string' ? v.sha256 : '',
      commit: typeof v.commit === 'string' ? v.commit : '',
    };
  } catch {
    return null;
  }
}
