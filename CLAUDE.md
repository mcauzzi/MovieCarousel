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
```

`npm run typecheck`/`lint` require `node_modules` (run `npm install` first) or fail on the `jszip` import. Prettier è disponibile come strumento ma **non** è imposto in CI: il codebase ha allineamenti manuali deliberati, quindi non fare mass-reformat (`format:check` non gira in `ci.yml`).

CI: `.github/workflows/ci.yml` gira su ogni PR (e push non-`master`) su runner GitHub-hosted ed esegue install + typecheck + lint + build. `deploy.yml` resta separato (solo push su `master`, runner NAS self-hosted).

## Architecture

Browser-only Vite 5 + TypeScript 5 (strict) app — no backend, no test framework. Runtime dependencies: `jszip`, `lit`, `@fontsource/*` (font self-hostati, bundlati nel build). Dev tooling: `eslint` + `typescript-eslint` + `prettier`.

All UI is built with **lit-html functional templates** (`` html`...` `` rendered via `render()`), not LitElement/web components — no Shadow DOM, so the global `style.css` applies everywhere. Templates are pure functions returning `TemplateResult`, kept in dedicated files under `src/templates/` (they import only `lit` + types, so they stay leaves and don't break the decoupling points). Each view module computes data + handlers and calls `render(template(...), container)`; stateful UI (popups, modal) keeps its state in a closure and re-renders on change — lit diffs efficiently. Event handlers are bound in the templates (`@click`/`@input`/`@error`).

### Module graph (acyclic)

```
main.ts  →  parser.ts       (leaf)
         →  groupers.ts     →  parser.ts, store.ts (types)
         →  renderer.ts     →  parser.ts, groupers.ts, utils.ts, store.ts (types), templates/row, lit
         →  modal.ts        →  parser.ts, utils.ts, store.ts (types), toast.ts, templates/modal, lit
         →  stats.ts        →  parser.ts, store.ts (types), templates/stats, lit
         →  random.ts       →  filters.ts, templates/popup, lit (+ shared types)
         →  filter-popup.ts →  filters.ts, templates/popup, lit (+ shared types)
         →  filters.ts      →  parser.ts, groupers.ts, store.ts, renderer.ts (types only), templates/filters, lit
         →  store.ts, themes.ts, toast.ts, transitions.ts, version-check.ts   (leaves)
         →  templates/*.templates.ts   (leaves — import only lit + types)
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
| `src/modal.ts` | Opens/closes the film detail overlay; watch status & star rating controls (lit re-render on change). `openModal(id, movies, embeddedImages, imgDir, store, onStatusChange?)` |
| `src/filters.ts` | Shared filter logic & UI block builders: `buildPool` (pure) plus `buildGrouperPanel`/`buildPanelShell`/`buildWatchRow` (each owns a root element + lit re-render) |
| `src/templates/` | Pure lit-html template functions: `card`, `row`, `modal`, `stats`, `filters`, `popup`, `toolbar` |
| `src/random.ts` | RANDOM picker popup — private per-grouper selections + watch filter → extract a random film |
| `src/filter-popup.ts` | FILTRI popup — same panels, but selections persist in main and filter the carousel view live |
| `src/stats.ts` | INTEL view — computes and renders collection statistics |
| `src/store.ts` | `LocalStorageAdapter` for watch status and ratings (with seed from the `.tc` file); `setItem` wrapped in try/catch; `setOnExternalChange` ri-renderizza su evento `storage` (sync multi-scheda) |
| `src/themes.ts` | Theme list + `applyTheme`/`getSavedTheme` (persisted in localStorage, `data-theme` on `<html>`) |
| `src/toast.ts` | Toast notifications (`showToast`) |
| `src/version-check.ts` | `checkForNewVersion` — all'avvio confronta il bundle del documento con l'`index.html` fresco dal server; se differiscono ricarica la pagina una volta (anti cache stantia, no-op in dev e su `file://`) |
| `src/transitions.ts` | Page-swipe transition overlay (`withTransition`) |
| `src/utils.ts` | leaf di helper puri: `coverUrl` (URL builder), `fieldValues` (campo Movie → `string[]`), `decadeKey` (anno → `"1990s"`) |
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

- Built lazily on first open, then cached at module level and re-shown; `resetRandomPicker()` / `resetFilterPopup()` destroy them (called on Reload, and `resetFilterPopup` also in `initUI` so a newly loaded file gets fresh panels).
- **RANDOM** keeps its selections private and ends with ESTRAI → `onPick(id)` → film modal.
- **FILTRI** mutates main's `filterSelections` in place and triggers `render()` on every change; its footer shows a live "N / total film" count and a global reset button.

### Persistence (localStorage)

| Key | Content |
|---|---|
| `cm_status` | watch status overrides — `{ [movieId]: 'seen' \| 'watchlist' \| null }` |
| `cm_rating` | star rating overrides — `{ [movieId]: 1–5 \| null }` |
| `cm_theme` | selected theme id (`p5`, `p3`, `p4`) |

Seed semantics: at load, `<visto>true</visto>` and the personal rating field of the `.tc` seed the store **in memory**. A manual override stored in localStorage — including an explicit `null` — always wins over the seed. The Reload button resets only in-memory state; it does **not** clear localStorage. Ids are the `.tc` ids, so overrides survive reloading the same collection but may mismatch if the collection is re-exported with different ids.

`setItem` è avvolto in try/catch: in modalità privata o con quota piena la persistenza fallisce silenziosamente (console.warn) ma la cache in memoria resta valida, quindi la sessione continua. Sync multi-scheda: l'evento `storage` (emesso solo nelle altre tab) invalida la cache e, via `setOnExternalChange` cablato in `main.ts`, ri-renderizza la vista corrente.

### Themes

Defined in `themes.ts` (`THEMES`): `p5` PHANTOM (default, red), `p3` MEMENTO (blue), `p4` MAYONAKA (gold). Selected via the `<select class="theme-dropdown">` in the masthead. `p5` removes the `data-theme` attribute from `<html>`; the others set it, activating the `[data-theme="..."]` CSS custom-property overrides.

To add a theme: append `{ id, label }` to `THEMES` and add a `[data-theme="id"]` block in `style.css` overriding `--hot`, `--hot-2`, `--hot-deep`, `--bg`, `--bg-2`, `--surface`, `--line`.

### Key DOM elements

Static, required in `index.html`: `loader`, `header`, `dropZone`, `fileInput`, `imgDir`, `status`, `countLabel`, `reloadBtn`, `search`, `groupSelect`, `main`, `modal`, `modalContent`.

Created at runtime: `.theme-dropdown` + `#intelBtn` + `#randomBtn` (masthead), `#filterBtn` with `.filter-badge` (toolbar), `#toast`, `#transition-overlay`, the two popup backdrops (`.random-backdrop`).

### XSS safety

All user-sourced strings are interpolated into lit-html `` html`...` `` templates; lit auto-escapes text and attribute bindings, so no manual escaping is needed (the old `escapeHtml` has been removed; `coverUrl` — pure URL construction — remains). Numeric fields (`id`, `year`, `running-time`) interpolate directly. **Never** use the `unsafeHTML` directive for user data — lit does not escape inside it; no current code uses it, keep it that way.

### Accessibilità

Le card e gli item dei picker sono `div` resi attivabili da tastiera: `role="button"` + `tabindex="0"` + handler `@keydown` (Enter/Spazio → click; le card usano un handler stabile `cardKeydown` propagato come `onCardClick`). Il focus è visibile via `:focus-visible` in `style.css`. Il modal è un `role="dialog" aria-modal="true"` con focus trap (Tab/Shift+Tab restano dentro) e ripristino del focus all'elemento di partenza alla chiusura. Il dropdown tema ha un `aria-label`.

### .tc file format

Tellico collection files are ZIP archives containing `tellico.xml`. They may also be plain XML (the parser tries ZIP first, falls back to raw text). Images can be embedded in the XML as base64 or referenced as external files.

### Auto-load e config.json

All'avvio `tryAutoLoad` fa `fetch('config.json')` per leggere `tcFile` e `imgDir`. Se il file manca o è irraggiungibile, usa come fallback il nome derivato dall'URL della pagina + `.tc`. Il parametro URL `?file=path.tc` ha la precedenza su tutto. L'input manuale `#imgDir` nella loader UI sovrascrive `imgDir` da config (utile per drag-and-drop locale). `public/config.json` è la fonte di verità — viene copiato in `dist/` da Vite durante il build. Non modificare `dist/config.json` direttamente.

Solo HTTP/HTTPS: l'auto-load non funziona su `file://`.

## Deploy

**Automatico:** a ogni push su `master`, il workflow `.github/workflows/deploy.yml` gira su un runner self-hosted (container Docker sul NAS, label `nas`) che builda e copia (`cp -r`) `dist/index.html` + **tutti** gli asset hashati: bundle JS/CSS in `dist/assets/` e i font self-hostati `.woff/.woff2` in `dist/assets/fonts/` (la sottocartella è impostata via `assetFileNames` in `vite.config.ts`), nella cartella web montata come `/deploy`. La pulizia dei file stantii è limitata alle estensioni di build (`*.js|css` in `assets/`, `*.woff|woff2` in `assets/fonts/`), quindi `config.json`, `collezione.tc` e `covers/` sul NAS non vengono mai toccati; `dist/config.json` non viene copiato. Il percorso reale della cartella web e il PAT vivono solo nel compose sul NAS — mai nel repo. Setup e manutenzione: `deploy/nas-runner/README.md`.

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
  "title": "Cinema XYZ"
}
```
`title` aggiorna simultaneamente il `<title>` della tab, il titolo nel loader e lo span `.accent` nel masthead.

Richiede un HTTP server — non funziona su `file://`.
