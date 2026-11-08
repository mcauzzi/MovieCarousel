import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';

/* Pezzi condivisi dalle sezioni del pannello ARRIVI: date, riquadro d'errore
   (role="alert", con ACCEDI se la sessione è scaduta), riga di stato
   (aria-live="polite"). Puri: solo lit. */

/** Data e ora locali (it-IT) da ISO 8601; '' se assente o non valida. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
}

export interface Notice {
  error: string | null;
  sessionExpired: boolean;
}

export function errorTemplate(n: Notice, onLogin: () => void): TemplateResult | typeof nothing {
  if (!n.error) return nothing;
  return html`
    <div class="arrivals-error" role="alert">
      <span>✕ ${n.error}</span>
      ${n.sessionExpired ? html`<button type="button" class="group-btn arrivals-login" @click=${onLogin}>ACCEDI</button>` : nothing}
    </div>`;
}

/** Riga di stato annunciata dagli screen reader (sempre nel DOM, anche vuota,
 *  così la regione live esiste prima che il testo cambi). */
export function statusTemplate(text: string): TemplateResult {
  return html`<p class="arrivals-status" role="status" aria-live="polite">${text}</p>`;
}
