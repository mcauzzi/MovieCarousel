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
      const body = await res.json() as { title?: unknown; detail?: unknown };
      if (typeof body.title === 'string' && body.title) title = body.title;
      if (typeof body.detail === 'string' && body.detail) detail = body.detail;
    } else {
      const text = (await res.text()).trim();
      if (text && text.length < 300) detail = text;
    }
  } catch { /* corpo illeggibile: resta il codice HTTP */ }
  if (res.status === 403 && title === `HTTP 403`) title = 'Permesso negato';
  return new ApiError(res.status, title, detail);
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const isRead = method === 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
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
