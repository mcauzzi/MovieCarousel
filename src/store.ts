export type WatchStatus = 'seen' | 'watchlist' | null;
export type Rating = 1 | 2 | 3 | 4 | 5 | null;

export interface StoreAdapter {
  getStatus(id: number): WatchStatus;
  setStatus(id: number, status: WatchStatus): void;
  getRating(id: number): Rating;
  setRating(id: number, stars: Rating): void;
  /** Stato di base proveniente dal file .tc (campo "Visto"). Sovrascritto da scelte manuali. */
  setSeed(seed: Record<number, WatchStatus>): void;
  /** Voto di base proveniente dal file .tc (campo "Valutazione personale"). Sovrascritto da scelte manuali. */
  setSeedRating(seed: Record<number, Rating>): void;
}

export class LocalStorageAdapter implements StoreAdapter {
  private readonly statusKey = 'cm_status';
  private readonly ratingKey = 'cm_rating';
  private seed: Record<string, WatchStatus> = {};
  private seedRating: Record<string, Rating> = {};
  // Cache in memoria degli override: gli accessori sono chiamati una volta per film
  // a ogni render, quindi evitiamo di rifare JSON.parse di localStorage ogni volta.
  // Popolata al primo accesso, tenuta aggiornata dalle scritture.
  private statusCache: Record<string, WatchStatus> | null = null;
  private ratingCache: Record<string, Rating> | null = null;

  setSeed(seed: Record<number, WatchStatus>): void {
    this.seed = {};
    for (const [id, status] of Object.entries(seed)) this.seed[id] = status;
  }

  setSeedRating(seed: Record<number, Rating>): void {
    this.seedRating = {};
    for (const [id, stars] of Object.entries(seed)) this.seedRating[id] = stars;
  }

  private readStatus(): Record<string, WatchStatus> {
    if (this.statusCache) return this.statusCache;
    try {
      const parsed = JSON.parse(localStorage.getItem(this.statusKey) ?? '{}');
      this.statusCache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch { this.statusCache = {}; }
    return this.statusCache!;
  }

  private readRating(): Record<string, Rating> {
    if (this.ratingCache) return this.ratingCache;
    try {
      const parsed = JSON.parse(localStorage.getItem(this.ratingKey) ?? '{}');
      this.ratingCache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch { this.ratingCache = {}; }
    return this.ratingCache!;
  }

  getStatus(id: number): WatchStatus {
    const overrides = this.readStatus();
    const key = String(id);
    // Un override manuale (anche "nessuno") ha la precedenza sul seed del .tc.
    if (key in overrides) return overrides[key];
    return this.seed[key] ?? null;
  }

  setStatus(id: number, status: WatchStatus): void {
    // Salviamo sempre l'override esplicito (null incluso) così da poter
    // sovrascrivere lo stato di base "Visto" letto dal file .tc.
    const data = this.readStatus();
    data[String(id)] = status;
    this.statusCache = data;
    localStorage.setItem(this.statusKey, JSON.stringify(data));
  }

  getRating(id: number): Rating {
    const overrides = this.readRating();
    const key = String(id);
    // Un voto manuale (anche "nessuno") ha la precedenza sul seed del .tc.
    if (key in overrides) return overrides[key];
    return this.seedRating[key] ?? null;
  }

  setRating(id: number, stars: Rating): void {
    // Salviamo sempre l'override esplicito (null incluso) così da poter
    // sovrascrivere il voto di base letto dal file .tc.
    const data = this.readRating();
    data[String(id)] = stars;
    this.ratingCache = data;
    localStorage.setItem(this.ratingKey, JSON.stringify(data));
  }
}
