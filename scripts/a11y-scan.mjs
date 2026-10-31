#!/usr/bin/env node
/* Scansione WCAG con axe-core su tutti i temi × gli stati principali della UI.
 *
 *   npm run a11y                      # build + scansione con la collezione di prova
 *   npm run a11y -- --file mia.tc     # usa una collezione reale (.tc zip o XML)
 *   node scripts/a11y-scan.mjs --url http://localhost:5173/   # contro un server già avviato
 *
 * Opzioni:
 *   --url <url>          base del sito da scansionare (default: `vite preview` su dist/)
 *   --file <path.tc>     collezione da caricare al posto di quella generata
 *   --img-dir <path>     imgDir passato all'app (URL relativo al sito, per copertine esterne)
 *   --themes p5,sh2      sottoinsieme di temi (default: tutti)
 *   --states modal,intel sottoinsieme di stati (default: tutti; `arrivi` = pannello
 *                        ARRIVI in modalità DB con API simulata)
 *   --out <dir>          cartella del report (default: a11y-report/)
 *   --screenshots        salva uno screenshot per ogni tema × stato
 *   --strict             exit code 1 se ci sono violazioni
 *
 * L'app non sa di essere sotto test: config.json e il .tc sono serviti
 * intercettando le richieste in Playwright, quindi non serve nessun file sul
 * disco del sito. Lo stato `arrivi` gira in modalità DB (config.json con
 * apiBase) con un'API simulata dalle stesse intercettazioni: utente admin,
 * collezione, dispositivi, arrivi, campi, version.json e QR; axe passa su
 * ogni scheda del pannello (TELEFONO con QR di abbinamento, ARRIVI con il
 * modulo di correzione aperto, ESPORTA CSV, CAMPI, IMPORTA DA TELLICO). Il browser gira con prefers-reduced-motion, così cut-in,
 * All-Out Attack e transizioni vengono saltati e ogni stato è stabile.
 *
 * Output: report.md (leggibile) + report.json (risultati axe completi). */

/* Le callback di page.evaluate/waitForFunction girano nel browser. */
/* global document, axe */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AXE_PATH = require.resolve('axe-core/axe.min.js');

const THEMES = ['p5', 'p3', 'p4', 'sh2'];
const THEME_LABEL = { p5: 'PHANTOM', p3: 'MEMENTO', p4: 'MAYONAKA', sh2: 'TOLUCA' };
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const TC_PATH = '__a11y__/collection.tc';

const { values: opts } = parseArgs({
  options: {
    url: { type: 'string' },
    file: { type: 'string' },
    'img-dir': { type: 'string', default: '' },
    themes: { type: 'string' },
    states: { type: 'string' },
    out: { type: 'string', default: 'a11y-report' },
    screenshots: { type: 'boolean', default: false },
    strict: { type: 'boolean', default: false },
  },
});

/* ------------------------------------------------------------------ *
 * Collezione di prova: copre i casi che toccano il contrasto — titoli
 * corti e lunghissimi, copertine chiare/scure/sature e assenti (segnaposto),
 * film visti, in watchlist, con e senza voto, campi mancanti.
 * ------------------------------------------------------------------ */
const FIXTURE = [
  ['Il cielo sopra la città', 1987, ['Dramma', 'Fantastico'], ['Anna Weber'], 'Germania', 'Tedesco', 128, 5, true, '#f2e9d0'],
  ['Notte', 1961, ['Dramma'], ['Marco Ferri'], 'Italia', 'Italiano', 122, 4, true, '#111111'],
  ['La lunghissima e improbabile ballata del cacciatore di nuvole', 2004, ['Avventura', 'Commedia'], ['Lena Holm', 'Piet Vos'], 'Paesi Bassi', 'Olandese', 151, null, false, '#e60012'],
  ['Kaiju', 1954, ['Fantascienza', 'Horror'], ['Kenji Mori'], 'Giappone', 'Giapponese', 96, 3, true, null],
  ['Fiume', 1998, ['Documentario'], ['Sara Conti'], 'Italia', 'Italiano', 74, null, false, '#7fe8ff'],
  ['Ombre di vetro', 2015, ['Thriller', 'Noir'], ['Paul Grant'], 'USA', 'Inglese', 109, 2, false, '#1e6bf0'],
  ['Midnight Diner', 2011, ['Commedia'], ['Yui Sato'], 'Giappone', 'Giapponese', 88, 4, true, '#f5c400'],
  ['Lontano', 1979, ['Western'], ['Jack Moore'], 'USA', 'Inglese', 135, null, true, null],
  ['Il quadrato rosso', 2001, ['Horror', 'Mistero'], ['Ilse Berg'], 'Svezia', 'Svedese', 101, 5, false, '#5e1a14'],
  ['Primavera', 2020, ['Animazione', 'Famiglia'], ['Mei Lin'], 'Cina', 'Cinese', 82, 3, false, '#cfe8c4'],
  ['Senza titolo', null, [], [], null, null, null, null, false, null],
  ['Rotta 66', 1972, ['Road movie', 'Dramma'], ['Bill Carter'], 'USA', 'Inglese', 117, 4, true, '#bb3a2f'],
  ['Les nuits blanches', 1957, ['Romantico'], ['Claire Dubois'], 'Francia', 'Francese', 97, null, false, '#cccccc'],
  ['Hotel delle stanze vuote', 2009, ['Mistero', 'Thriller'], ['Ivo Marin'], 'Italia', 'Italiano', 113, 2, true, '#2b2420'],
  ['Robot', 1984, ['Fantascienza', 'Azione'], ['Sam Reed'], 'UK', 'Inglese', 107, 3, false, null],
  ['Seoul di notte', 2018, ['Noir', 'Azione'], ['Park Ji-ho'], 'Corea del Sud', 'Coreano', 124, 5, true, '#0a1d42'],
];

const FIELDS = `
  <field name="title" title="Titolo" type="1"/>
  <field name="year" title="Anno" type="6"/>
  <field name="genre" title="Genere" type="1" flags="7"/>
  <field name="director" title="Regista" type="1" flags="7"/>
  <field name="nationality" title="Nazionalità" type="1" flags="7"/>
  <field name="language" title="Lingua" type="1" flags="7"/>
  <field name="running-time" title="Durata" type="6"/>
  <field name="rating" title="Valutazione personale" type="14"/>
  <field name="visto" title="Visto" type="4"/>
  <field name="cast" title="Cast" type="8"/>
  <field name="plot" title="Trama" type="2"/>
  <field name="cover" title="Copertina" type="10"/>`;

const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const many = (tag, vals) => vals.length ? `<${tag}s>${vals.map(v => `<${tag}>${xmlEsc(v)}</${tag}>`).join('')}</${tag}s>` : '';

function coverSvg(color, i) {
  // Copertina "fotografica": gradiente + forma, così il testo sopra non ha mai una tinta unita.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${i % 2 ? '#000' : '#fff'}" stop-opacity="0.6"/>
    </linearGradient></defs>
    <rect width="300" height="450" fill="${color}"/><rect width="300" height="450" fill="url(#g)"/>
    <circle cx="${80 + (i * 37) % 140}" cy="${120 + (i * 53) % 200}" r="70" fill="${i % 2 ? '#fff' : '#000'}" fill-opacity="0.25"/>
  </svg>`;
  return Buffer.from(svg).toString('base64');
}

function buildFixtureXml() {
  const entries = [];
  const images = [];
  FIXTURE.forEach(([title, year, genres, directors, nat, lang, time, rating, visto, color], i) => {
    const id = i + 1;
    const cover = color ? `cover-${id}.svg` : null;
    if (cover) images.push(`<image id="${cover}" format="svg+xml" width="300" height="450">${coverSvg(color, i)}</image>`);
    entries.push(`<entry id="${id}">
      <title>${xmlEsc(title)}</title>
      ${year ? `<year>${year}</year>` : ''}
      ${many('genre', genres)}${many('director', directors)}
      ${nat ? many('nationality', [nat]) : ''}${lang ? many('language', [lang]) : ''}
      ${time ? `<running-time>${time}</running-time>` : ''}
      ${rating ? `<rating>${rating}</rating>` : ''}
      ${visto ? '<visto>true</visto>' : ''}
      ${directors.length ? `<casts>
        <cast><column>Attrice Uno</column><column>Protagonista</column></cast>
        <cast><column>Attore Due</column><column>Il fratello</column></cast>
        <cast><column>Attrice Tre</column><column></column></cast>
      </casts>` : ''}
      ${year ? `<plot>${xmlEsc(`Trama di prova per «${title}»: una storia abbastanza lunga da andare a capo più volte nella scheda, con punteggiatura, accenti e qualche parola lunghissima come precipitevolissimevolmente.`)}</plot>` : ''}
      ${cover ? `<cover>${cover}</cover>` : ''}
    </entry>`);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<tellico xmlns="http://periapsis.org/tellico/" syntaxVersion="11">
  <collection title="Collezione di prova" type="3">
    <fields>${FIELDS}</fields>
    ${entries.join('\n')}
    <images>${images.join('\n')}</images>
  </collection>
</tellico>`;
}

/* ------------------------------------------------------------------ *
 * API simulata per la modalità DB (stato `arrivi`): stessi film della
 * collezione di prova, utente amministratore, dispositivi di due utenti,
 * arrivi dall'app (uno con copertina, uno senza) e campi di ogni tipo.
 * ------------------------------------------------------------------ */
const API_BASE = './__a11y__/api/';
const COVER_DIR = './__a11y__/covers/';
const NOW = Date.parse('2026-10-30T18:00:00Z');
const iso = minutesAgo => new Date(NOW - minutesAgo * 60000).toISOString();

function fixtureMovies() {
  return FIXTURE.map(([title, year, genres, directors, nat, lang, time, rating, , color], i) => {
    const m = { id: i + 1, title, genre: genres, director: directors };
    if (year) m.year = year;
    if (nat) m.nationality = [nat];
    if (lang) m.language = [lang];
    if (time) m['running-time'] = time;
    if (rating) m.rating = rating;
    if (color) m.cover = `cover-${i + 1}.svg`;
    return m;
  });
}

const API_FIELDS = [
  ['title', 'Titolo', 'line', false, 'tellico', true],
  ['year', 'Anno', 'number', false, 'tellico', true],
  ['genre', 'Genere', 'line', true, 'tellico', true],
  ['director', 'Regista', 'line', true, 'tellico', true],
  ['cast', 'Cast', 'table', true, 'tellico', true],
  ['plot', 'Trama', 'para', false, 'tellico', true],
  ['medium', 'Supporto', 'choice', false, 'tellico', true, ['DVD', 'Blu-ray', '4K']],
  ['cdate', 'Data di creazione', 'date', false, 'tellico', false],
  ['cover', 'Copertina', 'image', false, 'tellico', false],
  ['ean', 'EAN', 'line', false, 'local', true],
  ['steelbook', 'Steelbook', 'bool', false, 'local', true],
  ['acquisto', 'Data di acquisto', 'date', false, 'local', true],
].map(([name, title, type, multiple, origin, inForm, allowed], i) => ({
  name, title, type, multiple, origin, inForm, allowed: allowed ?? null,
  groupable: ['genre', 'director', 'medium'].includes(name), groupMinSize: 3, ordinal: i,
}));

const API_DEVICES = [
  { id: '0d6f1a52-6a1e-4c55-9c41-000000000001', name: 'Pixel 8', userSub: 'u-admin', userName: 'Amministratore', createdAt: iso(60 * 24 * 30), lastSeenAt: iso(15), revokedAt: null },
  { id: '0d6f1a52-6a1e-4c55-9c41-000000000002', name: 'Telefono vecchio', userSub: 'u-admin', userName: 'Amministratore', createdAt: iso(60 * 24 * 300), lastSeenAt: iso(60 * 24 * 200), revokedAt: iso(60 * 24 * 100) },
  { id: '0d6f1a52-6a1e-4c55-9c41-000000000003', name: 'Galaxy di Anna', userSub: 'u-anna', userName: 'Anna', createdAt: iso(60 * 24 * 3), lastSeenAt: null, revokedAt: null },
];

const API_ARRIVALS = [
  { id: 101, ean: '8012345678901', tmdbId: 238, source: 'app', createdAt: iso(90), createdBy: 'u-anna', createdByName: 'Anna', exportedAt: null,
    movie: { id: 101, title: 'Il padrino', year: 1972, genre: ['Drammatico', 'Crime'], director: ['Francis Ford Coppola'],
      cast: [{ actor: 'Marlon Brando', role: 'Vito Corleone' }], medium: 'DVD', ean: '8012345678901', steelbook: 'true', cover: 'cover-1.svg' } },
  { id: 102, ean: '8009876543210', tmdbId: null, source: 'app', createdAt: iso(60 * 26), createdBy: 'u-admin', createdByName: 'Amministratore', exportedAt: iso(60 * 20),
    movie: { id: 102, title: 'Un titolo lunghissimo inserito dal telefono con il codice a barre', medium: 'Blu-ray', ean: '8009876543210' } },
];

const QR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges"><rect width="29" height="29" fill="#fff"/><path d="M2 2h7v7H2zM20 2h7v7h-7zM2 20h7v7H2zM12 12h5v5h-5z" fill="#000"/></svg>';

/** Risposte dell'API simulata (percorso relativo ad API_BASE). */
function mockApi(route) {
  const req = route.request();
  const url = new URL(req.url());
  const path = url.pathname.replace(/^.*\/__a11y__\/api\//, '');
  const json = body => route.fulfill({ status: 200, json: body });
  if (path === 'me') return json({ sub: 'u-admin', name: 'Amministratore', roles: ['user', 'admin'] });
  if (path === 'collection') return json({ movies: fixtureMovies(), fields: API_FIELDS });
  if (path === 'state') return json({ status: { 1: 'seen', 2: 'watchlist' }, rating: { 1: 5 } });
  if (path === 'devices') return json(API_DEVICES.filter(d => url.searchParams.get('all') === 'true' || d.userSub === 'u-admin'));
  if (path === 'arrivals') return json(url.searchParams.get('scope') === 'new' ? API_ARRIVALS.filter(a => !a.exportedAt) : API_ARRIVALS);
  if (path === 'fields') return json(API_FIELDS);
  if (path === 'pairing') return json({ code: 'ABCD-1234', expiresAt: new Date(Date.now() + 5 * 60000).toISOString(), qrSvg: QR_SVG });
  if (path === 'app-download-qr.svg') return route.fulfill({ status: 200, body: QR_SVG, contentType: 'image/svg+xml' });
  return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not Found' }) });
}

/** Instrada config.json, API simulata, version.json e copertine (modalità DB). */
async function routeDbMode(context) {
  await context.route(/\/config\.json(\?|$)/, route => route.fulfill({
    json: { apiBase: API_BASE, imgDir: COVER_DIR, title: 'Collezione di prova', bgmDir: './__a11y__/bgm/' },
  }));
  await context.route(/\/__a11y__\/api\//, mockApi);
  await context.route(/\/app\/version\.json(\?|$)/, route => route.fulfill({
    json: { version: '1.3.0', versionCode: 10300, minSupportedCode: 10000, sha256: 'a3f1c2'.repeat(10) + 'beef', commit: 'abc1234' },
  }));
  await context.route(/\/__a11y__\/covers\/cover-(\d+)\.svg/, (route) => {
    const i = Number(/cover-(\d+)/.exec(route.request().url())[1]) - 1;
    const color = FIXTURE[i]?.[9] ?? '#888888';
    return route.fulfill({ status: 200, body: Buffer.from(coverSvg(color, i), 'base64'), contentType: 'image/svg+xml' });
  });
}

/* ------------------------------------------------------------------ *
 * Stati: ognuno parte da una pagina fresca, esegue le azioni e attende
 * che la UI sia ferma. `loaded: false` = niente collezione (schermata loader).
 * ------------------------------------------------------------------ */
const settle = page => page.waitForTimeout(700); // transizione pagina (~500 ms) + font

const STATES = {
  loader: {
    label: 'Loader (nessuna collezione)',
    loaded: false,
    run: async page => {
      await page.waitForFunction(() => document.getElementById('status')?.textContent?.trim());
    },
  },
  carousel: {
    label: 'Carosello',
    run: async () => {},
  },
  filters: {
    label: 'Popup FILTRI',
    run: async page => {
      await page.click('#filterBtn');
      await page.waitForSelector('.random-backdrop.show', { state: 'visible' });
    },
  },
  random: {
    label: 'Picker RANDOM',
    run: async page => {
      await page.click('#randomBtn');
      await page.waitForSelector('.random-backdrop.show .random-extract-btn', { state: 'visible' });
    },
  },
  ticket: {
    label: 'Biglietto (All-Out Attack)',
    run: async page => {
      await page.click('#randomBtn');
      await page.click('.random-backdrop.show .random-extract-btn');
      await page.waitForSelector('.aoa .card-call', { state: 'visible' });
    },
  },
  modal: {
    label: 'Scheda film',
    run: async page => {
      await page.click('#main .card');
      await page.waitForSelector('#modal.show #modalContent.in', { state: 'visible' });
    },
  },
  intel: {
    label: 'INTEL',
    run: async page => {
      await page.click('#intelBtn');
      await page.waitForSelector('.stats-panel', { state: 'visible' });
    },
  },
  arrivi: {
    label: 'Pannello ARRIVI (modalità DB)',
    db: true,
    // Il pannello è un dialog modale: axe analizza solo lui (lo sfondo, cioè
    // il carosello, è già coperto dallo stato `carousel`).
    scope: '.random-backdrop.show',
    // TELEFONO: versione dell'app, QR di abbinamento generato, dispositivi di tutti.
    run: async page => {
      await page.click('#arrivalsBtn');
      await page.waitForSelector('.arrivals-panel .arrivals-app-version', { state: 'visible' });
      await page.click('.arrivals-pair-btn');
      await page.waitForSelector('.arrivals-pair img.arrivals-qr', { state: 'visible' });
      await page.check('.arrivals-phone .arrivals-check input');
      await page.waitForSelector('.arrivals-user', { state: 'visible' });
    },
    // Una scansione axe per scheda: i pannelli nascosti non vengono analizzati.
    passes: [
      async page => {
        await page.click('#arrivalsTab-arrivals');
        await page.waitForSelector('.arrivals-item', { state: 'visible' });
        await page.click('.arrivals-segmented .group-btn:not(.active)');
        await page.waitForFunction(() => document.querySelectorAll('.arrivals-item').length === 2);
        await page.click('.arrivals-item .group-btn');
        await page.waitForSelector('.arrivals-form .arrivals-form-grid', { state: 'visible' });
      },
      async page => {
        await page.click('#arrivalsTab-export');
        await page.waitForSelector('#arrivalsPanel-export .random-extract-btn', { state: 'visible' });
      },
      async page => {
        await page.click('#arrivalsTab-fields');
        await page.waitForSelector('.arrivals-table tbody tr', { state: 'visible' });
        await page.check('.arrivals-table tbody tr input[type="checkbox"]:not(:checked)');
      },
      async page => {
        await page.click('#arrivalsTab-import');
        await page.waitForSelector('#arrivalsPanel-import .arrivals-drop', { state: 'visible' });
      },
    ],
  },
};

/** Unisce i risultati axe di più passate: per regola, nodi senza doppioni. */
function mergeAxe(lists) {
  const byRule = new Map();
  for (const list of lists) {
    for (const rule of list) {
      const cur = byRule.get(rule.id);
      if (!cur) { byRule.set(rule.id, { ...rule, nodes: [...rule.nodes] }); continue; }
      const seen = new Set(cur.nodes.map(n => n.target.join(' ')));
      for (const n of rule.nodes) if (!seen.has(n.target.join(' '))) cur.nodes.push(n);
    }
  }
  return [...byRule.values()];
}

/* ------------------------------------------------------------------ */

function pickList(arg, all, what) {
  if (!arg) return all;
  const list = arg.split(',').map(s => s.trim()).filter(Boolean);
  const bad = list.filter(x => !all.includes(x));
  if (bad.length) throw new Error(`${what} sconosciuti: ${bad.join(', ')} (validi: ${all.join(', ')})`);
  return list;
}

async function startPreview() {
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/ non trovato: esegui prima `npm run build` (o usa `npm run a11y`, che builda).');
  }
  const { preview } = await import('vite');
  const server = await preview({ root: ROOT, logLevel: 'warn', preview: { port: 4317, strictPort: false, open: false } });
  return { url: server.resolvedUrls.local[0], close: () => server.close() };
}

async function scanState(browser, baseUrl, theme, stateId, tcBody, outDir) {
  const state = STATES[stateId];
  const loaded = state.loaded !== false;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
    locale: 'it-IT',
  });
  await context.addInitScript(t => {
    try { localStorage.setItem('cm_theme', t); } catch { /* storage non disponibile */ }
  }, theme);

  // Dati serviti al volo: config.json punta alla collezione intercettata;
  // nel loader tutto risponde 404 così l'auto-load fallisce come su un sito vuoto.
  // Gli stati `db` usano invece la modalità DB con l'API simulata.
  if (state.db) {
    await routeDbMode(context);
  } else {
    await context.route(/\/config\.json(\?|$)/, route => loaded
      ? route.fulfill({ json: { tcFile: TC_PATH, imgDir: opts['img-dir'], bgmDir: './__a11y__/bgm/' } })
      : route.fulfill({ status: 404, body: '' }));
    await context.route(/\.tc(\?|$)/, route => loaded && route.request().url().includes(TC_PATH)
      ? route.fulfill({ status: 200, body: tcBody, contentType: 'application/octet-stream' })
      : route.fulfill({ status: 404, body: '' }));
  }
  await context.route(/\/__a11y__\/bgm\//, route => route.fulfill({ status: 404, body: '' }));

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  try {
    await page.goto(baseUrl, { waitUntil: 'load' });
    if (loaded) await page.waitForSelector('#main .card', { state: 'visible', timeout: 15000 });
    await state.run(page);
    await page.evaluate(() => document.fonts.ready);
    await settle(page);

    await page.addScriptTag({ path: AXE_PATH });
    const runAxe = () => page.evaluate(async ({ tags, scope }) => {
      return await axe.run(scope ? { include: [scope] } : document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations', 'incomplete'] });
    }, { tags: WCAG_TAGS, scope: state.scope ?? null });

    const passes = [null, ...(state.passes ?? [])];
    const violations = [];
    const incomplete = [];
    for (const [i, pass] of passes.entries()) {
      if (pass) {
        await pass(page);
        await settle(page);
      }
      const suffix = passes.length > 1 ? `-${i + 1}` : '';
      if (opts.screenshots) await page.screenshot({ path: join(outDir, 'screens', `${theme}-${stateId}${suffix}.png`) });
      const result = await runAxe();
      violations.push(result.violations);
      incomplete.push(result.incomplete);
    }
    return { violations: mergeAxe(violations), incomplete: mergeAxe(incomplete), errors };
  } catch (e) {
    return { violations: [], incomplete: [], errors: [...errors, `scansione fallita: ${e.message}`] };
  } finally {
    await context.close();
  }
}

/* ---------------------------- report ---------------------------- */

const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const wcagRefs = tags => tags.filter(t => /^wcag\d{3,}$/.test(t)).map(t => t.slice(4).split('').join('.')).join(', ');

function nodeDetail(ruleId, node) {
  if (ruleId !== 'color-contrast') return '';
  const d = node.any?.[0]?.data;
  if (!d || !d.contrastRatio) return '';
  return ` — ${d.fgColor} su ${d.bgColor}: **${d.contrastRatio}:1** (serve ${d.expectedContrastRatio}, testo ${d.fontSize} ${d.fontWeight})`;
}

/** Raggruppa per tema → regola → elemento, unendo gli stati in cui compare
 *  (lo sfondo resta nel DOM sotto i popup, quindi lo stesso nodo esce più volte). */
function aggregate(results, kind) {
  const byTheme = new Map();
  for (const r of results) {
    for (const rule of r[kind]) {
      const themeMap = byTheme.get(r.theme) ?? new Map();
      byTheme.set(r.theme, themeMap);
      const entry = themeMap.get(rule.id) ?? { rule, nodes: new Map() };
      themeMap.set(rule.id, entry);
      for (const node of rule.nodes) {
        const key = node.target.join(' ');
        const n = entry.nodes.get(key) ?? { node, states: new Set() };
        n.states.add(r.state);
        entry.nodes.set(key, n);
      }
    }
  }
  return byTheme;
}

function buildMarkdown(results, themes, states, meta) {
  const L = [];
  L.push('# Report accessibilità (axe-core)', '');
  L.push(`- Data: ${meta.date}`);
  L.push(`- Sito: ${meta.url}`);
  L.push(`- Collezione: ${meta.collection}`);
  L.push(`- Regole: ${WCAG_TAGS.join(', ')} · viewport 1440×900 · prefers-reduced-motion`);
  L.push('', 'axe trova circa un terzo dei problemi WCAG: tastiera, zoom/riflusso, text spacing e screen reader vanno comunque verificati a mano.', '');

  L.push('## Riepilogo', '', 'Elementi con violazioni (tra parentesi: da verificare a mano).', '');
  L.push(`| Stato | ${themes.map(t => THEME_LABEL[t]).join(' | ')} |`);
  L.push(`|---|${themes.map(() => '---:').join('|')}|`);
  for (const s of states) {
    const cells = themes.map(t => {
      const r = results.find(x => x.theme === t && x.state === s);
      if (!r) return '–';
      const v = r.violations.reduce((n, x) => n + x.nodes.length, 0);
      const i = r.incomplete.reduce((n, x) => n + x.nodes.length, 0);
      return `${r.errors.some(e => e.startsWith('scansione fallita')) ? '⚠ ' : ''}${v} (${i})`;
    });
    L.push(`| ${STATES[s].label} | ${cells.join(' | ')} |`);
  }

  const errs = results.filter(r => r.errors.length);
  if (errs.length) {
    L.push('', '### Errori durante la scansione', '');
    for (const r of errs) for (const e of r.errors) L.push(`- \`${r.theme}/${r.state}\`: ${e}`);
  }

  const violations = aggregate(results, 'violations');
  const incomplete = aggregate(results, 'incomplete');

  for (const t of themes) {
    L.push('', `## ${THEME_LABEL[t]} (\`${t}\`)`, '');
    const rules = [...(violations.get(t)?.values() ?? [])]
      .sort((a, b) => (IMPACT_ORDER[a.rule.impact] ?? 9) - (IMPACT_ORDER[b.rule.impact] ?? 9));
    if (!rules.length) L.push('Nessuna violazione.');
    for (const { rule, nodes } of rules) {
      L.push(`### ${rule.impact ?? '?'} · \`${rule.id}\` — ${rule.help}`, '');
      L.push(`WCAG ${wcagRefs(rule.tags) || '–'} · ${nodes.size} elementi · [documentazione](${rule.helpUrl})`, '');
      const list = [...nodes.values()];
      for (const { node, states: st } of list.slice(0, 12)) {
        L.push(`- \`${node.target.join(' ')}\` · ${[...st].join(', ')}${nodeDetail(rule.id, node)}`);
      }
      if (list.length > 12) L.push(`- … altri ${list.length - 12} (vedi report.json)`);
      L.push('');
    }

    const inc = [...(incomplete.get(t)?.values() ?? [])];
    if (inc.length) {
      L.push('#### Da verificare a mano', '');
      for (const { rule, nodes } of inc) {
        // Per il contrasto axe dice perché non ha potuto decidere (immagine, gradiente, sovrapposizione…).
        const reasons = new Map();
        for (const { node } of nodes.values()) {
          const msg = (node.any?.[0]?.message ?? node.none?.[0]?.message ?? '').split('.')[0];
          if (msg) reasons.set(msg, (reasons.get(msg) ?? 0) + 1);
        }
        const why = [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => `${m} (${n})`).join('; ');
        L.push(`- \`${rule.id}\` · ${nodes.size} elementi${why ? ` — ${why}` : ''}`);
      }
    }
  }
  return L.join('\n') + '\n';
}

/* ----------------------------- main ----------------------------- */

async function main() {
  const themes = pickList(opts.themes, THEMES, 'Temi');
  const states = pickList(opts.states, Object.keys(STATES), 'Stati');
  const outDir = resolve(ROOT, opts.out);
  await mkdir(opts.screenshots ? join(outDir, 'screens') : outDir, { recursive: true });

  const tcBody = opts.file ? await readFile(resolve(opts.file)) : buildFixtureXml();
  const server = opts.url ? null : await startPreview();
  const baseUrl = opts.url ?? server.url;
  const browser = await chromium.launch();

  const results = [];
  try {
    for (const theme of themes) {
      for (const state of states) {
        process.stdout.write(`  ${theme.padEnd(4)} ${state.padEnd(9)} `);
        const r = await scanState(browser, baseUrl, theme, state, tcBody, outDir);
        results.push({ theme, state, ...r });
        const v = r.violations.reduce((n, x) => n + x.nodes.length, 0);
        const i = r.incomplete.reduce((n, x) => n + x.nodes.length, 0);
        console.log(r.errors.some(e => e.startsWith('scansione fallita')) ? `⚠ ${r.errors.at(-1)}` : `${v} violazioni, ${i} da verificare`);
      }
    }
  } finally {
    await browser.close();
    await server?.close();
  }

  const meta = {
    date: new Date().toISOString(),
    url: opts.url ?? 'vite preview (dist/)',
    collection: opts.file ?? `generata (${FIXTURE.length} film)`,
  };
  await writeFile(join(outDir, 'report.json'), JSON.stringify({ meta, tags: WCAG_TAGS, results }, null, 2));
  await writeFile(join(outDir, 'report.md'), buildMarkdown(results, themes, states, meta));
  console.log(`\nReport: ${join(opts.out, 'report.md')}`);

  const total = results.reduce((n, r) => n + r.violations.length, 0);
  const failed = results.some(r => r.errors.some(e => e.startsWith('scansione fallita')));
  if (failed || (opts.strict && total > 0)) process.exitCode = 1;
}

main().catch(e => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
