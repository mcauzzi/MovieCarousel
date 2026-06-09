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
         →  store.ts, themes.ts, toast.ts, transitions.ts   (leaves)
         →  style.css

utils.ts (leaf — no imports)
```

`renderer.ts` does **not** import `modal.ts`. Instead, `main.ts` passes `openModal` as a callback (`OpenModalFn`) to `attachHandlers` — this breaks the only potential circular dependency.

`filters.ts` holds the building blocks shared by the random picker and the filter popup (`buildPool`, `buildGrouperPanel`, `buildPanelShell`, `buildWatchRow`). Neither `random.ts` nor `filter-popup.ts` imports the other.

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
| `src/random.ts` | RANDOM picker popup — per-grouper selections + watch filter → extract a random film |
| `src/filter-popup.ts` | FILTRI popup — same panels, but selections persist in main and filter the carousel view live |
| `src/stats.ts` | INTEL view — computes and renders collection statistics |
| `src/store.ts` | `LocalStorageAdapter` for watch status and ratings (with seed from the `.tc` file) |
| `src/themes.ts` | Theme list + `applyTheme`/`getSavedTheme` (persisted in localStorage, `data-theme` on `<html>`) |
| `src/toast.ts` | Toast notifications |
| `src/transitions.ts` | Page-swipe transition overlay (`withTransition`) |
| `src/utils.ts` | `escapeHtml` and `coverUrl` — pure, imported by renderer, modal and stats |
| `src/style.css` | All CSS (CSS custom properties for theming via `:root` + `[data-theme]`) |

### Data flow

1. User drops a `.tc` file (or it auto-loads via `tryAutoLoad`)
2. `handleFile` → JSZip extracts `tellico.xml` (falls back to raw XML if not zipped)
3. `parseTellicoXml` → `{ movies: Movie[], embeddedImages: Map<string, string> }`
4. `initUI` → `buildGroupers(movies, store)` → populates group selector buttons → `render()`
5. `render()` → computes `allowedIds` from `filterSelections` via `buildPool` → `renderMain(grouper, searchTerm, embeddedImages, imgDir, store, watchFilter, allowedIds)` then `attachHandlers(..., openModal)`
6. Card click → `openModal(id, movies, embeddedImages, imgDir, store)`

### .tc file format

Tellico collection files are ZIP archives containing `tellico.xml`. They may also be plain XML (the parser tries ZIP first, falls back to raw text). Images can be embedded in the XML as base64 or referenced as external files.

### Auto-load e config.json

All'avvio `tryAutoLoad` fa `fetch('config.json')` per leggere `tcFile` e `imgDir`. Se il file manca o è irraggiungibile, usa come fallback il nome derivato dall'URL della pagina + `.tc`. L'input manuale `#imgDir` nella loader UI sovrascrive `imgDir` da config (utile per drag-and-drop locale). `public/config.json` è la fonte di verità — viene copiato in `dist/` da Vite durante il build. Non modificare `dist/config.json` direttamente.

Solo HTTP/HTTPS: l'auto-load non funziona su `file://`.

### Key DOM IDs (all required in index.html)

`loader`, `header`, `dropZone`, `fileInput`, `imgDir`, `status`, `countLabel`, `reloadBtn`, `search`, `groupSelect`, `main`, `modal`, `modalContent`

### XSS safety

All user-sourced string data is passed through `escapeHtml` before any `innerHTML` assignment. Numeric fields (`id`, `year`, `running-time`) are interpolated directly without escaping.

## Deploy

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
