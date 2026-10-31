import { render } from 'lit';
import { buildPanelShell } from './filters';
import type { PanelShell } from './filters';
import { arrivalsShellTemplate } from './templates/arrivals.templates';
import type { ArrivalsTab } from './templates/arrivals.templates';
import { currentCopy } from './copy';
import { trapTab, focusablesIn } from './utils';
import type { Section, SectionContext } from './arrivals-shared';
import { createPhoneSection } from './arrivals-phone';
import { createListSection } from './arrivals-list';
import { createExportSection, createFieldsSection } from './arrivals-admin';
import { createImportSection } from './arrivals-import';

/* Pannello ARRIVI (modalità DB, tutti gli utenti; le schede ESPORTA, CAMPI e
   IMPORTA solo con il ruolo admin). Stessa shell e stesse classi random-* di
   FILTRI/RANDOM; il pannello è cache-ato a livello modulo e rilasciato da
   resetArrivals() (Reload, nuova collezione). Questo modulo compone le schede
   (role="tablist") e il dialog; ogni scheda è una sezione con stato UI in
   closure (arrivals-phone/-list/-admin/-import.ts). Nessuno stato di dominio
   qui: le modifiche alla collezione passano da `onCollectionChanged` (main.ts),
   che ricarica collezione e stato dall'API e ri-renderizza. */

export interface ArrivalsParams {
  /** Ruolo amministratore (da GET me): abilita ESPORTA, CAMPI, IMPORTA. */
  isAdmin: boolean;
  /** `sub` dell'utente corrente. */
  sub: string;
  /** Cartella delle copertine (config.json → imgDir). */
  imgDir: string;
  /** Chiamato dopo una modifica alla collezione: la ricarica dall'API. */
  onCollectionChanged: () => Promise<void>;
  /** Sessione scaduta durante una scrittura (avviso ACCEDI di main). */
  onSessionExpired: () => void;
  /** Elemento a cui restituire il focus alla chiusura. */
  returnFocusTo: () => HTMLElement | null;
}

interface ArrivalsPanel {
  shell: PanelShell;
  rerender: () => void;
  destroy: () => void;
}

let panel: ArrivalsPanel | null = null;

export function resetArrivals(): void {
  panel?.destroy();
  panel = null;
}

/** Al cambio tema: aggiorna titolo e testi di colore del pannello già costruito. */
export function refreshArrivalsCopy(): void {
  if (!panel) return;
  const accent = panel.shell.panel.querySelector('.random-title-accent');
  if (accent) accent.textContent = currentCopy().arrivalsAccent;
  panel.rerender();
}

export function openArrivals(params: ArrivalsParams): void {
  if (!panel) {
    panel = buildArrivals(params);
    document.body.appendChild(panel.shell.backdrop);
  }
  panel.shell.backdrop.classList.add('show');
  const target = panel.shell.panel.querySelector<HTMLElement>('.arrivals-tab.active')
    ?? focusablesIn(panel.shell.panel).find(el => !el.classList.contains('random-close'))
    ?? panel.shell.panel.querySelector<HTMLElement>('.random-close');
  // Dopo il frame: il backdrop passa da pointer-events:none a visibile.
  requestAnimationFrame(() => target?.focus());
}

interface TabDef { id: string; label: string; section: Section }

function buildArrivals(params: ArrivalsParams): ArrivalsPanel {
  const shell = buildPanelShell('ARRIVI', currentCopy().arrivalsAccent);
  const { panel: panelEl, backdrop } = shell;
  panelEl.classList.add('arrivals-panel');
  panelEl.setAttribute('role', 'dialog');
  panelEl.setAttribute('aria-modal', 'true');
  panelEl.setAttribute('aria-label', 'ARRIVI');
  panelEl.querySelector('.random-close')?.setAttribute('aria-label', 'Chiudi ARRIVI');

  const body = document.createElement('div');
  body.className = 'arrivals-body';
  panelEl.appendChild(body);

  const ctx: SectionContext = {
    isAdmin: params.isAdmin,
    sub: params.sub,
    imgDir: params.imgDir,
    onCollectionChanged: params.onCollectionChanged,
    onSessionExpired: params.onSessionExpired,
  };

  const list = createListSection(ctx);
  const tabs: TabDef[] = [
    { id: 'phone', label: 'TELEFONO', section: createPhoneSection(ctx) },
    { id: 'arrivals', label: 'ARRIVI', section: list },
  ];
  if (params.isAdmin) {
    tabs.push(
      { id: 'export', label: 'ESPORTA CSV', section: createExportSection(ctx, () => list.invalidate()) },
      { id: 'fields', label: 'CAMPI', section: createFieldsSection(ctx, () => list.invalidateFields()) },
      { id: 'import', label: 'IMPORTA DA TELLICO', section: createImportSection(ctx) },
    );
  }
  // §10.1: il pannello apre su "Collega un telefono".
  let active = 'phone';

  function select(id: string, focus: boolean): void {
    if (id !== active) tabs.find(t => t.id === active)?.section.deactivate?.();
    active = id;
    rerenderShell();
    const tab = tabs.find(t => t.id === id);
    tab?.section.activate();
    if (focus) body.querySelector<HTMLElement>(`#arrivalsTab-${id}`)?.focus();
  }

  function rerenderShell(): void {
    const view: ArrivalsTab[] = tabs.map(t => ({ id: t.id, label: t.label, el: t.section.el }));
    render(arrivalsShellTemplate(view, active, { onSelect: select }), body);
  }

  function rerender(): void {
    rerenderShell();
    for (const t of tabs) t.section.rerender();
  }

  // Dialog: focus trap sul pannello e ritorno del focus al pulsante alla chiusura.
  const onKeydown = (e: KeyboardEvent): void => { if (e.key === 'Tab') trapTab(panelEl, e); };
  panelEl.addEventListener('keydown', onKeydown);
  const observer = new MutationObserver(() => {
    const open = backdrop.classList.contains('show');
    if (open) {
      // Apertura/riapertura: carica o aggiorna i dati della scheda visibile.
      tabs.find(t => t.id === active)?.section.activate();
      return;
    }
    tabs.find(t => t.id === active)?.section.deactivate?.();
    if (backdrop.contains(document.activeElement)) params.returnFocusTo()?.focus();
  });
  observer.observe(backdrop, { attributes: true, attributeFilter: ['class'] });

  rerenderShell();
  return {
    shell,
    rerender,
    destroy: () => {
      observer.disconnect();
      for (const t of tabs) t.section.destroy();
      shell.destroy();
    },
  };
}
