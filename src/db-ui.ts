import { render } from 'lit';
import { confirmDialogTemplate, sessionNoticeTemplate } from './templates/db.templates';
import type { ConfirmView } from './templates/db.templates';
import { trapTab } from './utils';

/* UI della modalità DB fuori dai pannelli: dialog di conferma accessibile e
   avviso persistente "sessione scaduta" con ACCEDI. Controller foglia senza
   stato di dominio (come toast.ts): il chiamante decide cosa fare dell'esito. */

/** Dialog modale SÌ/NO: role="dialog", focus trap, Escape = NO, focus
 *  restituito all'elemento attivo prima dell'apertura. Risolve true con SÌ. */
export async function confirmDialog(v: ConfirmView): Promise<boolean> {
  return (await confirmWithOption(v)).yes;
}

/** Come confirmDialog, ma riporta anche lo stato della casella `v.option`. */
export function confirmWithOption(v: ConfirmView): Promise<{ yes: boolean; checked: boolean }> {
  return new Promise(resolve => {
    const opener = document.activeElement as HTMLElement | null;
    const backdrop = document.createElement('div');
    backdrop.className = 'random-backdrop show cm-confirm';
    document.body.appendChild(backdrop);

    const done = (answer: boolean): void => {
      const checked = !!backdrop.querySelector<HTMLInputElement>('.cm-confirm-check')?.checked;
      document.removeEventListener('keydown', onKeydown, true);
      backdrop.remove();
      if (opener?.isConnected) opener.focus();
      resolve({ yes: answer, checked });
    };
    // In capture: Escape chiude solo questo dialog (non i popup sotto).
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Tab') {
        const dialog = backdrop.querySelector<HTMLElement>('[role="dialog"]');
        if (dialog) trapTab(dialog, e);
      }
    };
    document.addEventListener('keydown', onKeydown, true);

    render(confirmDialogTemplate(v, () => done(true), () => done(false)), backdrop);
    backdrop.querySelector<HTMLElement>(v.danger ? '.cm-confirm-no' : '.cm-confirm-yes')?.focus();
  });
}

let noticeHost: HTMLElement | null = null;

/** Mostra l'avviso "sessione scaduta" (resta finché non si accede o lo si chiude).
 *  `message` dice cosa non è andato a buon fine (default: una modifica). */
export function showSessionExpired(
  onLogin: () => void,
  message = 'Sessione scaduta: la modifica non è stata salvata.',
): void {
  if (!noticeHost) {
    noticeHost = document.createElement('div');
    noticeHost.className = 'cm-session-host';
    document.body.appendChild(noticeHost);
  }
  const host = noticeHost;
  render(sessionNoticeTemplate(true, message, onLogin, () => render(sessionNoticeTemplate(false, message, onLogin, () => {}), host)), host);
}
