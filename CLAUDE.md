# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies (first time)
npm run dev          # dev server at http://localhost:5173 with HMR
npm run build        # production bundle → dist/
npm run preview      # serve dist/ at http://localhost:4173
npx tsc --noEmit     # type-check without emitting (no test suite exists)
```

`npx tsc --noEmit` requires `node_modules` (run `npm install` first) or it fails on the `jszip` import.

## Architecture

Browser-only Vite 5 + TypeScript 5 (strict) app — no backend, no test framework. Single npm runtime dependency: `jszip`.

### Module graph (acyclic)

```
main.ts  →  parser.ts       (leaf)
         →  groupers.ts     →  parser.ts, store.ts (types)
         →  renderer.ts     →  parser.ts, groupers.ts, utils.ts, store.ts (types)
         →  modal.ts        →  parser.ts, utils.ts, store.ts (types), toast.ts
         →  stats.ts        →  parser.ts, store.ts (types), utils.ts
         →  random.ts       →  filters.ts (+ shared types)
         →  filter-popup.ts →  filters.ts (+ shared types)
         →  filters.ts      →  parser.ts, groupers.ts, store.ts, renderer.ts (types only)
         →  store.ts, themes.ts, toast.ts, transitions.ts, version-check.ts   (leaves)
         →  style.css

utils.ts (leaf — no imports)
```

Two deliberate decoupling points — preserve them:

- `renderer.ts` does **not** import `modal.ts`. `main.ts` passes `openModal` as a callback (`OpenModalFn`) to `attachHandlers` — this breaks the only potential circular dependency.
- `filters.ts` holds the building blocks shared by the random picker and the filter popup (`buildPool`, `buildGrouperPanel`, `buildPanelShell`, `buildWatchRow`). Neither `random.ts` nor `filter-popup.ts` imports the other.

All mutable application state lives exclusively in `main.ts` (movies, embeddedImages, imgDir, configuredImgDir, groupers, currentGrouper, searchTerm, isIntelView, watchFilter, filterSelections). `random.ts` and `filter-popup.ts` cache only their built popup DOM at module level (released via `resetRandomPicker` / `resetFilterPopup`); the filter popup mutates `filterSelections` (owned by main) in place.

### Module responsibilities

| File | Responsibility |
|---|---|
| `src/main.ts` | Entry point — state, DOM event wiring, `handleFile`, `initUI`, `tryAutoLoad`, theme dropdown |
| `src/parser.ts` | Parses Tellico `.tc` XML → `Movie[]` + embedded images map |
| `src/groupers.ts` | Builds `Grouper[]` from movies; `matchesSearch` for filtering |
| `src/renderer.ts` | Generates row/card HTML (search + watch filter + optional `allowedIds`), attaches carousel and card click handlers |
| `src/modal.ts` | Opens/closes the film detail overlay; watch status & star rating controls |
| `src/filters.ts` | Shared filter logic & UI blocks: `buildPool`, `buildGrouperPanel`, `buildPanelShell`, `buildWatchRow` |
| `src/random.ts` | RANDOM picker popup — private per-grouper selections + watch filter → extract a random film |
| `src/filter-popup.ts` | FILTRI popup — same panels, but selections persist in main and filter the carousel view live |
| `src/stats.ts` | INTEL view — computes and renders collection statistics |
| `src/store.ts` | `LocalStorageAdapter` for watch status and ratings (with seed from the `.tc` file) |
| `src/themes.ts` | Theme list + `applyTheme`/`getSavedTheme` (persisted in localStorage, `data-theme` on `<html>`) |
| `src/toast.ts` | Toast notifications (`showToast`) |
| `src/version-check.ts` | `checkForNewVersion` — all'avvio confronta il bundle del documento con l'`index.html` fresco dal server; se differiscono ricarica la pagina una volta (anti cache stantia, no-op in dev e su `file://`) |
| `src/transitions.ts` | Page-swipe transition overlay (`withTransition`) |
| `src/utils.ts` | `escapeHtml` and `coverUrl` — pure, imported by renderer, modal and stats |
| `src/style.css` | All CSS (CSS custom properties for theming via `:root` + `[data-theme]`) |

### Data flow

1. User drops a `.tc` file (or it auto-loads via `tryAutoLoad`)
2. `handleFile` → JSZip extracts `tellico.xml` (falls back to raw XML if not zipped); seeds the store from the `.tc` "Visto" and rating fields; assigns synthetic ids to movies without a valid one
3. `parseTellicoXml` → `{ movies: Movie[], embeddedImages: Map<string, string> }`
4. `initUI` → `buildGroupers(movies, store)` → populates group selector buttons, masthead buttons (INTEL, RANDOM), FILTRI button → `render()`
5. `render()` → computes `allowedIds` from `filterSelections` via `buildPool` → `renderMain(grouper, searchTerm, embeddedImages, imgDir, store, watchFilter, allowedIds)` then `attachHandlers(..., openModal)`
6. Card click → `openModal(id, movies, embeddedImages, imgDir, store)`

### Filtering semantics

A card is visible in the carousel view iff **all** of these pass (logical AND):

- **FILTRI selections** (`filterSelections`): per-grouper key sets chosen in the FILTRI popup, resolved to an id set by `buildPool`. Within one grouper keys are OR'd; across groupers AND. The special key `__none__` means "movies with no value for this field". Empty selection = no constraint.
- **Search term** (`#search`, 300 ms debounce): substring match on title, director, cast and genre (`matchesSearch`).
- **Watch filter** (`all` / `seen` / `unseen`): set from the VISIONE row in the FILTRI popup, checked against `store.getStatus`.

Rows left empty by filtering are dropped entirely. The INTEL view ignores search and filters. The FILTRI button shows a badge with the count of active filters (selections + watch filter ≠ all).

### Popups (RANDOM e FILTRI)

Both popups are built from the `filters.ts` building blocks and share the `random-*` CSS classes. The shell (`buildPanelShell`) provides backdrop, accented title, ✕ button, click-outside and Escape closing, and a `destroy()` that detaches DOM + key listener.

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

### Themes

Defined in `themes.ts` (`THEMES`): `p5` PHANTOM (default, red), `p3` MEMENTO (blue), `p4` MAYONAKA (gold). Selected via the `<select class="theme-dropdown">` in the masthead. `p5` removes the `data-theme` attribute from `<html>`; the others set it, activating the `[data-theme="..."]` CSS custom-property overrides.

To add a theme: append `{ id, label }` to `THEMES` and add a `[data-theme="id"]` block in `style.css` overriding `--hot`, `--hot-2`, `--hot-deep`, `--bg`, `--bg-2`, `--surface`, `--line`.

### Key DOM elements

Static, required in `index.html`: `loader`, `header`, `dropZone`, `fileInput`, `imgDir`, `status`, `countLabel`, `reloadBtn`, `search`, `groupSelect`, `main`, `modal`, `modalContent`.

Created at runtime: `.theme-dropdown` + `#intelBtn` + `#randomBtn` (masthead), `#filterBtn` with `.filter-badge` (toolbar), `#toast`, `#transition-overlay`, the two popup backdrops (`.random-backdrop`).

### XSS safety

All user-sourced string data is passed through `escapeHtml` before any `innerHTML` assignment (renderer, modal, stats use HTML template strings). Numeric fields (`id`, `year`, `running-time`) are interpolated directly without escaping. `filters.ts`, `random.ts` and `filter-popup.ts` build DOM via `createElement`/`textContent`, which is inherently safe — keep it that way when extending them.

### .tc file format

Tellico collection files are ZIP archives containing `tellico.xml`. They may also be plain XML (the parser tries ZIP first, falls back to raw text). Images can be embedded in the XML as base64 or referenced as external files.

### Auto-load e config.json

All'avvio `tryAutoLoad` fa `fetch('config.json')` per leggere `tcFile` e `imgDir`. Se il file manca o è irraggiungibile, usa come fallback il nome derivato dall'URL della pagina + `.tc`. Il parametro URL `?file=path.tc` ha la precedenza su tutto. L'input manuale `#imgDir` nella loader UI sovrascrive `imgDir` da config (utile per drag-and-drop locale). `public/config.json` è la fonte di verità — viene copiato in `dist/` da Vite durante il build. Non modificare `dist/config.json` direttamente.

Solo HTTP/HTTPS: l'auto-load non funziona su `file://`.

## Deploy

**Automatico:** a ogni push su `master`, il workflow `.github/workflows/deploy.yml` gira su un runner self-hosted (container Docker sul NAS, label `nas`) che builda e copia `dist/index.html` + `dist/assets/index-*.js|css` nella cartella web montata come `/deploy`. `config.json`, `collezione.tc` e `covers/` sul NAS non vengono mai toccati; `dist/config.json` non viene copiato. Il percorso reale della cartella web e il PAT vivono solo nel compose sul NAS — mai nel repo. Setup e manutenzione: `deploy/nas-runner/README.md`.

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
