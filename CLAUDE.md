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
main.ts  →  parser.ts    (leaf — no imports)
         →  groupers.ts  →  parser.ts
         →  renderer.ts  →  parser.ts, groupers.ts, utils.ts
         →  modal.ts     →  parser.ts, utils.ts
         →  style.css

utils.ts (leaf — no imports)
```

`renderer.ts` does **not** import `modal.ts`. Instead, `main.ts` passes `openModal` as a callback (`OpenModalFn`) to `attachHandlers` — this breaks the only potential circular dependency.

All mutable application state lives exclusively in `main.ts` (movies, embeddedImages, imgDir, configuredImgDir, groupers, currentGrouper, searchTerm). No other module holds state.

### Module responsibilities

| File | Responsibility |
|---|---|
| `src/main.ts` | Entry point — state, DOM event wiring, `handleFile`, `initUI`, `tryAutoLoad` |
| `src/parser.ts` | Parses Tellico `.tc` XML → `Movie[]` + embedded images map |
| `src/groupers.ts` | Builds `Grouper[]` from movies; `matchesSearch` for filtering |
| `src/renderer.ts` | Generates row/card HTML, attaches carousel and card click handlers |
| `src/modal.ts` | Opens/closes the film detail overlay |
| `src/utils.ts` | `escapeHtml` and `coverUrl` — pure, imported by both renderer and modal |
| `src/style.css` | All CSS (CSS custom properties for theming via `:root`) |

### Data flow

1. User drops a `.tc` file (or it auto-loads via `tryAutoLoad`)
2. `handleFile` → JSZip extracts `tellico.xml` (falls back to raw XML if not zipped)
3. `parseTellicoXml` → `{ movies: Movie[], embeddedImages: Map<string, string> }`
4. `initUI` → `buildGroupers(movies)` → populates group selector buttons → `render()`
5. `render()` → `renderMain(grouper, searchTerm, embeddedImages, imgDir)` then `attachHandlers(..., openModal)`
6. Card click → `openModal(id, movies, embeddedImages, imgDir)`

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
