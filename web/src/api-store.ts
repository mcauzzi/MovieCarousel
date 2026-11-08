import type { StoreAdapter, WatchStatus, Rating } from './store';
import { getState, putState } from './api';
import type { StateResponse } from './api';

/* StoreAdapter della modalità DB: visto/voto dell'utente corrente nel DB.
   - Cache in memoria caricata da GET state; i getter restano sincroni.
   - Setter ottimistici: aggiornano subito la cache e inviano il PUT. I PUT sulla
     stessa coppia (film, campo) sono serializzati: uno alla volta, e i valori
     arrivati nel frattempo si fondono nell'ultimo, così il server non può
     riceverli in ordine inverso. Se un PUT fallisce e non ne segue un altro,
     la cache torna all'ultimo valore confermato dal server, la vista si
     riallinea (onExternalChange) e l'errore va a `onWriteError`.
   - Le letture (load/refresh) portano un numero di generazione: una risposta
     più vecchia di una già applicata viene scartata. Le chiavi con scritture in
     volo, in coda o concluse durante la GET tengono il valore locale (lo
     snapshot del server per loro potrebbe essere vecchio).
   - Nessun seed (§5): setSeed/setSeedRating sono no-op.
   - Dopo il primo caricamento riuscito (startAutoRefresh) ricarica lo stato al
     ritorno della scheda in primo piano, al posto dell'evento `storage` della
     modalità .tc. Gli errori di quella ricarica vanno a `onRefreshError`. */

type Kind = 'status' | 'rating';
type StatusValue = Exclude<WatchStatus, null>;
type RatingValue = Exclude<Rating, null>;
type Value = StatusValue | RatingValue | null;

/** Stato delle scritture di una coppia (film, campo). Esiste solo finché ci
 *  sono scritture recenti: una lettura successiva la rimuove. */
interface Slot {
  /** Ultimo valore confermato dal server (ripristino su errore). */
  confirmed: Value;
  inFlight: boolean;
  /** Valore impostato mentre un PUT era in volo: parte appena quello finisce. */
  queued: { value: Value } | null;
  /** writeGen al termine dell'ultima scrittura. */
  doneAt: number;
}

export class ApiStoreAdapter implements StoreAdapter {
  private status = new Map<number, StatusValue>();
  private rating = new Map<number, RatingValue>();
  private onExternalChange: (() => void) | null = null;
  private slots = new Map<string, Slot>();
  /** Incrementato alla fine di ogni scrittura. */
  private writeGen = 0;
  /** Generazione dell'ultima lettura avviata / applicata. */
  private readGen = 0;
  private appliedGen = 0;
  private reloading = false;
  private autoRefresh = false;

  constructor(
    private readonly onWriteError: (err: unknown) => void,
    private readonly onRefreshError: (err: unknown) => void,
  ) {}

  setOnExternalChange(cb: () => void): void {
    this.onExternalChange = cb;
  }

  /** Aggancia la ricarica su visibilitychange (idempotente). Va chiamato solo
   *  dopo il controllo dei ruoli e il primo caricamento riuscito. */
  startAutoRefresh(): void {
    if (this.autoRefresh) return;
    this.autoRefresh = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.refresh();
    });
  }

  /** Carica lo stato dal server (all'avvio, al Reload, dopo una migrazione). */
  async load(): Promise<void> {
    await this.read(() => getState());
  }

  /** Ricarica in background (scheda tornata visibile). Sessione scaduta:
   *  niente navigazione (si perderebbe il contesto), decide il chiamante. */
  private async refresh(): Promise<void> {
    if (this.reloading) return;
    this.reloading = true;
    try {
      const before = this.snapshot();
      const applied = await this.read(() => getState({ navigateOnExpiry: false }));
      if (applied && this.snapshot() !== before) this.onExternalChange?.();
    } catch (err) {
      this.onRefreshError(err);
    } finally {
      this.reloading = false;
    }
  }

  /** GET dello stato e fusione con la cache. false se la risposta è stata
   *  scartata perché ne era già stata applicata una più recente. */
  private async read(get: () => Promise<StateResponse>): Promise<boolean> {
    const gen = ++this.readGen;
    const writesAtStart = this.writeGen;
    const state = await get();
    if (gen < this.appliedGen) return false;
    this.appliedGen = gen;

    const status = new Map<number, StatusValue>();
    const rating = new Map<number, RatingValue>();
    for (const [k, v] of Object.entries(state.status ?? {})) {
      const id = Number(k);
      if (Number.isFinite(id) && (v === 'seen' || v === 'watchlist')) status.set(id, v);
    }
    for (const [k, v] of Object.entries(state.rating ?? {})) {
      const id = Number(k);
      if (Number.isFinite(id) && typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5)
        rating.set(id, v as RatingValue);
    }

    for (const [key, slot] of this.slots) {
      const [kind, idText] = key.split(':') as [Kind, string];
      const id = Number(idText);
      if (slot.inFlight || slot.queued || slot.doneAt > writesAtStart) {
        // Snapshot forse precedente a queste scritture: resta il valore locale.
        const local = this.get(kind, id);
        const target: Map<number, Value> = kind === 'status' ? status : rating;
        if (local) target.set(id, local); else target.delete(id);
      } else {
        this.slots.delete(key);
      }
    }
    this.status = status;
    this.rating = rating;
    return true;
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
    this.set('status', id, status);
  }

  setRating(id: number, stars: Rating): void {
    this.set('rating', id, stars);
  }

  private get(kind: Kind, id: number): Value {
    return (kind === 'status' ? this.status.get(id) : this.rating.get(id)) ?? null;
  }

  private put(kind: Kind, id: number, value: Value): void {
    const map: Map<number, Value> = kind === 'status' ? this.status : this.rating;
    if (value) map.set(id, value); else map.delete(id);
  }

  private set(kind: Kind, id: number, value: Value): void {
    const key = `${kind}:${id}`;
    let slot = this.slots.get(key);
    if (!slot) {
      // Senza scritture recenti la cache coincide con l'ultimo valore del server.
      slot = { confirmed: this.get(kind, id), inFlight: false, queued: null, doneAt: 0 };
      this.slots.set(key, slot);
    }
    this.put(kind, id, value);
    if (slot.inFlight) slot.queued = { value };
    else this.send(kind, id, slot, value);
  }

  private send(kind: Kind, id: number, slot: Slot, value: Value): void {
    slot.inFlight = true;
    const patch = kind === 'status' ? { status: value as WatchStatus } : { rating: value as Rating };
    putState(id, patch).then(
      () => { slot.confirmed = value; return null; },
      (err: unknown) => err ?? new Error('PUT non riuscito'),
    ).then(failure => {
      slot.inFlight = false;
      slot.doneAt = ++this.writeGen;
      const next = slot.queued;
      slot.queued = null;
      if (next) {
        // Il valore più recente parte comunque: decide lui lo stato finale.
        this.send(kind, id, slot, next.value);
      } else if (failure && this.get(kind, id) !== slot.confirmed) {
        this.put(kind, id, slot.confirmed);
        this.onExternalChange?.();
      }
      if (failure) this.onWriteError(failure);
    });
  }
}
