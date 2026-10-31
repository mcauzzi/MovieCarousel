import type { StoreAdapter, WatchStatus, Rating } from './store';
import { getState, putStatus, putRating } from './api';

/* StoreAdapter della modalità DB: visto/voto dell'utente corrente nel DB.
   - Cache in memoria caricata da GET state; i getter restano sincroni.
   - Setter ottimistici: aggiornano subito la cache e inviano il PUT; se fallisce
     ripristinano il valore precedente, notificano onExternalChange (la vista si
     ri-allinea) e passano l'errore a `onWriteError` (toast / ACCEDI nel chiamante).
   - Nessun seed (§5): setSeed/setSeedRating sono no-op.
   - Al ritorno della scheda in primo piano (visibilitychange) ricarica lo stato,
     al posto dell'evento `storage` della modalità .tc. */

type Kind = 'status' | 'rating';

export class ApiStoreAdapter implements StoreAdapter {
  private status = new Map<number, Exclude<WatchStatus, null>>();
  private rating = new Map<number, Exclude<Rating, null>>();
  private onExternalChange: (() => void) | null = null;
  /** Numero di sequenza dell'ultima scrittura per id+tipo: un PUT fallito
   *  ripristina solo se nel frattempo non ne è partito uno più recente. */
  private seq = new Map<string, number>();
  private pending = 0;
  private reloading = false;

  constructor(private readonly onWriteError: (err: unknown) => void) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.refresh();
    });
  }

  setOnExternalChange(cb: () => void): void {
    this.onExternalChange = cb;
  }

  /** Carica lo stato dal server (all'avvio, al Reload, dopo una migrazione). */
  async load(): Promise<void> {
    this.apply(await getState());
  }

  private apply(state: { status?: Record<string, unknown>; rating?: Record<string, unknown> }): void {
    const status = new Map<number, Exclude<WatchStatus, null>>();
    const rating = new Map<number, Exclude<Rating, null>>();
    for (const [k, v] of Object.entries(state.status ?? {})) {
      const id = Number(k);
      if (Number.isFinite(id) && (v === 'seen' || v === 'watchlist')) status.set(id, v);
    }
    for (const [k, v] of Object.entries(state.rating ?? {})) {
      const id = Number(k);
      if (Number.isFinite(id) && typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5)
        rating.set(id, v as Exclude<Rating, null>);
    }
    this.status = status;
    this.rating = rating;
  }

  /** Ricarica in background (scheda tornata visibile). Saltata con scritture in
   *  volo, che altrimenti verrebbero sovrascritte dal valore vecchio del server.
   *  Sessione scaduta: niente navigazione (si perderebbe il contesto), l'errore
   *  va al chiamante come per le scritture. */
  private async refresh(): Promise<void> {
    if (this.pending > 0 || this.reloading) return;
    this.reloading = true;
    try {
      const state = await getState({ navigateOnExpiry: false });
      if (this.pending > 0) return;
      const before = this.snapshot();
      this.apply(state);
      if (this.snapshot() !== before) this.onExternalChange?.();
    } catch (err) {
      this.onWriteError(err);
    } finally {
      this.reloading = false;
    }
  }

  private snapshot(): string {
    return JSON.stringify([[...this.status].sort(), [...this.rating].sort()]);
  }

  setSeed(): void { /* nessun seed in modalità DB (§5) */ }
  setSeedRating(): void { /* nessun seed in modalità DB (§5) */ }

  getStatus(id: number): WatchStatus {
    return this.status.get(id) ?? null;
  }

  getRating(id: number): Rating {
    return this.rating.get(id) ?? null;
  }

  setStatus(id: number, status: WatchStatus): void {
    const prev = this.getStatus(id);
    if (status) this.status.set(id, status); else this.status.delete(id);
    this.send('status', id, () => putStatus(id, status), () => {
      if (prev) this.status.set(id, prev); else this.status.delete(id);
    });
  }

  setRating(id: number, stars: Rating): void {
    const prev = this.getRating(id);
    if (stars) this.rating.set(id, stars); else this.rating.delete(id);
    this.send('rating', id, () => putRating(id, stars), () => {
      if (prev) this.rating.set(id, prev); else this.rating.delete(id);
    });
  }

  private send(kind: Kind, id: number, put: () => Promise<void>, restore: () => void): void {
    const key = `${kind}:${id}`;
    const n = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, n);
    this.pending++;
    put()
      .catch(err => {
        if (this.seq.get(key) === n) {
          restore();
          this.onExternalChange?.();
        }
        this.onWriteError(err);
      })
      .finally(() => { this.pending--; });
  }
}
