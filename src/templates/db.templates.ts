import { html } from 'lit';
import type { TemplateResult } from 'lit';

/* Template della modalità DB fuori dal pannello ARRIVI: dialog di conferma
   (migrazione di localStorage), avviso "sessione scaduta" con ACCEDI, vista
   della collezione vuota. Stesse classi random-* dei popup, così ogni tema
   li veste senza regole dedicate. */

export interface ConfirmView {
  title: string;
  accent: string;
  message: string;
  yesLabel: string;
  noLabel: string;
}

export function confirmDialogTemplate(v: ConfirmView, onYes: () => void, onNo: () => void): TemplateResult {
  return html`
    <div class="random-panel cm-confirm-panel" role="dialog" aria-modal="true"
      aria-labelledby="cmConfirmTitle" aria-describedby="cmConfirmMsg">
      <div class="random-header">
        <h2 class="random-title" id="cmConfirmTitle">${v.title} <span class="random-title-accent">${v.accent}</span></h2>
      </div>
      <p class="cm-confirm-msg" id="cmConfirmMsg">${v.message}</p>
      <div class="random-footer cm-confirm-actions">
        <button class="group-btn cm-confirm-no" @click=${onNo}>${v.noLabel}</button>
        <button class="random-extract-btn cm-confirm-yes" @click=${onYes}>${v.yesLabel}</button>
      </div>
    </div>`;
}

export function sessionNoticeTemplate(
  visible: boolean,
  onLogin: () => void,
  onDismiss: () => void
): TemplateResult {
  if (!visible) return html``;
  return html`
    <div class="cm-session-notice" role="alert">
      <span class="cm-session-msg">Sessione scaduta: la modifica non è stata salvata.</span>
      <button class="group-btn cm-session-login" @click=${onLogin}>ACCEDI</button>
      <button class="cm-session-close" aria-label="Chiudi avviso" @click=${onDismiss}>✕</button>
    </div>`;
}

export function emptyCollectionTemplate(isAdmin: boolean): TemplateResult {
  return html`
    <section class="cm-empty" aria-labelledby="cmEmptyTitle">
      <h2 class="cm-empty-title" id="cmEmptyTitle">Collezione vuota</h2>
      <p class="cm-empty-text">${isAdmin
        ? html`Nessun film nel database. Apri <b>ARRIVI</b> e usa <b>IMPORTA DA TELLICO</b> per caricare la collezione.`
        : 'Nessun film nel database: chiedi a un amministratore di importare la collezione.'}</p>
    </section>`;
}
