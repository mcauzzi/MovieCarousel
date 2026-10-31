import { render } from 'lit';
import {
  createPairing, getAppVersion, getDevices, revokeDevice, revokeUserDevices, revokeUserSessions,
  apiUrl, APK_URL, goToLogin,
} from './api';
import type { Device } from './api';
import { phoneTemplate, devicesTemplate } from './templates/arrivals-phone.templates';
import type { PhoneView, DevicesView } from './templates/arrivals-phone.templates';
import { confirmDialog } from './db-ui';
import { sectionRoot, noticeFrom } from './arrivals-shared';
import type { Section, SectionContext } from './arrivals-shared';

/* Scheda TELEFONO: "Collega un telefono" (§10.1) + dispositivi.
   - Passo 1: QR di download e versione da /app/version.json (letta una volta).
   - Passo 2: QR di abbinamento solo su ABBINA (scade in 5 minuti). Il conto
     alla rovescia visibile è un role="timer" non annunciato; la regione live
     annuncia la generazione, i minuti interi rimasti, gli ultimi 30 secondi e
     la scadenza, non ogni secondo.
   - Dispositivi: propri; per l'amministratore anche "tutti gli utenti", con
     revoca di tutti i dispositivi di un utente e logout forzato. */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function createPhoneSection(ctx: SectionContext): Section {
  const el = sectionRoot('arrivals-phone');
  const phoneHost = document.createElement('div');
  const devicesHost = document.createElement('div');
  el.append(phoneHost, devicesHost);

  const phone: PhoneView = {
    version: undefined,
    downloadQrUrl: apiUrl('app-download-qr.svg'),
    apkUrl: APK_URL,
    pairing: null,
    pairBusy: false,
    announce: '',
    error: null,
    sessionExpired: false,
  };
  let qrSvg = '';
  let expiresAt = 0;
  let timer = 0;
  /** Ultima soglia annunciata (minuti interi, 30 s, 0) del codice corrente. */
  let lastMark = Infinity;

  const devices: DevicesView = {
    isAdmin: ctx.isAdmin,
    showAll: false,
    mySub: ctx.sub,
    devices: null,
    busy: null,
    status: '',
    error: null,
    sessionExpired: false,
  };
  let versionRequested = false;
  let devicesSeq = 0;

  function rerenderPhone(): void {
    render(phoneTemplate(phone, {
      onPair: () => { void pair(); },
      onCopySha: () => { void copySha(); },
      onLogin: goToLogin,
    }), phoneHost);
  }

  function rerenderDevices(): void {
    render(devicesTemplate(devices, {
      onToggleAll: all => { devices.showAll = all; devices.devices = null; rerenderDevices(); void loadDevices(); },
      onRevoke: d => { void revoke(d); },
      onRevokeUser: (sub, name) => { void revokeUser(sub, name); },
      onLogoutUser: (sub, name) => { void logoutUser(sub, name); },
      onLogin: goToLogin,
    }), devicesHost);
  }

  function rerender(): void {
    rerenderPhone();
    rerenderDevices();
  }

  // ------------------------------------------------------------ abbinamento

  function stopTimer(): void {
    clearInterval(timer);
    timer = 0;
  }

  function tick(): void {
    if (!phone.pairing) return;
    const remaining = Math.max(0, (expiresAt - Date.now()) / 1000);
    phone.pairing = { qrSvg, remaining };
    const secs = Math.ceil(remaining);
    if (secs <= 0) {
      stopTimer();
      if (lastMark > 0) phone.announce = 'Codice di abbinamento scaduto: premi RIGENERA per un nuovo QR.';
      lastMark = 0;
    } else {
      // Soglie: ogni minuto intero e gli ultimi 30 secondi.
      const mark = secs <= 30 ? 30 : Math.ceil(secs / 60) * 60;
      if (mark < lastMark) {
        phone.announce = mark === 30
          ? 'Il codice scade tra 30 secondi.'
          : `Il codice scade tra ${mark / 60} ${mark === 60 ? 'minuto' : 'minuti'}.`;
        lastMark = mark;
      }
    }
    rerenderPhone();
  }

  async function pair(): Promise<void> {
    if (phone.pairBusy) return;
    phone.pairBusy = true;
    phone.error = null;
    phone.sessionExpired = false;
    rerenderPhone();
    try {
      const res = await createPairing();
      const exp = Date.parse(res.expiresAt);
      expiresAt = Number.isFinite(exp) && exp > Date.now() ? exp : Date.now() + DEFAULT_TTL_MS;
      qrSvg = res.qrSvg;
      const remaining = (expiresAt - Date.now()) / 1000;
      phone.pairing = { qrSvg, remaining };
      const min = Math.max(1, Math.round(remaining / 60));
      phone.announce = `Nuovo QR di abbinamento pronto: scade tra ${min} ${min === 1 ? 'minuto' : 'minuti'}.`;
      lastMark = Math.ceil(remaining / 60) * 60;
      stopTimer();
      timer = window.setInterval(tick, 1000);
    } catch (err) {
      Object.assign(phone, noticeFrom(err, ctx));
    } finally {
      phone.pairBusy = false;
      rerenderPhone();
    }
  }

  async function copySha(): Promise<void> {
    const sha = phone.version?.sha256;
    if (!sha) return;
    try {
      await navigator.clipboard.writeText(sha);
      phone.announce = 'SHA-256 copiato negli appunti.';
    } catch {
      // Appunti non disponibili (http, permessi): seleziona il testo.
      const code = phoneHost.querySelector('.arrivals-sha-value');
      if (code) {
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      phone.announce = 'Copia non riuscita: il codice è selezionato, copialo a mano.';
    }
    rerenderPhone();
  }

  async function loadVersion(): Promise<void> {
    phone.version = await getAppVersion();
    rerenderPhone();
  }

  // ------------------------------------------------------------ dispositivi

  async function loadDevices(): Promise<void> {
    const n = ++devicesSeq;
    try {
      const list = await getDevices(devices.showAll);
      if (n !== devicesSeq) return;
      devices.devices = sortDevices(list);
      devices.error = null;
      devices.sessionExpired = false;
    } catch (err) {
      if (n !== devicesSeq) return;
      if (!devices.devices) devices.devices = [];
      Object.assign(devices, noticeFrom(err, ctx));
    }
    rerenderDevices();
  }

  function sortDevices(list: Device[]): Device[] {
    // Attivi prima dei revocati, poi i più recenti.
    return [...list].sort((a, b) =>
      Number(!!a.revokedAt) - Number(!!b.revokedAt) || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }

  /** Esegue un'azione di revoca, poi ricarica la lista e porta il focus
   *  sul titolo della sezione (il pulsante premuto sparisce). */
  async function act(busy: string, action: () => Promise<void>, done: string): Promise<void> {
    devices.busy = busy;
    devices.error = null;
    devices.sessionExpired = false;
    devices.status = '';
    rerenderDevices();
    try {
      await action();
      devices.status = done;
    } catch (err) {
      Object.assign(devices, noticeFrom(err, ctx));
    }
    devices.busy = null;
    await loadDevices();
    devicesHost.querySelector<HTMLElement>('#arrivalsDevicesTitle')?.focus();
  }

  async function revoke(d: Device): Promise<void> {
    const name = d.name || 'Dispositivo senza nome';
    const ok = await confirmDialog({
      title: 'REVOCA', accent: 'DISPOSITIVO', danger: true,
      message: `Revocare «${name}»? Il telefono non potrà più inviare film finché non viene abbinato di nuovo.`,
      yesLabel: 'REVOCA', noLabel: 'ANNULLA',
    });
    if (ok) await act(String(d.id), () => revokeDevice(d.id), `Dispositivo «${name}» revocato.`);
  }

  async function revokeUser(sub: string, name: string): Promise<void> {
    const ok = await confirmDialog({
      title: 'REVOCA', accent: 'TUTTI', danger: true,
      message: `Revocare tutti i dispositivi di ${name}? Dovrà abbinare di nuovo ogni telefono.`,
      yesLabel: 'REVOCA TUTTI', noLabel: 'ANNULLA',
    });
    if (ok) await act('user:' + sub, () => revokeUserDevices(sub), `Dispositivi di ${name} revocati.`);
  }

  async function logoutUser(sub: string, name: string): Promise<void> {
    const self = sub === ctx.sub;
    const ok = await confirmDialog({
      title: 'LOGOUT', accent: 'FORZATO', danger: true,
      message: self
        ? 'Chiudere tutte le tue sessioni del sito, compresa questa? Dovrai accedere di nuovo.'
        : `Chiudere tutte le sessioni del sito di ${name}? Dovrà accedere di nuovo (i telefoni restano abbinati).`,
      yesLabel: 'LOGOUT', noLabel: 'ANNULLA',
    });
    if (ok) await act('user:' + sub, () => revokeUserSessions(sub), `Sessioni del sito di ${name} chiuse.`);
  }

  rerender();
  return {
    el,
    activate: () => {
      if (!versionRequested) { versionRequested = true; void loadVersion(); }
      void loadDevices();
    },
    rerender,
    destroy: () => { stopTimer(); devicesSeq++; },
  };
}
