export type WatchStatus = 'seen' | 'watchlist' | null;
export type Rating = 1 | 2 | 3 | 4 | 5 | null;

export interface StoreAdapter {
  getStatus(id: number): WatchStatus;
  setStatus(id: number, status: WatchStatus): void;
  getRating(id: number): Rating;
  setRating(id: number, stars: Rating): void;
}

export class LocalStorageAdapter implements StoreAdapter {
  private readonly statusKey = 'cm_status';
  private readonly ratingKey = 'cm_rating';

  private readStatus(): Record<string, WatchStatus> {
    try { return JSON.parse(localStorage.getItem(this.statusKey) ?? '{}'); }
    catch { return {}; }
  }

  private readRating(): Record<string, Rating> {
    try { return JSON.parse(localStorage.getItem(this.ratingKey) ?? '{}'); }
    catch { return {}; }
  }

  getStatus(id: number): WatchStatus {
    return this.readStatus()[String(id)] ?? null;
  }

  setStatus(id: number, status: WatchStatus): void {
    const data = this.readStatus();
    if (status === null) delete data[String(id)];
    else data[String(id)] = status;
    localStorage.setItem(this.statusKey, JSON.stringify(data));
  }

  getRating(id: number): Rating {
    return this.readRating()[String(id)] ?? null;
  }

  setRating(id: number, stars: Rating): void {
    const data = this.readRating();
    if (stars === null) delete data[String(id)];
    else data[String(id)] = stars;
    localStorage.setItem(this.ratingKey, JSON.stringify(data));
  }
}
