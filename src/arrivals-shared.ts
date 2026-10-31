import { ApiError, SessionExpiredError } from './api';

/* Contratto comune alle sezioni del pannello ARRIVI (arrivals-*.ts).
   Ogni sezione possiede un elemento radice in cui lit-renderizza il proprio
   template e tiene lo stato UI in closure (come FILTRI/RANDOM); i dati di
   dominio restano in main.ts, che il pannello richiama con
   `onCollectionChanged` quando una modifica tocca la collezione. */

export interface SectionContext {
  isAdmin: boolean;
  /** `sub` dell'utente corrente (per riconoscere i propri dispositivi). */
  sub: string;
  /** Cartella delle copertine (config.json → imgDir). */
  imgDir: string;
  /** Ricarica collezione e stato dall'API nella vista principale. */
  onCollectionChanged: () => Promise<void>;
  /** Sessione scaduta durante una scrittura (avviso ACCEDI di main). */
  onSessionExpired: () => void;
}

export interface Section {
  el: HTMLElement;
  /** La scheda della sezione è diventata visibile: carica i dati se servono. */
  activate: () => void;
  /** La scheda non è più visibile (altra scheda o pannello chiuso): ferma timer
   *  e polling. Facoltativo. */
  deactivate?: () => void;
  rerender: () => void;
  destroy: () => void;
}

export function sectionRoot(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

/** Messaggio leggibile per un errore dell'API (problem+json → title/detail). */
export function errorMessage(err: unknown): string {
  if (err instanceof SessionExpiredError) return 'Sessione scaduta: accedi di nuovo e ripeti l\'operazione.';
  if (err instanceof ApiError) {
    if (err.status === 403 && err.title === 'Permesso negato' && !err.detail)
      return 'Permesso negato: operazione non consentita al tuo utente.';
    if (err.status === 413) return 'Richiesta troppo grande per l\'API (413).';
    return err.message;
  }
  return (err as Error)?.message || String(err);
}

/** Stato d'errore comune: messaggio + flag "sessione scaduta" (pulsante ACCEDI). */
export function noticeFrom(err: unknown, ctx: SectionContext): { error: string; sessionExpired: boolean } {
  console.error(err);
  const sessionExpired = err instanceof SessionExpiredError;
  if (sessionExpired) ctx.onSessionExpired();
  return { error: errorMessage(err), sessionExpired };
}

/** Ricarica la collezione dopo una modifica; un errore qui non annulla la
 *  modifica già salvata, quindi diventa solo un avviso. */
export async function reloadCollection(ctx: SectionContext): Promise<string | null> {
  try {
    await ctx.onCollectionChanged();
    return null;
  } catch (err) {
    console.error(err);
    return 'Salvato, ma la ricarica della collezione non è riuscita: usa ↻ Reload. (' + errorMessage(err) + ')';
  }
}
