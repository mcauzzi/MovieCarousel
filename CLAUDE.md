# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies (first time)
npm run dev          # dev server at http://localhost:5173 with HMR
npm run build        # production bundle → dist/
npm run preview      # serve dist/ at http://localhost:4173
npm run typecheck    # tsc --noEmit (no test suite exists)
npm run lint         # ESLint (flat config, typescript-eslint)
npm run format       # Prettier --write su src/**/*.ts (opt-in)
npm run a11y         # build + scansione axe-core (WCAG 2.2 AA) su temi × stati → a11y-report/
```

`npm run a11y` esegue `scripts/a11y-scan.mjs`: per ogni tema (`p5`, `p3`, `p4`, `sh2`) e stato (loader, carosello, popup FILTRI, picker RANDOM, biglietto, scheda film, INTEL) apre una pagina fresca in Chromium (Playwright, `prefers-reduced-motion`), serve `config.json` e una collezione di prova generata intercettando le richieste, e lancia axe. Scrive `a11y-report/report.md` (riepilogo + violazioni per tema, deduplicate tra gli stati, con i rapporti di contrasto) e `report.json` (gitignorati). Opzioni dopo `--`: `--file mia.tc` (collezione reale), `--themes`, `--states`, `--screenshots`, `--url` (server già avviato), `--strict` (exit 1 se ci sono violazioni). Su una macchina nuova serve `npx playwright install chromium`. Non gira in CI.

`npm run typecheck`/`lint` require `node_modules` (run `npm install` first) or fail on the `jszip` import. Prettier è disponibile come strumento ma **non** è imposto in CI: il codebase ha allineamenti manuali deliberati, quindi non fare mass-reformat (`format:check` non gira in `ci.yml`).

CI: `.github/workflows/ci.yml` gira su ogni PR (e push non-`master`) su runner GitHub-hosted ed esegue install + typecheck + lint + build. `deploy.yml` resta separato (solo push su `master`, builda e pubblica l'immagine Docker su GHCR).

## Architecture

Browser-only Vite 5 + TypeScript 5 (strict) app — no backend, no test framework. Runtime dependencies: `jszip`, `lit`, `@fontsource/*` (font self-hostati, bundlati nel build: Anton, Oswald, JetBrains Mono, Bebas Neue; Barlow Condensed per MEMENTO, Baloo 2 per MAYONAKA, EB Garamond + Special Elite + Courier Prime per TOLUCA). Dev tooling: `eslint` + `typescript-eslint` + `prettier`; `axe-core` + `playwright` solo per `npm run a11y`.

All UI is built with **lit-html functional templates** (`` html`...` `` rendered via `render()`), not LitElement/web components — no Shadow DOM, so the global `style.css` applies everywhere. Templates are pure functions returning `TemplateResult`, kept in dedicated files under `src/templates/` (they import only `lit` + types, so they stay leaves and don't break the decoupling points). Each view module computes data + handlers and calls `render(template(...), container)`; stateful UI (popups, modal) keeps its state in a closure and re-renders on change — lit diffs efficiently. Event handlers are bound in the templates (`@click`/`@input`/`@error`).

### Module graph (acyclic)

```
main.ts  →  parser.ts       (leaf)
         →  groupers.ts     →  parser.ts, store.ts (types)
         →  renderer.ts     →  parser.ts, groupers.ts, utils.ts, store.ts (types), templates/row, lit
         →  modal.ts        →  parser.ts, utils.ts, store.ts (types), toast.ts, templates/modal, lit
         →  stats.ts        →  parser.ts, store.ts (types), templates/stats, lit
         →  random.ts       →  filters.ts, templates/popup, templates/attack, lit (+ shared types)
         →  filter-popup.ts →  filters.ts, templates/popup, lit (+ shared types)
         →  filters.ts      →  parser.ts, groupers.ts, store.ts, renderer.ts (types only), templates/filters, lit
         →  store.ts, themes.ts, toast.ts, transitions.ts, version-check.ts, copy.ts   (leaves)
         →  templates/*.templates.ts   (import only lit, types, utils.ts, copy.ts and other templates — mai moduli con stato)
         →  style.css

utils.ts (leaf — no imports)
```

Two deliberate decoupling points — preserve them:

- `renderer.ts` does **not** import `modal.ts`. `main.ts` builds an `onOpenModal` callback and passes it to `renderMain` (which wires it into the card template's `@click`) — this breaks the only potential circular dependency.
- `filters.ts` holds the building blocks shared by the random picker and the filter popup (`buildPool`, `buildGrouperPanel`, `buildPanelShell`, `buildWatchRow`). Neither `random.ts` nor `filter-popup.ts` imports the other. The shared lit templates live in `templates/filters.templates.ts` and `templates/popup.templates.ts`.

All mutable application state lives exclusively in `main.ts` (movies, embeddedImages, imgDir, configuredImgDir, groupers, currentGrouper, searchTerm, isIntelView, watchFilter, filterSelections). `random.ts` and `filter-popup.ts` cache only their built popup DOM at module level (released via `resetRandomPicker` / `resetFilterPopup`); the filter popup mutates `filterSelections` (owned by main) in place.

### Module responsibilities

| File | Responsibility |
|---|---|
| `src/main.ts` | Entry point — state, DOM event wiring, `handleFile`, `initUI`, `tryAutoLoad`, theme dropdown |
| `src/parser.ts` | Parses Tellico `.tc` XML → `Movie[]` + embedded images map |
| `src/groupers.ts` | Builds `Grouper[]` from movies; `matchesSearch` for filtering |
| `src/renderer.ts` | Renders the carousel into `#main` via lit (search + watch filter + optional `allowedIds`); owns the failed-image set; events bound in templates, carousel scroll via `e.currentTarget`. `renderMain(grouper, searchTerm, embeddedImages, imgDir, store, onOpenModal, watchFilter?, allowedIds?)`, `resetRenderer()` |
| `src/modal.ts` | Opens/closes the film detail overlay ("dossier"): cut-in a tutto schermo col titolo (`.modal-cutin`, creato a runtime; saltato con `prefers-reduced-motion`), poi il dossier entra; watch status & RANK a tacche 1–5 (lit re-render on change). `openModal(id, movies, embeddedImages, imgDir, store, onStatusChange?)`. L'apertura NON passa da `withTransition`: il cut-in la sostituisce. Durante il cut-in il focus è già sul dialog (`#modalContent` tabindex -1, trap attivo) e il click sul backdrop non chiude (evita che un doppio click chiuda la scheda appena aperta) |
| `src/filters.ts` | Shared filter logic & UI block builders: `buildPool` (pure) plus `buildGrouperPanel`/`buildPanelShell`/`buildWatchRow` (each owns a root element + lit re-render) |
| `src/templates/` | Pure lit-html template functions: `card`, `row`, `modal`, `stats`, `filters`, `popup`, `toolbar`, `attack` (All-Out Attack + biglietto), `ransom` (`ransomTemplate` lettere ritagliate per parola, aria-hidden → il chiamante mette il nome accessibile; `capTitleTemplate` solo iniziale) |
| `src/random.ts` | RANDOM picker popup — private per-grouper selections + watch filter → ESTRAI lancia l'overlay "All-Out Attack" (`.aoa`, ~1.1 s) e poi il biglietto col film estratto: APRI SCHEDA (`onPick`), RITENTA (tasto R; ri-estrae dallo stesso pool senza ripescare il film corrente), MODIFICA (riapre il picker), CHIUDI/Escape. Picker e overlay sono cache-ati a livello modulo: `resetRandomPicker` (Reload, nuova collezione) li rilascia entrambi, `refreshRandomPicker` (rebuild dei grouper, anche da sync multi-scheda) solo il picker, così un biglietto aperto sopravvive e RITENTA ripiega sul pool del lancio |
| `src/filter-popup.ts` | FILTRI popup — same panels, but selections persist in main and filter the carousel view live |
| `src/stats.ts` | INTEL view — computes and renders collection statistics (titolo ransom, PROGRESS a tacche, radar SVG dei top generi in scala, barre oblique) |
| `src/store.ts` | `LocalStorageAdapter` for watch status and ratings (with seed from the `.tc` file); `setItem` wrapped in try/catch; `setOnExternalChange` ri-renderizza su evento `storage` (sync multi-scheda) |
| `src/themes.ts` | Theme list + `applyTheme`/`getSavedTheme` (persisted in localStorage, `data-theme` on `<html>`) |
| `src/copy.ts` | Testi "di colore" per tema (`COPY: Record<ThemeId, ThemeCopy>`, `currentCopy()` legge `data-theme`): unità del contatore, etichetta e numero di riga, timbri visto/watchlist, segnaposto copertina, intestazione e toast della scheda, titolo del picker, testi dell'All-Out Attack e del biglietto, intestazione e card INTEL, loader, placeholder ricerca, messaggi di caricamento. Foglia senza import. I nomi funzionali dei controlli (FILTRI, RANDOM, INTEL, VISTA, SEEN/WATCHLIST) e i messaggi d'errore restano uguali in ogni tema |
| `src/toast.ts` | Toast notifications (`showToast`) |
| `src/version-check.ts` | `checkForNewVersion` — all'avvio confronta il bundle del documento con l'`index.html` fresco dal server; se differiscono ricarica la pagina una volta (anti cache stantia, no-op in dev e su `file://`) |
| `src/bgm.ts` | Widget musica di sottofondo nel masthead — `initBgm(masthead, anchorEl, bgmDir?)`. Controller leaf auto-contenuto: discovery tracce (autoindex del server → fallback manifest `bgm/tracks.json`), elemento `<audio loop>`, play/pausa + volume, stato in closure. **Deroga** consapevole all'invariante "stato solo in main.ts": lo stato del player è UI-locale (come `toast.ts`/`transitions.ts`), non stato di dominio. Se non trova tracce non monta nulla |
| `src/transitions.ts` | Page-swipe transition overlay (`withTransition`) |
| `src/utils.ts` | leaf di helper puri: `coverUrl` (URL builder), `fieldValues` (campo Movie → `string[]`), `decadeKey` (anno → `"1990s"`), `seededRandom` (PRNG deterministico da stringa: composizioni ransom e poligono/inclinazione per-card in `renderer.ts`, stabili tra i render), `focusablesIn` + `trapTab` (focus trap condiviso da scheda film e All-Out Attack; unici helper con DOM, senza stato) |
| `src/style.css` | All CSS (CSS custom properties for theming via `:root` + `[data-theme]`) |

### Data flow

1. User drops a `.tc` file (or it auto-loads via `tryAutoLoad`)
2. `handleFile` → JSZip extracts `tellico.xml` (falls back to raw XML if not zipped); seeds the store from the `.tc` "Visto" and rating fields
3. `parseTellicoXml` → `{ movies: Movie[], embeddedImages: Map<string, string> }`; il parser **garantisce** un `id` numerico valido per ogni film (gli id mancanti/NaN ricevono un id sintetico da max+1), quindi i consumatori non castano `Movie.id`
4. `initUI` → `buildGroupers(movies, store)` → populates group selector buttons, masthead buttons (INTEL, RANDOM), FILTRI button → `render()`
5. `render()` → computes `allowedIds` from `filterSelections` via `buildPool` → builds `onOpenModal` (card click → `openModal`) → `renderMain(grouper, searchTerm, embeddedImages, imgDir, store, onOpenModal, watchFilter, allowedIds)` which lit-renders the carousel
6. Card click → `openModal(id, movies, embeddedImages, imgDir, store, render)` — the `onStatusChange` callback re-renders `#main` so the card badge stays in sync (no manual DOM mutation across render roots)

### Filtering semantics

A card is visible in the carousel view iff **all** of these pass (logical AND):

- **FILTRI selections** (`filterSelections`): per-grouper key sets chosen in the FILTRI popup, resolved to an id set by `buildPool`. Within one grouper keys are OR'd; across groupers AND. The special key `__none__` means "movies with no value for this field". Empty selection = no constraint.
- **Search term** (`#search`, 300 ms debounce): substring match on title, director, cast and genre (`matchesSearch`).
- **Watch filter** (`all` / `seen` / `unseen`): set from the VISIONE row in the FILTRI popup, checked against `store.getStatus`.

Rows left empty by filtering are dropped entirely. The INTEL view ignores search and filters. The FILTRI button shows a badge with the count of active filters (selections + watch filter ≠ all).

### Popups (RANDOM e FILTRI)

Both popups are built from the `filters.ts` building blocks and share the `random-*` CSS classes. The shell (`buildPanelShell`, kept imperative) provides backdrop, accented title, ✕ button, click-outside and Escape closing, and a `destroy()` that detaches DOM + key listener. Each popup appends a `body` container to the shell `panel` and lit-renders its grid/watch-row/footer there (`templates/popup.templates.ts`); the live grouper-panel and watch-row elements are interpolated into that template as DOM nodes (lit keeps them in place across re-renders, preserving their internal state).

- Built lazily on first open, then cached at module level and re-shown; `resetRandomPicker()` / `resetFilterPopup()` destroy them (called on Reload, and `resetFilterPopup` also in `initUI` so a newly loaded file gets fresh panels; on a grouper rebuild main calls `refreshRandomPicker()` instead, which keeps an open All-Out Attack ticket alive).
- **RANDOM** keeps its selections private and ends with ESTRAI → All-Out Attack → biglietto → APRI SCHEDA → `onPick(id)` → film modal (RITENTA/R ri-estrae dal pool corrente del picker).
- **FILTRI** mutates main's `filterSelections` in place and triggers `render()` on every change; its footer shows a live "N / total film" count and a global reset button.

### Persistence (localStorage)

| Key | Content |
|---|---|
| `cm_status` | watch status overrides — `{ [movieId]: 'seen' \| 'watchlist' \| null }` |
| `cm_rating` | star rating overrides — `{ [movieId]: 1–5 \| null }` |
| `cm_theme` | selected theme id (`p5`, `p3`, `p4`, `sh2`) |
| `cm_bgm_vol` | volume musica di sottofondo (`0..1`, default `0.5`) |
| `cm_bgm_track` | nome file dell'ultima traccia BGM scelta (ripristinata nel dropdown ma **non** riavviata automaticamente) |

Seed semantics: at load, `<visto>true</visto>` and the personal rating field of the `.tc` seed the store **in memory**. A manual override stored in localStorage — including an explicit `null` — always wins over the seed. The Reload button resets only in-memory state; it does **not** clear localStorage. Ids are the `.tc` ids, so overrides survive reloading the same collection but may mismatch if the collection is re-exported with different ids.

`setItem` è avvolto in try/catch: in modalità privata o con quota piena la persistenza fallisce silenziosamente (console.warn) ma la cache in memoria resta valida, quindi la sessione continua. Sync multi-scheda: l'evento `storage` (emesso solo nelle altre tab) invalida la cache e, via `setOnExternalChange` cablato in `main.ts`, ri-renderizza la vista corrente.

### Themes

Defined in `themes.ts` (`THEMES`): `p5` PHANTOM (default, red), `p3` MEMENTO (blue), `p4` MAYONAKA (gold), `sh2` TOLUCA (Silent Hill 2: nebbia, ruggine, sangue secco). Selected via the `<select class="theme-dropdown">` in the masthead. `p5` removes the `data-theme` attribute from `<html>`; the others set it, activating the `[data-theme="..."]` CSS custom-property overrides.

Token tematici trasversali: `--on-hot` (colore del testo sopra uno sfondo `--hot`: bianco su P5, scuro su P3/P4 dove serve — usalo sempre al posto di `--ink` in quel caso), `--tilt` (moltiplicatore delle inclinazioni decorative: ogni rotazione "a mano" è `rotate(calc(Xdeg * var(--tilt)))`; 1 su P5, 0 su P3, 0.5 su P4), `--f-display` / `--f-head` / `--f-mono` (famiglie per ruolo: tutte le `font-family` di `style.css` passano da qui). `--star` e `--burst` sono clip-path a stella riusabili (P4 li ridefinisce come forme tonde, SH2 come quadrati).

Ogni tema ha un proprio linguaggio visivo, non solo una palette. Le regole di base (e la sezione TEMI coi token) disegnano PHANTOM; MEMENTO, MAYONAKA e TOLUCA hanno ciascuno una sezione in fondo a `style.css` ("TEMA MEMENTO (P3)", "TEMA MAYONAKA (P4)", "TEMA TOLUCA (SH2)") dove **ogni selettore inizia con `[data-theme="<id>"]`** — PHANTOM non deve mai dipendere da quelle sezioni. Token privati: `--p3-*`, `--p4-*`, `--sh-*`.
- **PHANTOM (P5):** rosso/nero/bianco, lettere ritagliate, poligoni strappati, ombre piene sfalsate, scatti con overshoot. Font Anton + Oswald.
- **MEMENTO (P3 Reload):** blu notte e ciano, vetro e acqua, luna dell'Ora Buia, parallelogrammi puliti, nessuna rotazione, movimenti fluidi senza rimbalzi; i titoli ransom diventano un logotipo sottile (prima lettera ciano). Font Barlow Condensed. `backdrop-filter` solo su modal/popup/biglietto/loader, mai sulle card.
- **MAYONAKA (P4):** giallo/nero, Midnight Channel: card e scheda come televisori (antenne, vetro CRT), statico e scanline, pavimento a scacchi e nebbia (`html::before/::after`), nastro giallo/nero, forme arrotondate (clip-path azzerati), bottoni "pressabili", pop giocosi; titoli ransom a tasselli tondi. Font Baloo 2.
- **TOLUCA (SH2):** notte nella nebbia (due banchi su `html::before/::after` + nebbia bassa davanti alle righe su `main::after`), ruggine e sangue secco, nessuna rotazione, movimenti lenti senza rimbalzi. Card come fotografie sbiadite sotto un velo grigio che tornano a colori su hover/focus, righe come stanze d'albergo (targhetta d'ottone), watchlist = quadrato rosso del salvataggio, visto = timbro ruggine. Scheda film e biglietto su carta ingiallita: dentro `.modal` e `.stats-panel` i token (`--ink`, `--bg`, `--surface`…) sono rimappati sull'inchiostro scuro, così le regole di base si adattano. All-Out Attack = radio (statico, interferenze, lampo rosso), INTEL = mappa a quadretti. Titoli ransom in serif spaziato con l'iniziale rossa. Font EB Garamond (display) + Special Elite (testo) + Courier Prime (mono).
Anche i testi seguono il tema (`copy.ts`: Ladri Fantasma in P5, Velvet Room/S.E.E.S. con Arcani in numeri romani in P3, Investigation Team/Midnight Channel in P4, nebbia/memo/radio con le righe numerate come stanze `ROOM 3xx` in SH2 — testi originali, nessuna citazione dal gioco): mai sostituirli via CSS `content`, aggiungere la chiave in `ThemeCopy`. Al cambio tema `onThemeChange` in `main.ts` aggiorna i testi statici (elementi `[data-copy="<chiave>"]` di `index.html` + placeholder di `#search`), il contatore, rilascia il picker RANDOM (`refreshRandomPicker`, titolo costruito una volta) e ri-renderizza la vista corrente. I font di P3/P4/SH2 sono bundlati via `@fontsource` ma scaricati dal browser solo quando il tema li usa. Ogni sezione tema ha il proprio blocco `prefers-reduced-motion` (le sue regole sono più specifiche di quelle base).

To add a theme: append `{ id, label }` to `THEMES` and add a `[data-theme="id"]` block in `style.css` overriding `--hot`, `--hot-2`, `--hot-deep`, `--bg`, `--bg-2`, `--surface`, `--line` (and `--on-hot` / `--tilt` / `--f-*` if the defaults don't fit); for a distinct visual language add a dedicated "TEMA …" section at the end of `style.css` with every selector scoped to `[data-theme="id"]`.

### Key DOM elements

Static, required in `index.html`: `loader`, `header`, `dropZone`, `fileInput`, `imgDir`, `status`, `countLabel`, `reloadBtn`, `search`, `groupSelect`, `main`, `modal`, `modalContent`.

Created at runtime: `.theme-dropdown` + `#intelBtn` + `#randomBtn` (masthead), `#filterBtn` with `.filter-badge` (toolbar), `#toast`, `#transition-overlay`, the two popup backdrops (`.random-backdrop`), `.modal-cutin` (banda del cut-in, aria-hidden), `.aoa` (overlay All-Out Attack / biglietto). Il titolo di loader e masthead è renderizzato da `renderTitle` in `main.ts` (ransom + `aria-label` sull'h1), anche quando arriva da `config.json`.

### XSS safety

All user-sourced strings are interpolated into lit-html `` html`...` `` templates; lit auto-escapes text and attribute bindings, so no manual escaping is needed (the old `escapeHtml` has been removed; `coverUrl` — pure URL construction — remains). Numeric fields (`id`, `year`, `running-time`) interpolate directly. **Never** use the `unsafeHTML` directive for user data — lit does not escape inside it; no current code uses it, keep it that way.

### Accessibilità

Le card e gli item dei picker sono `div` resi attivabili da tastiera: `role="button"` + `tabindex="0"` + handler `@keydown` (Enter/Spazio → click; le card usano un handler stabile `cardKeydown` propagato come `onCardClick`). L'`aria-label` della card riporta tutto il testo visibile, titolo per primo (titolo, anno, regista, timbro di stato). Il focus è visibile via `:focus-visible` in `style.css`. Contrasto: il testo piccolo deve arrivare a 4.5:1 — `--ink-faint` è pensato per le decorazioni, per il testo "spento" nei temi scuri ci sono `--p4-faint-txt` e `--sh-faint-txt`; verifica con `npm run a11y`. Il modal è un `role="dialog" aria-modal="true"` con focus trap (Tab/Shift+Tab restano dentro) e ripristino del focus all'elemento di partenza alla chiusura. Il dropdown tema ha un `aria-label`. I titoli ransom hanno le lettere `aria-hidden` e il nome in `aria-label` (o testo visually-hidden). L'overlay All-Out Attack è un dialog con focus trap, Escape gestito in capture (chiude solo lui) e ritorno del focus a `#randomBtn`. Con `prefers-reduced-motion` cut-in, raffica e flip vengono saltati.

### .tc file format

Tellico collection files are ZIP archives containing `tellico.xml`. They may also be plain XML (the parser tries ZIP first, falls back to raw text). Images can be embedded in the XML as base64 or referenced as external files.

### Auto-load e config.json

All'avvio `tryAutoLoad` fa `fetch('config.json')` per leggere `tcFile`, `imgDir` e `bgmDir` (opzionale, default `./assets/bgm/` — cartella delle tracce di sottofondo). Se il file manca o è irraggiungibile, usa come fallback il nome derivato dall'URL della pagina + `.tc`. Il parametro URL `?file=path.tc` ha la precedenza su tutto. L'input manuale `#imgDir` nella loader UI sovrascrive `imgDir` da config (utile per drag-and-drop locale). `public/config.json` è la fonte di verità — viene copiato in `dist/` da Vite durante il build. Non modificare `dist/config.json` direttamente.

Solo HTTP/HTTPS: l'auto-load non funziona su `file://`.

## Deploy

**Automatico:** a ogni push su `master`, `.github/workflows/deploy.yml` (runner GitHub-hosted) builda l'immagine dal `Dockerfile` (typecheck + `vite build`, poi `nginx:stable-alpine` con dentro solo `dist/`) e la pubblica come `ghcr.io/mcauzzi/moviecarousel:latest` (più il tag con lo SHA). Sul NAS lo stack Komodo `cinemalometti` usa `deploy/compose.yml` e aggiorna il container quando esce l'immagine nuova. Nessun runner self-hosted: il NAS non esegue codice preso da GitHub.

I dati non sono nell'immagine: la cartella del NAS (`config.json`, `assets/<collezione>.tc`, `assets/covers/`, `assets/bgm/`) è montata in sola lettura su `/srv/data`. `deploy/nginx.conf` serve prima il bundle dell'immagine e, per tutto ciò che non c'è, ripiega sui dati; quindi index.html e bundle vecchi rimasti nella cartella del NAS vengono ignorati. `assets/bgm/` ha `autoindex on` perché `bgm.ts` scopre le tracce dal listing (se cambi `bgmDir` in `config.json`, aggiorna anche quella location). `index.html` è servito `no-cache` (serve a `version-check.ts`), bundle e font hashati `immutable`.

Variabili dello stack Komodo: `WEB_ROOT` (cartella dei dati sul NAS, obbligatoria) e `PORT` (porta host, default `8091`). Caddy su OPNsense fa reverse proxy HTTP verso quella porta, con forward auth Authelia.

**Manuale** (fallback):

```bash
npm run build
```

Struttura da copiare sul NAS:

```
web-root/
├── index.html          ← da dist/
├── assets/
│   ├── index-xxx.js    ← da dist/assets/
│   ├── index-xxx.css   ← da dist/assets/
│   ├── fonts/          ← font self-hostati .woff/.woff2 (da dist/assets/fonts/)
│   ├── collezione.tc
│   └── covers/   ← cartella copertine
└── config.json         ← modifica qui i path se riorganizzi i file
```

`config.json` controlla path e titolo senza ricompilare:
```json
{
  "tcFile": "./assets/collezione.tc",
  "imgDir": "./assets/covers/",
  "title": "Cinema XYZ",
  "bgmDir": "./assets/bgm/"
}
```
`title` aggiorna simultaneamente il `<title>` della tab, il titolo nel loader e lo span `.accent` nel masthead.

Richiede un HTTP server — non funziona su `file://`.
