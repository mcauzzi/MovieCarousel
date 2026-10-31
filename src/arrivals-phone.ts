import { render } from 'lit';
import {
  createPairing, getAppVersion, getDevices, revokeDevice, revokeUserDevices, revokeUserSessions,
  apiUrl, APK_URL, goToLogin,
} from './api';
import type { Device } from './api';
import { phoneTemplate, devicesTemplate } from './templates/arrivals-phone.templates';
import type { PhoneView, DevicesView } from './templates/arrivals-phone.templates';
import { confirmDialog } from './db-ui';
import type { ConfirmView } from './templates/db.templates';
import { sectionRoot, noticeFrom, setError } from './arrivals-shared';
import type { Section, SectionContext } from './arrivals-shared';

/* Scheda TELEFONO: "Collega un telefono" (§10.1) + dispositivi.
   - Passo 1: QR di download e versione da /app/version.json (letta una volta).
   - Passo 2: QR di abbinamento solo su ABBINA (scade in 5 minuti). Il conto
     alla rovescia visibile è un role="timer" non annunciato; la regione live
     annuncia la generazione, i minuti interi rimasti, gli ultimi 30 secondi e
     la scadenza, non ogni secondo. Mentre il QR è valido e la scheda visibile
     controlla i propri dispositivi ogni 3 s: quando ne compare uno nuovo chiude
     il QR, annuncia l'abbinamento e aggiorna la lista. Timer e controllo si
     fermano quando la scheda non è visibile (altra scheda, pannello chiuso) e
     ripartono al ritorno se il codice è ancora valido.
   - Dispositivi: propri; per l'amministratore anche "tutti gli utenti", con
     revoca di tutti i dispositivi di un utente e logout forzato. */

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const PAIR_POLL_MS = 3000;

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
  let pollTimer = 0;
  /** Id dei propri dispositivi al momento della generazione del QR. */
  let knownIds: Set<string> | null = null;
  /** Generazione del QR corrente: scarta i controlli partiti per un QR precedente. */
  let pairGen = 0;
  let visible = false;
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
    clearTimeout(pollTimer);
    pollTimer = 0;
  }

  const pairingActive = (): boolean => !!phone.pairing && expiresAt > Date.now();

  /** Avvia conto alla rovescia e controllo dei dispositivi (solo a scheda visibile). */
  function startTimer(): void {
    stopTimer();
    if (!visible || !pairingActive()) return;
    timer = window.setInterval(tick, 1000);
    schedulePoll();
  }

  function schedulePoll(): void {
    clearTimeout(pollTimer);
    pollTimer = window.setTimeout(() => { void pollPaired(); }, PAIR_POLL_MS);
  }

  /** Controllo leggero: è comparso un dispositivo nuovo (non revocato)? */
  async function pollPaired(): Promise<void> {
    pollTimer = 0;
    const gen = pairGen;
    if (!visible || !pairingActive() || !knownIds) return;
    let list: Device[];
    try {
      list = await getDevices(false);
    } catch {
      // Errore transitorio: si riprova al prossimo giro (l'errore vero lo
      // mostrerà la lista dispositivi o l'abbinamento stesso).
      if (gen === pairGen && visible && pairingActive()) schedulePoll();
      return;
    }
    if (gen !== pairGen || !visible || !pairingActive()) return;
    const added = list.find(d => !d.revokedAt && !knownIds!.has(d.id));
    if (!added) { schedulePoll(); return; }
    stopTimer();
    pairGen++;
    phone.pairing = null;
    knownIds = null;
    lastMark = Infinity;
    phone.announce = `Telefono abbinato: «${added.name || 'Dispositivo senza nome'}».`;
    rerenderPhone();
    // La lista mostra già il nuovo dispositivo (anche nella vista di tutti gli utenti).
    if (!devices.showAll) {
      devicesSeq++;
      devices.devices = sortDevices(list);
      setError(devices, null);
      rerenderDevices();
    } else {
      void loadDevices();
    }
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
    setError(phone, null);
    rerenderPhone();
    try {
      // Dispositivi già abbinati: il controllo cerca quelli nuovi rispetto a questi.
      // Se la lettura fallisce l'abbinamento funziona lo stesso, senza riscontro automatico.
      const [res, before] = await Promise.all([createPairing(), getDevices(false).catch(() => null)]);
      pairGen++;
      knownIds = before ? new Set(before.map(d => d.id)) : null;
      const exp = Date.parse(res.expiresAt);
      expiresAt = Number.isFinite(exp) && exp > Date.now() ? exp : Date.now() + DEFAULT_TTL_MS;
      qrSvg = res.qrSvg;
      const remaining = (expiresAt - Date.now()) / 1000;
      phone.pairing = { qrSvg, remaining };
      const min = Math.max(1, Math.round(remaining / 60));
      phone.announce = `Nuovo QR di abbinamento pronto: scade tra ${min} ${min === 1 ? 'minuto' : 'minuti'}.`;
      lastMark = Math.ceil(remaining / 60) * 60;
      startTimer();
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

  // ------------------------------------------------------------ dispositivi

  async function loadDevices(): Promise<void> {
    const n = ++devicesSeq;
    try {
      const list = await getDevices(devices.showAll);
      if (n !== devicesSeq) return;
      devices.devices = sortDevices(list);
      setError(devices, null);
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

  /** Chiede conferma ed esegue un'azione di revoca, poi ricarica la lista e
   *  porta il focus sul titolo della sezione (il pulsante premuto sparisce). */
  async function act(
    confirm: Pick<ConfirmView, 'title' | 'accent' | 'message' | 'yesLabel'>,
    busy: string, action: () => Promise<void>, done: string,
  ): Promise<void> {
    if (!await confirmDialog({ ...confirm, danger: true, noLabel: 'ANNULLA' })) return;
    devices.busy = busy;
    setError(devices, null);
    devices.status = '';
    rerenderDevices();
    let failure: ReturnType<typeof noticeFrom> | null = null;
    try {
      await action();
      devices.status = done;
    } catch (err) {
      failure = noticeFrom(err, ctx);
    }
    devices.busy = null;
    await loadDevices();
    // loadDevices azzera l'errore se la lettura riesce: quello dell'azione
    // fallita deve restare visibile (ha la precedenza su un errore di lettura).
    if (failure) {
      Object.assign(devices, failure);
      rerenderDevices();
    }
    devicesHost.querySelector<HTMLElement>('#arrivalsDevicesTitle')?.focus();
  }

  function revoke(d: Device): Promise<void> {
    const name = d.name || 'Dispositivo senza nome';
    return act({
      title: 'REVOCA', accent: 'DISPOSITIVO', yesLabel: 'REVOCA',
      message: `Revocare «${name}»? Il telefono non potrà più inviare film finché non viene abbinato di nuovo.`,
    }, String(d.id), () => revokeDevice(d.id), `Dispositivo «${name}» revocato.`);
  }

  function revokeUser(sub: string, name: string): Promise<void> {
    return act({
      title: 'REVOCA', accent: 'TUTTI', yesLabel: 'REVOCA TUTTI',
      message: `Revocare tutti i dispositivi di ${name}? Dovrà abbinare di nuovo ogni telefono.`,
    }, 'user:' + sub, () => revokeUserDevices(sub), `Dispositivi di ${name} revocati.`);
  }

  function logoutUser(sub: string, name: string): Promise<void> {
    return act({
      title: 'LOGOUT', accent: 'FORZATO', yesLabel: 'LOGOUT',
      message: sub === ctx.sub
        ? 'Chiudere tutte le tue sessioni del sito, compresa questa? Dovrai accedere di nuovo.'
        : `Chiudere tutte le sessioni del sito di ${name}? Dovrà accedere di nuovo (i telefoni restano abbinati).`,
    }, 'user:' + sub, () => revokeUserSessions(sub), `Sessioni del sito di ${name} chiuse.`);
  }

  rerender();
  return {
    el,
    activate: () => {
      visible = true;
      if (!versionRequested) {
        versionRequested = true;
        void getAppVersion().then(v => { phone.version = v; rerenderPhone(); });
      }
      void loadDevices();
      if (phone.pairing) { tick(); startTimer(); }
    },
    deactivate: () => { visible = false; stopTimer(); },
    rerender,
    destroy: () => { visible = false; stopTimer(); pairGen++; devicesSeq++; },
  };
}
