# CLAUDE.md

Guida per Claude Code in questo repo. Quattro parti: **sito** (Vite + TS, `src/`), **API** (.NET 10 + Postgres, `api/`), **app Android** (Kotlin/Compose, `android/`), **deploy** (`deploy/`, `.github/workflows/`). Design completo della collezione su DB e dello scanner Android: `docs/scanner-dvd.md`; contratto dell'API (autoritativo): `docs/api.md`.

Repo **pubblico**: niente host, IP, domini, email o segreti reali nei file; usa segnaposto (`<host-sito>`, `<host-auth>`…).

## Comandi

```bash
npm install            # prima volta; typecheck/lint falliscono senza node_modules
npm run dev            # http://localhost:5173 (inoltra /api → :5080)
npm run build          # → dist/
npm run typecheck      # tsc --noEmit (il sito non ha test)
npm run lint           # ESLint flat config
npm run a11y           # build + axe-core (WCAG 2.2 AA) su temi × stati → a11y-report/ (non gira in CI)

docker compose -f deploy/compose.dev.yml up db       # Postgres dev su 127.0.0.1:5432 (cinema/cinema)
cd api/CineManager.Api && dotnet run                # API su :5080, auth finta (Auth__DevUser in launchSettings)
cd api && CINEMA_TEST_CONNECTION="Host=localhost;Username=cinema;Password=cinema" dotnet test
```

- `npm run a11y -- --themes p5,sh2 --states arrivi --strict` (anche `--file x.tc`, `--screenshots`, `--url`). Serve Chromium di Playwright. I test d'integrazione dell'API creano e distruggono un DB `cm_test_<guid>` per classe.
- App Android: `cd android && ./gradlew assembleDebug testDebugUnitTest lint` (serve `ANDROID_HOME`; dettagli, firma e test end-to-end in `android/README.md`). Il modulo `core` è Kotlin puro (firma delle richieste, QR, client API) con test JVM; `app` è UI Compose + Keystore + CameraX/ML Kit.
- Prettier c'è ma **non** è imposto: il codice ha allineamenti manuali voluti, niente mass-reformat.
- Per la modalità DB in locale: API avviata + `public/config.json` con `"apiBase": "./api/"`.

## Sito: architettura

Vite + TypeScript strict, **lit-html con template funzionali** (`html\`...\`` + `render()`), niente LitElement né Shadow DOM: `style.css` globale vale ovunque.

**Due modalità**, scelte da `apiBase` in `config.json`:
- **`.tc`** (senza `apiBase`): il `.tc` di Tellico (zip con `tellico.xml`, o XML grezzo) è letto nel browser; visto/voti in localStorage con seed dal `.tc`. Sorgente: `tcFile` di `config.json`, oppure `?file=x.tc` (ha la precedenza), oppure nome della pagina + `.tc`.
- **DB**: collezione, campi e visto/voti per utente dall'API (`api.ts`/`api-store.ts`, nessun seed). Al primo accesso propone di migrare `cm_status`/`cm_rating` nel profilo (risposta salvata in `cm_migrated_db:<sub>`). Pannello ARRIVI per abbinare il telefono e gestire gli arrivi; schede admin ESPORTA CSV, CAMPI, IMPORTA DA TELLICO. Utente con `roles: []` → solo un messaggio.

`public/config.json` è la fonte (copiata in `dist/`): `tcFile`, `imgDir`, `title`, `bgmDir`, `apiBase`; esempio in `config.example.json`. Solo HTTP/HTTPS, non `file://`.

### Invarianti da rispettare

- **Template puri** in `src/templates/*.templates.ts`: importano solo `lit`, tipi, `utils.ts`, `copy.ts` e altri template (al più `import type` da `api.ts`). I moduli di vista calcolano dati e handler e chiamano `render(template(...), container)`.
- **Grafo dei moduli aciclico.** Due punti di disaccoppiamento: `renderer.ts` non importa `modal.ts` (`main.ts` passa `onOpenModal`); `random.ts` e `filter-popup.ts` non si importano a vicenda, condividono i blocchi di `filters.ts` (`buildPool`, `buildGrouperPanel`, `buildPanelShell`, `buildWatchRow`).
- **Stato di dominio solo in `main.ts`** (film, immagini, grouper, ricerca, filtri, vista, in modalità DB campi e `me`). Popup, ARRIVI e modal tengono solo stato UI in closure o DOM cache-ato a livello modulo, rilasciato da `reset*()` (Reload, nuova collezione). Le modifiche alla collezione da ARRIVI passano da `onCollectionChanged` di `main.ts`. Deroga voluta: `bgm.ts` (player UI-locale).
- **XSS**: tutto passa dai binding di lit (auto-escape). **Mai `unsafeHTML`.**
- Il parser garantisce un `id` numerico per ogni film (sintetico se manca): i consumatori non castano `Movie.id`.

### Moduli

| File | Ruolo |
|---|---|
| `main.ts` | Entry: stato, wiring DOM, scelta modalità, `handleFile`, `initUI`, `tryAutoLoad`, cambio tema |
| `parser.ts` | `.tc` XML → `Movie[]` + immagini embedded + `TellicoField[]` (flag multivalore/raggruppabile, `allowed`, date, tabelle); `toCollectionFields` |
| `tellico-file.ts` | Lettura del `.tc` (zip o XML), condivisa da `handleFile` e IMPORTA |
| `groupers.ts` | `Grouper[]` (più uno per campo personalizzato raggruppabile), `matchesSearch` |
| `renderer.ts` | Carosello in `#main` (filtri, ricerca, `allowedIds`); set delle immagini fallite |
| `modal.ts` | Scheda film ("dossier") con cut-in, stato visione e RANK 1–5; si riallinea se il PUT fallisce |
| `filters.ts`, `filter-popup.ts`, `random.ts` | Blocchi condivisi, popup FILTRI (muta `filterSelections` di main), picker RANDOM → All-Out Attack → biglietto |
| `stats.ts` | Vista INTEL |
| `store.ts` / `api-store.ts` | `StoreAdapter` su localStorage (seed, sync multi-scheda via `storage`) / su API (setter ottimistici + PUT, ripristino in errore, ricarica su `visibilitychange`) |
| `api.ts` | Client fetch same-origin, `redirect: 'manual'`, header `X-CM-Request: 1` sulle scritture, errori `problem+json` → `ApiError`; sessione scaduta: letture → `goToLogin()`, scritture → `SessionExpiredError` |
| `arrivals.ts` | Shell del pannello ARRIVI (tab + dialog); compone le sezioni `arrivals-phone` (QR di abbinamento, APK, dispositivi), `arrivals-list` (correggi/elimina), `arrivals-admin` (export CSV + mark, campi), `arrivals-import`; helper comuni in `arrivals-shared` |
| `db-ui.ts` | Dialog di conferma accessibili e avviso "sessione scaduta" |
| `copy.ts` | Testi di colore per tema (`currentCopy()`) |
| `themes.ts`, `toast.ts`, `transitions.ts`, `version-check.ts`, `bgm.ts` | Temi, toast, transizione a pagina, reload se il bundle è cambiato, musica di sottofondo |
| `utils.ts` | Helper puri senza import: `coverUrl`, `fieldValues`, `decadeKey`, `seededRandom`, `isTrueValue`, `focusablesIn`/`trapTab` |

### Filtri

Una card è visibile se passa **tutti**: selezioni FILTRI (OR dentro un grouper, AND tra grouper; `__none__` = campo vuoto), ricerca (titolo, regista, cast, genere; debounce 300 ms), filtro visione (`all`/`seen`/`unseen`). Le righe vuote spariscono; INTEL ignora ricerca e filtri.

### localStorage

`cm_status`, `cm_rating` (override per id; un `null` esplicito batte il seed; Reload non li cancella), `cm_theme`, `cm_bgm_vol`, `cm_bgm_track`, `cm_migrated_db:<sub>`. `setItem` è in try/catch: se fallisce la sessione continua in memoria.

### Temi

`p5` PHANTOM (default, nessun `data-theme`), `p3` MEMENTO, `p4` MAYONAKA, `sh2` TOLUCA. Ognuno ha un linguaggio visivo proprio, non solo una palette:
- Le regole base di `style.css` disegnano PHANTOM. Gli altri temi hanno una sezione "TEMA …" in fondo dove **ogni selettore inizia con `[data-theme="<id>"]`**, ognuna col proprio blocco `prefers-reduced-motion`. PHANTOM non dipende mai da quelle sezioni.
- Usa i token: `--on-hot` (testo su `--hot`, mai `--ink`), `--tilt` (ogni rotazione decorativa è `calc(Xdeg * var(--tilt))`), `--f-display`/`--f-head`/`--f-mono`, `--star`/`--burst`; quelli privati sono `--p3-*`, `--p4-*`, `--sh-*`.
- I testi per tema stanno in `copy.ts` (chiave in `ThemeCopy`), mai in CSS `content`. Sono testi originali, nessuna citazione dai giochi. I nomi funzionali dei controlli e i messaggi d'errore restano uguali in tutti i temi.
- Nuovo tema: aggiungi `{ id, label }` a `THEMES` e un blocco di token `[data-theme]` (`--hot`, `--hot-2`, `--hot-deep`, `--bg`, `--bg-2`, `--surface`, `--line`…).

### Accessibilità

- Card e item cliccabili: `role="button"`, `tabindex="0"` e Enter/Spazio.
- `aria-label` della card: tutto il testo visibile, titolo per primo.
- Dialog (scheda, All-Out Attack, ARRIVI, conferme): `aria-modal`, focus trap e ritorno del focus all'elemento di partenza.
- Titoli ransom: lettere `aria-hidden`, nome in `aria-label`.
- Testo piccolo con contrasto ≥ 4.5:1: `--ink-faint` è solo per le decorazioni.
- Verifica con `npm run a11y`.

### DOM statico richiesto in `index.html`

`loader`, `header`, `dropZone`, `fileInput`, `imgDir`, `status`, `countLabel`, `reloadBtn`, `search`, `groupSelect`, `main`, `modal`, `modalContent`. Il resto (masthead, toolbar, popup, `#arrivalsBtn`, overlay) è creato a runtime.

## API (`api/CineManager.Api`)

.NET 10 Minimal API, EF Core + Npgsql, migrazioni applicate all'avvio.
- **Cartelle:** `Auth/` (OIDC BFF + auth finta, auth dei dispositivi), `Data/` (entità, migrazioni), `Endpoints/`, `Import/` (Tellico), `Movies/` (arrivi, CSV, campi), `Lookup/` (EAN → UPCitemdb/TMDb), `Devices/`, `Infrastructure/`.
- **Dati:** `movies.data` è jsonb; per i film importati `movies.id` = id di Tellico, i film dall'app partono da 1.000.000.
- **Sito:** cookie `__Host-cm_session` via OIDC con Authelia (ruoli user/admin dai gruppi). L'auth finta `Auth__DevUser` funziona solo in Development.
- **App:** richieste firmate (JWT ES256 per dispositivo, chiave nel Keystore) dopo l'abbinamento con QR. Lo strumento `api/tools/sign-request` firma le richieste a mano per i test.
- **Password del DB:** fuori dalla connection string, da `Database__Password` o `POSTGRES_PASSWORD` (`Infrastructure/DbConnection.cs`).
- Se cambi un endpoint, aggiorna `docs/api.md` e il client in `src/api.ts`.

## CI e deploy

- **`ci.yml`** (PR e push non-`master`): job `check` (install, typecheck, lint, build) e job `api` (build + test con un servizio Postgres).
- **`android-ci.yml`** (modifiche ad `android/**`): build, test e lint dell'app.
- **`deploy.yml`** (push su `master`): builda e pubblica su GHCR prima `moviecarousel-api`, poi `moviecarousel` (nginx con `dist/` e, se ci sono i secret `ANDROID_*` della keystore, APK firmato + `version.json` in `/app/`).
- **Stack Komodo** (`deploy/compose.yml`, stack a sé; nessun `container_name`, i container prendono il nome dello stack), quattro servizi:
  - `web`: porta `PORT`. Serve il bundle; il resto viene dalla cartella dati del NAS (`WEB_ROOT`, montata ro su `/srv/data`). Inoltra `/api/` all'API e serve `/app/` (APK e `version.json`).
  - `api`: l'API .NET.
  - `db`: `postgres:17-alpine`.
  - `backup`: `pg_dump` notturno con rotazione (`deploy/backup.sh`).
- **Segreti:** via `env_file` da due sorgenti facoltative: l'Environment di Komodo (Secret `[[...]]`, scritto in `deploy/.env`, run directory `deploy`) e/o i file `db.env`/`api.env` in `SECRETS_DIR`. Mai nel compose né nel repo. Variabili, Caddy (forward auth Authelia tranne `/api/app/*`), certificato Data Protection, permessi e restore: `deploy/README.md`.
- **Cache:** `index.html` è `no-cache` (serve a `version-check.ts`), bundle e font hashati `immutable`. `assets/bgm/` ha `autoindex on`: `bgm.ts` scopre le tracce dal listing.
- Nessun runner self-hosted. Fallback manuale: `npm run build` e copia di `dist/` nella cartella dati.
