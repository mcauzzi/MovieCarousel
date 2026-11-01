import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import type { AppVersion, Device } from '../api';
import { currentCopy } from '../copy';
import { errorTemplate, fmtDateTime, statusTemplate } from './arrivals-common.templates';
import type { Notice } from './arrivals-common.templates';

/* Scheda TELEFONO del pannello ARRIVI: "Collega un telefono" in due passi
   (§10.1: installa l'app, abbina) e lista dei dispositivi con revoca.
   I QR sono immagini (SVG generati dall'API): mai unsafeHTML. */

export interface PhoneView extends Notice {
  /** undefined = in lettura; null = app non disponibile in questa build. */
  version: AppVersion | null | undefined;
  downloadQrUrl: string;
  apkUrl: string;
  /** QR di abbinamento attivo (SVG) e secondi rimasti; null = non generato. */
  pairing: { qrSvg: string; remaining: number } | null;
  pairBusy: boolean;
  /** Testo della regione live (generato, minuti rimasti, scaduto, SHA copiato). */
  announce: string;
}

export interface PhoneHandlers {
  onPair: () => void;
  onCopySha: () => void;
  onLogin: () => void;
}

function clock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function installStep(v: PhoneView, h: PhoneHandlers): TemplateResult {
  const ver = v.version;
  let body: TemplateResult;
  if (ver === undefined) {
    body = html`<p class="arrivals-muted">Verifico la versione disponibile…</p>`;
  } else if (ver === null) {
    body = html`<p class="arrivals-muted arrivals-unavailable">App non disponibile in questa build.</p>`;
  } else {
    body = html`
      <img class="arrivals-qr" src=${v.downloadQrUrl} width="180" height="180"
        alt="QR per scaricare l'app CineManager sul telefono">
      <p class="arrivals-app-version">CineManager <b>${ver.version}</b></p>
      <a class="group-btn arrivals-apk" href=${v.apkUrl} download="cinemanager.apk">⇣ SCARICA APK</a>
      ${ver.sha256 ? html`
        <div class="arrivals-sha">
          <span class="arrivals-sha-label">SHA-256</span>
          <code class="arrivals-sha-value">${ver.sha256}</code>
          <button type="button" class="group-btn arrivals-sha-copy" @click=${h.onCopySha}>⧉ COPIA</button>
        </div>` : nothing}
      <p class="arrivals-note">La prima volta Android chiede di consentire al browser
        l'installazione di app da fonti sconosciute: è normale per un'app installata a mano.</p>`;
  }
  return html`
    <li class="arrivals-step">
      <h4 class="arrivals-step-title">1. Installa l'app</h4>
      ${body}
    </li>`;
}

function pairStep(v: PhoneView, h: PhoneHandlers): TemplateResult {
  const p = v.pairing;
  const expired = !!p && p.remaining <= 0;
  return html`
    <li class="arrivals-step">
      <h4 class="arrivals-step-title">2. Abbina</h4>
      ${p ? html`
        <div class="arrivals-pair ${expired ? 'expired' : ''}">
          ${expired
            ? html`<div class="arrivals-qr arrivals-qr-expired" role="img" aria-label="Codice di abbinamento scaduto">SCADUTO</div>`
            : html`<img class="arrivals-qr" width="180" height="180"
                src=${'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(p.qrSvg)}
                alt="QR di abbinamento: inquadralo con l'app CineManager">`}
          <p class="arrivals-countdown">
            ${expired
              ? 'Codice scaduto.'
              : html`Scade tra <span role="timer" aria-live="off">${clock(p.remaining)}</span>`}
          </p>
        </div>` : html`
        <p class="arrivals-muted">Apri l'app sul telefono, scegli «Abbina» e premi qui sotto:
          comparirà un QR valido per 5 minuti.</p>`}
      <button type="button" class="random-extract-btn arrivals-pair-btn" ?disabled=${v.pairBusy} @click=${h.onPair}>
        ${v.pairBusy ? 'ATTENDI…' : p ? '↻ RIGENERA' : '▶ ABBINA'}
      </button>
    </li>`;
}

export function phoneTemplate(v: PhoneView, h: PhoneHandlers): TemplateResult {
  return html`
    <section class="arrivals-section" aria-labelledby="arrivalsPhoneTitle">
      <h3 class="arrivals-section-title" id="arrivalsPhoneTitle">COLLEGA UN TELEFONO</h3>
      <p class="arrivals-lede">${currentCopy().arrivalsPhoneLede}</p>
      <ol class="arrivals-steps">
        ${installStep(v, h)}
        ${pairStep(v, h)}
      </ol>
      ${statusTemplate(v.announce)}
      ${errorTemplate(v, h.onLogin)}
    </section>`;
}

// ---------------------------------------------------------------- dispositivi

export interface DevicesView extends Notice {
  isAdmin: boolean;
  showAll: boolean;
  mySub: string;
  /** null = in lettura. */
  devices: Device[] | null;
  /** Azione in corso (id dispositivo o "user:<sub>"): disabilita i pulsanti. */
  busy: string | null;
  status: string;
}

export interface DevicesHandlers {
  onToggleAll: (all: boolean) => void;
  onRevoke: (d: Device) => void;
  onRevokeUser: (sub: string, name: string) => void;
  onLogoutUser: (sub: string, name: string) => void;
  onLogin: () => void;
}

function deviceItem(d: Device, v: DevicesView, h: DevicesHandlers): TemplateResult {
  const name = d.name || 'Dispositivo senza nome';
  return html`
    <li class="arrivals-device ${d.revokedAt ? 'revoked' : ''}">
      <div class="arrivals-device-main">
        <span class="arrivals-device-name">${name}</span>
        <span class="arrivals-device-meta">
          Abbinato ${fmtDateTime(d.createdAt)} · ultimo uso ${d.lastSeenAt ? fmtDateTime(d.lastSeenAt) : 'mai'}
          ${d.revokedAt ? html` · <b>revocato ${fmtDateTime(d.revokedAt)}</b>` : nothing}
        </span>
      </div>
      ${d.revokedAt ? nothing : html`
        <button type="button" class="group-btn arrivals-danger" aria-label=${`Revoca ${name}`}
          ?disabled=${v.busy !== null} @click=${() => h.onRevoke(d)}>REVOCA</button>`}
    </li>`;
}

function groupByUser(devices: Device[]): { sub: string; name: string; list: Device[] }[] {
  const map = new Map<string, { sub: string; name: string; list: Device[] }>();
  for (const d of devices) {
    const g = map.get(d.userSub) ?? { sub: d.userSub, name: d.userName || d.userSub, list: [] };
    g.list.push(d);
    map.set(d.userSub, g);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'it'));
}

export function devicesTemplate(v: DevicesView, h: DevicesHandlers): TemplateResult {
  const list = v.devices;
  let body: TemplateResult;
  if (list === null) {
    body = html`<p class="arrivals-muted">Carico i dispositivi…</p>`;
  } else if (!list.length) {
    body = html`<p class="arrivals-muted">${currentCopy().devicesEmpty}</p>`;
  } else if (v.showAll) {
    body = html`${groupByUser(list).map(g => {
      const active = g.list.filter(d => !d.revokedAt).length;
      return html`
        <div class="arrivals-user">
          <div class="arrivals-user-head">
            <h4 class="arrivals-user-name">${g.name}${g.sub === v.mySub ? ' (tu)' : ''}
              <span class="arrivals-user-count">${active} attivi su ${g.list.length}</span></h4>
            <div class="arrivals-actions">
              <button type="button" class="group-btn arrivals-danger" ?disabled=${v.busy !== null || !active}
                aria-label=${`Revoca tutti i dispositivi di ${g.name}`}
                @click=${() => h.onRevokeUser(g.sub, g.name)}>REVOCA TUTTI</button>
              <button type="button" class="group-btn arrivals-danger" ?disabled=${v.busy !== null}
                aria-label=${`Logout forzato di ${g.name} dal sito`}
                @click=${() => h.onLogoutUser(g.sub, g.name)}>LOGOUT FORZATO</button>
            </div>
          </div>
          <ul class="arrivals-devices">${g.list.map(d => deviceItem(d, v, h))}</ul>
        </div>`;
    })}`;
  } else {
    body = html`<ul class="arrivals-devices">${list.map(d => deviceItem(d, v, h))}</ul>`;
  }
  return html`
    <section class="arrivals-section" aria-labelledby="arrivalsDevicesTitle">
      <h3 class="arrivals-section-title" id="arrivalsDevicesTitle" tabindex="-1">DISPOSITIVI</h3>
      ${v.isAdmin ? html`
        <label class="arrivals-check">
          <input type="checkbox" .checked=${v.showAll} ?disabled=${v.busy !== null}
            @change=${(e: Event) => h.onToggleAll((e.currentTarget as HTMLInputElement).checked)}>
          Mostra i dispositivi di tutti gli utenti
        </label>` : nothing}
      ${body}
      ${statusTemplate(v.status)}
      ${errorTemplate(v, h.onLogin)}
    </section>`;
}
