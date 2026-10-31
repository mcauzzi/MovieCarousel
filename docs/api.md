# API CineManager — contratto HTTP

Contratto degli endpoint implementati (fasi 1 e 3 di [`scanner-dvd.md`](scanner-dvd.md)). Codice in `api/CineManager.Api/`, test in `api/CineManager.Api.Tests/`.

## Convenzioni

- JSON in camelCase. Gli errori sono `application/problem+json` (`{ type, title, status, detail?, traceId }`).
- **Autenticazione sito**: cookie `__Host-cm_session` (HttpOnly, Secure, SameSite=Lax, durata assoluta 12 h) emesso dal login OIDC. Senza sessione valida → **401** (mai redirect HTML); ruolo mancante → **403**.
- **CSRF**: ogni richiesta non-GET verso `/api/*` (esclusi `/api/app/*` e la callback OIDC) deve avere `X-CM-Request: 1`, altrimenti **400**. Il controllo avviene prima dell'autenticazione.
- **Ruoli** (§4.3): `user` se `Oidc__UserGroup` è vuoto o tra i gruppi; `admin` se in più c'è `Oidc__AdminGroup`. Chi è solo nel gruppo admin non riceve ruoli.
- **Autenticazione app**: le richieste a `/api/app/*` (tranne `pair`) sono firmate dal telefono (`Authorization: CM-Device <jwt>`, vedi [Richieste firmate](#richieste-firmate-dellapp)); il cookie del sito lì non vale. Niente `X-CM-Request`.
- **Rate limit** (→ **429** con `Retry-After`; `/api/health` escluso), tutti sull'IP reale salvo dove indicato:
  - generale 300/min per IP (`RateLimit__PerMinute`);
  - `POST /api/app/pair` in più 10/min per IP (`RateLimit__PairPerIp`) e 30/min in totale (`RateLimit__PairGlobal`);
  - `GET /api/app/lookup` e `/api/app/search` in più 60/min per dispositivo (`RateLimit__LookupPerDevice`; chiave = `kid` del token).
- **Corpo massimo**: 1 MB; 256 KB per `/api/app/*` (oltre → **413**); 32 MB per i due endpoint di import.

## Endpoint

| Metodo | Percorso | Ruolo | Note |
|---|---|---|---|
| GET | `/api/health` | anonimo | `{ status: "ok", db: "ok" }`; **503** `{ status: "error", db: "error" }` se il DB non risponde |
| GET | `/api/auth/login?returnUrl=` | anonimo | 302 verso il provider OIDC (code + PKCE). `returnUrl` solo se percorso locale, altrimenti `/`. Con l'autenticazione di sviluppo: 302 diretto a `returnUrl`. Senza OIDC né utente di sviluppo: 503 |
| GET | `/api/auth/callback` | — | gestita dal middleware OIDC (`response_mode=query`) |
| POST | `/api/auth/logout` | anonimo | cancella il cookie → 204 (la sessione Authelia resta) |
| GET | `/api/me` | autenticato | `{ sub, name, roles }`, `roles` = `["user"]`, `["user","admin"]` (o `[]` se l'utente non ha ruoli) |
| GET | `/api/collection` | user | `{ movies, fields }` |
| GET | `/api/state` | user | `{ status: { "<id>": "seen"\|"watchlist" }, rating: { "<id>": 1..5 } }` dell'utente corrente |
| PUT | `/api/state/{movieId}` | user | corpo `{ "status": … }` e/o `{ "rating": … }` → 204 |
| POST | `/api/state/migrate` | user | `{ status: {id: s\|null}, rating: {id: r\|null} }` → `{ imported }` |
| POST | `/api/import/tellico/images` | admin | `{ images: { "<id immagine>": "<base64>" } }` → `{ written, skipped }` |
| POST | `/api/import/tellico` | admin | `{ fields, movies }` → riepilogo |
| POST | `/api/pairing` | user | nuovo codice di abbinamento → `{ code, expiresAt, qrSvg }` |
| GET | `/api/app-download-qr.svg` | user | `image/svg+xml`: QR di `PublicBaseUrl` + `/app/cinemanager.apk` |
| GET | `/api/devices` | user | propri dispositivi; `?all=true` (admin) quelli di tutti → `[Device]` |
| DELETE | `/api/devices/{id}` | user | revoca un proprio dispositivo (admin: qualsiasi) → 204, idempotente |
| DELETE | `/api/users/{sub}/devices` | admin | revoca tutti i dispositivi dell'utente → 204 |
| DELETE | `/api/users/{sub}/sessions` | admin | logout forzato dal sito (nuovo `security_stamp`) → 204; 404 se l'utente non esiste |
| GET | `/api/arrivals?scope=new\|app` | user | arrivi dall'app (utente: i propri; admin: tutti) → `[Arrival]` |
| PATCH | `/api/movies/{id}` | user | `{ movie: {…} }` correzione di un arrivo proprio (admin: qualsiasi) → `Arrival` |
| DELETE | `/api/movies/{id}` | user | elimina un arrivo proprio (admin: qualsiasi) → 204 |
| POST | `/api/export/csv` | admin | `{ scope: "new"\|"app"\|"all" }` → `text/csv` (§9) |
| POST | `/api/export/mark` | admin | `{ ids: [..] }` → `{ marked }` |
| GET | `/api/fields` | user | definizioni dei campi (come `fields` di `/api/collection`) |
| POST | `/api/fields` | admin | nuovo campo `local` → 201 `Field` |
| PATCH | `/api/fields/{name}` | admin | `title`, `groupable`, `groupMinSize`, `inForm`, `ordinal`, `allowed` → `Field` |
| DELETE | `/api/fields/{name}?purge=` | admin | elimina un campo `local` → 204 |
| POST | `/api/app/pair` | anonimo | abbinamento del telefono → `{ deviceId, user: { name } }` |
| GET | `/api/app/me` | dispositivo | `{ deviceId, deviceName, user: { name } }` |
| DELETE | `/api/app/me` | dispositivo | il dispositivo si revoca da solo ("Scollega") → 204 |
| GET | `/api/app/fields` | dispositivo | campi del modulo (`inForm`, esclusi `image`/`dependent` e il campo codice a barre `Tellico__BarcodeField`, che si invia in `ean`) → `[Field]` |
| GET | `/api/app/lookup?ean=` | dispositivo | ricerca da codice a barre (§7) |
| GET | `/api/app/search?q=&year=` | dispositivo | ricerca manuale su TMDb → `{ candidates }` |
| GET | `/api/app/tmdb/{tmdbId}` | dispositivo | bozza completa di un candidato |
| POST | `/api/app/movies` | dispositivo | inserisce un film → 201 `{ id }` / 409 |

### `GET /api/collection`

```json
{
  "movies": [ { "id": 1, "title": "Il padrino", "year": 1972, "director": ["…"], "cast": [{ "actor": "…", "role": "…" }], "cover": "abc.jpeg", "cdate": "2020-01-15" } ],
  "fields": [ { "name": "genre", "title": "Genere", "type": "line", "multiple": true, "allowed": null,
                "origin": "tellico", "groupable": true, "groupMinSize": 3, "inForm": true, "ordinal": 2 } ]
}
```

Ogni film è il contenuto di `movies.data` più `id` (id del DB: per gli importati è l'id Tellico, salvo collisioni). I campi sono ordinati per `ordinal`, poi `name`. `type` ∈ `line, para, number, bool, date, choice, url, rating, table, image, dependent`; `origin` ∈ `tellico, local`.

### `PUT /api/state/{movieId}`

Conta la **presenza** della chiave: `{"status":"seen"}` imposta lo stato senza toccare il voto, `{"status":null}` lo toglie; idem `rating` (intero 1–5 o `null`). Entrambe le chiavi nello stesso corpo sono ammesse. Quando stato e voto sono entrambi null la riga viene cancellata. 400 per corpo senza chiavi o valori non validi, 404 se il film non esiste.

### `POST /api/state/migrate`

Scrive ogni valore solo se l'utente non ne ha già uno **per quel campo** (stato e voto valutati separatamente). Ignora id inesistenti o non numerici, valori `null` e valori non validi. `imported` = numero di valori scritti (uno stato e un voto dello stesso film contano 2). Idempotente.

### `POST /api/import/tellico/images`

Nomi ammessi: `[A-Za-z0-9._-]{1,200}`, senza punto iniziale. Un nome non valido o un base64 non valido rifiuta **l'intero lotto** (400) prima di scrivere. Ogni file viene scritto in `Covers__Path` solo se non esiste (`skipped` altrimenti), con file temporaneo + rename. Fuori dalla transazione dei film.

### `POST /api/import/tellico`

```json
{ "fields": [ { "name": "genre", "title": "Genere", "type": "1", "flags": 7, "multiple": true, "groupable": true, "allowed": null } ],
  "movies": [ { "id": 12, "title": "…", "cdate": "2024-01-15", "ean": "8012345678901" } ] }
```

Risposta: `{ inserted, updated, linked, unchanged, missing: [{ id, title }], fieldsUpdated }`.

- `type` è il codice Tellico (stringa; accettato anche numero): 1 line, 2 para, 3 choice, 4 bool, 6 number, 7 url, 8 table, 10 image, 12 date, 14 rating; 11 o flag `0x20` → dependent; altri → line. `multiple`/`groupable` se assenti si ricavano dai bit `0x01`/`0x02` di `flags`.
- Abbinamento di ogni entry (§8): EAN (campo `Tellico__BarcodeField`, normalizzato) → `tellico_id` (scartato se entrambe le `cdate` ci sono e differiscono: id riusato) → titolo + anno normalizzati tra gli arrivi `source = app` non collegati → nuovo film (id = id Tellico se libero, altrimenti sequenza da 1 000 000). Un `tellico_id` già assegnato a un altro film viene prima azzerato.
- Aggiornamento: `data` sostituito da quello del `.tc` (senza `id`), tranne `cover` se l'entry non ne ha; valori dei campi `local` assenti dal `.tc` conservati; `ean` aggiornato solo se presente; `source` → `tellico`.
- `linked` = film collegati a un id Tellico diverso da prima; `updated` = già collegati e modificati; `unchanged` = nulla di diverso.
- `missing` = film `source = tellico` non presenti nel `.tc` (compresi quelli scollegati da un id riusato o in conflitto); non vengono cancellati.
- `collection_fields`: titolo, tipo, `multiple`, `allowed` e `origin = tellico` aggiornati; `groupable`, `group_min_size`, `in_form`, `ordinal` impostati solo alla creazione (`group_min_size`: genre 3, director 3, nationality 4, language 5, studio 5, altri 3; `in_form` falso per image, dependent, flag "non modificabile" `0x10`, `cdate`/`mdate`). I campi `tellico` assenti dal `.tc` vengono rimossi; il campo `id` è ignorato. `fieldsUpdated` = campi creati, modificati o rimossi.
- Tutto in una transazione (gli import sono serializzati con un advisory lock). 400 per id mancanti, non interi o duplicati.

### Abbinamento del telefono (§4.2)

1. **`POST /api/pairing`** (sito, ruolo user, con `X-CM-Request: 1`) →
   ```json
   { "code": "jpg6Ja2nt9yODJ4ib-PhfA", "expiresAt": "2026-10-31T10:25:31Z", "qrSvg": "<svg …>" }
   ```
   `code` = 128 bit casuali in base64url, monouso, valido 5 minuti; nel DB c'è solo lo SHA-256 (il QR si ottiene solo qui). `qrSvg` è il QR (QRCoder, SVG con `viewBox`) del JSON `{"v":1,"api":"<PublicBaseUrl>/api","code":"<code>"}`. Senza `PublicBaseUrl` → 503 (in Development si usa l'origine della richiesta). A ogni chiamata si cancellano i codici scaduti o usati.
2. **`POST /api/app/pair`** (anonimo, senza CSRF):
   ```json
   { "code": "…", "deviceName": "Pixel 8", "publicKey": "<SPKI DER in base64>", "proof": "<ES256 R||S base64url di \"pair:\"+code>" }
   ```
   Solo chiavi EC **P-256**. `deviceName` 1–100 caratteri senza caratteri di controllo. Esito → `{ "deviceId": "<uuid>", "user": { "name": "…" } }`. Errori **400** problem con `reason`: `invalid_request` (campi mancanti/nome non valido), `invalid_key`, `invalid_proof` (il codice non viene consumato), `invalid_code` (sbagliato, scaduto o già usato). Il codice è consumato in modo atomico.

### Richieste firmate dell'app

```
Authorization: CM-Device <header>.<payload>.<firma>      (JWT compatto, base64url senza padding)

header : { "alg": "ES256", "typ": "cm-req+jwt", "kid": "<deviceId>" }
payload: { "iat": 1793430000, "exp": 1793430060, "jti": "<16–128 caratteri casuali>",
           "htm": "POST", "htu": "/api/app/movies?x=1", "bh": "<base64url SHA-256 del corpo>", "av": 10300 }
firma  : ES256 su "<header>.<payload>", formato R||S (64 byte)
```

- `htu` = percorso + query esattamente come arrivano all'API (request-target); `htm` il metodo in maiuscolo.
- `bh` obbligatorio se il corpo non è vuoto (hash dei byte inviati); `av` = `versionCode` dell'app (intero).
- Controlli, in quest'ordine: dispositivo esistente e non revocato → firma (algoritmo fisso `ES256`: `none`, `HS256`, `ES384`… rifiutati; nessun header `crit`) → `exp > iat`, `exp - iat ≤ 60`, `iat ≤ now + 30 s`, `exp ≥ now - 30 s` → `htm`, `htu`, `bh` → `jti` mai visto per quel dispositivo (cache in memoria di 2 minuti) → proprietario autorizzato → `av ≥ minSupportedCode` → aggiornamento di `last_seen_at`.
- Esiti (problem+json con `reason`):
  - **401** (`WWW-Authenticate: CM-Device`): `missing_token`, `invalid_token`, `unsupported_alg`, `device_revoked` (anche dispositivo sconosciuto), `bad_signature`, `bad_lifetime`, `expired`, `htm_mismatch`, `htu_mismatch`, `bh_missing`, `bh_mismatch`, `replay`. L'app torna alla schermata di abbinamento solo per `device_revoked`; per gli altri il problema è nella richiesta (es. orologio).
  - **403** `owner_inactive`: il proprietario non ha fatto login sul sito negli ultimi `Devices__MaxOwnerInactiveDays` giorni (default 90) oppure, con `Oidc__UserGroup` impostato, al suo ultimo login non aveva quel gruppo.
  - **426** `upgrade_required` con `minSupportedCode`: `av` sotto il `minSupportedCode` di `App__VersionUrl` (cache 5 minuti; se il file non è raggiungibile il controllo viene saltato e registrato nei log, riprovando dopo un minuto; senza `App__VersionUrl` nessun controllo).
  - **413** `body_too_large`: corpo oltre 256 KB.

### `GET /api/app/lookup?ean=`

`ean` normalizzato (solo cifre; UPC-A a 12 cifre → zero davanti), 8–14 cifre, altrimenti 400.

```json
{ "ean": "8012345678901", "productName": "Il Padrino (DVD) [Edizione Speciale]",
  "tmdbId": 238, "posterPath": "/abc.jpg", "posterUrl": "https://image.tmdb.org/t/p/w500/abc.jpg",
  "draft": { "title": "Il padrino", "year": 1972, "director": ["Francis Ford Coppola"], "cast": [{ "actor": "…", "role": "…" }] },
  "candidates": [ { "tmdbId": 238, "title": "Il padrino", "originalTitle": "The Godfather", "year": 1972,
                    "posterPath": "/abc.jpg", "posterUrl": "https://image.tmdb.org/t/p/w185/abc.jpg" } ],
  "possibleDuplicates": [ { "id": 12, "title": "Il padrino", "year": 1972 } ],
  "tmdbAvailable": true }
```

- Nome prodotto dalla catena `Lookup__Providers` (default `upcitemdb`: endpoint di prova gratuito, o quello a pagamento con `Lookup__UpcItemDbKey`); il primo che trova vince. Cache in `ean_lookup_cache`: 30 giorni per i trovati, 24 ore per i "non trovato"; gli errori dei provider (rete, quota) non vanno in cache.
- Titolo ripulito da formato e confezione (DVD, Blu-ray, 4K, Steelbook, Edizione…, parentesi); l'anno, se c'è, filtra la ricerca TMDb (`language=it-IT`, `region=IT`; se con l'anno non trova nulla riprova senza). Fino a 5 `candidates`; la `draft` e `tmdbId`/`posterPath` vengono dal primo (`movie/{id}?append_to_response=credits`).
- `draft` ha la forma dei film del parser ed è limitata ai campi scrivibili della collezione: titolo, anno, durata, trama, generi (italiano), registi, cast (primi 10 con ruolo), nazionalità (`USA`, `UK`… come `src/parser.ts`), lingue (nomi italiani), `original-title` se il campo esiste. Si può reinviare così com'è in `POST /api/app/movies`.
- EAN sconosciuto: `productName` null, `draft` `{}`, `candidates` `[]`. TMDb non configurato o non raggiungibile: `tmdbAvailable: false` e `draft` solo dal nome prodotto.
- `possibleDuplicates`: film con lo stesso EAN, lo stesso `tmdb_id` o titolo + anno normalizzati uguali alla bozza (massimo 20).

### `GET /api/app/search?q=&year=` e `GET /api/app/tmdb/{tmdbId}`

- `search` → `{ "candidates": [ …come sopra… ] }`; `q` 1–200 caratteri, `year` facoltativo (1870–2200).
- `tmdb/{id}` → `{ tmdbId, posterPath, posterUrl, draft, possibleDuplicates }`; 404 se TMDb non conosce l'id.
- `Tmdb__ApiToken` vuoto → **503** problem "TMDb non configurato"; TMDb in errore → **502**.

### `POST /api/app/movies`

```json
{ "ean": "8012345678901", "tmdbId": 238, "posterPath": "/abc123.jpg",
  "movie": { "title": "Il padrino", "year": 1972, "director": ["Francis Ford Coppola"], "medium": "DVD", "edizione": "Steelbook" },
  "confirmDuplicate": false }
```

- Solo queste proprietà; tutte facoltative tranne `movie` (con `title`).
- **201** `{ "id": 1000000 }` (header `Location: /api/movies/{id}`). Id dalla sequenza `movies_app_id_seq` (da 1 000 000), `source = app`, `created_by` = proprietario del dispositivo, `created_by_device`, `tmdb_id`, `ean` normalizzato (anche in `data.<Tellico__BarcodeField>`), `data.cdate` = oggi (`AAAA-MM-GG`).
- **409** `{ "reason": "ean", "existingId": 12, "title": "…" }` se l'EAN esiste già (anche con `confirmDuplicate`).
- **409** `{ "reason": "possible_duplicate", "candidates": [{ id, title, year }] }` se c'è un film con lo stesso `tmdb_id` o titolo + anno normalizzati, a meno di `"confirmDuplicate": true`. I due 409 sono JSON semplice, non problem.
- **400** validation problem (`errors: { "<campo>": ["…"] }`) — validazione contro `collection_fields` (prima di ogni import: campi standard di Tellico + campi `local`):
  - campi sconosciuti rifiutati; non scrivibili `id`, `cdate`, `mdate`, `cover`, i campi `image` e `dependent`; il codice a barre si invia solo in `ean`;
  - `line` ≤ 500 caratteri senza caratteri di controllo, `para` ≤ 20 000, `number` intero (`year` 1870…anno corrente + 5, `running-time` 1–2000), `rating` 1–10, `bool` → `"true"` (false = assente), `date` `AAAA-MM-GG`, `url` http(s) assoluto, `choice` tra gli `allowed` (senza distinzione di maiuscole, salvato nella forma ammessa), `table` come righe di celle (`cast`: `[{ actor, role }]`);
  - campi multipli: valore singolo o elenco (max 100, duplicati tolti); un campo singolo non accetta elenchi; valori vuoti ignorati.
- Copertina: `posterPath` deve rispettare `^/[A-Za-z0-9_-]+\.(jpg|jpeg|png)$` (altrimenti 400). L'API scarica `https://image.tmdb.org/t/p/w500<posterPath>` senza redirect automatici, accetta solo risposta 200 con content-type `image/jpeg`/`image/png`, contenuto coerente e ≤ 5 MB, e la salva come `cm-<id>.jpg|png` in `Covers__Path` (file temporaneo + rename); `data.cover` = nome del file. Se il download fallisce il film resta salvato senza copertina (avviso nei log).

### Dispositivi

`Device` = `{ id, name, userSub, userName, createdAt, lastSeenAt, revokedAt }` (`id` uuid; elenco dal più recente; i revocati restano visibili). `GET /api/devices?all=true` da un non admin → 403. `DELETE /api/devices/{id}`: 404 se non esiste, 403 se è di un altro utente e non si è admin.

### Arrivi

`Arrival` = `{ id, ean, tmdbId, source, createdAt, createdBy, createdByName, exportedAt, movie }` con `movie` = `data` + `id`.

- `GET /api/arrivals?scope=new` (default): film `source = app` mai esportati; `scope=app`: tutti i `source = app` (cioè non ancora collegati a Tellico). Ordinati dal più recente. Altri scope → 400.
- `PATCH /api/movies/{id}` `{ "movie": { … } }`: solo i campi da cambiare, con la stessa validazione di `POST /api/app/movies`; `null` o `""` svuota un campo singolo, `[]` uno multiplo; il titolo non può restare vuoto. Qui il campo codice a barre (`Tellico__BarcodeField`) è ammesso e aggiorna anche `ean` (409 `{ reason: "ean", existingId, title }` se già usato). → `Arrival` aggiornato.
- `DELETE /api/movies/{id}` → 204: cancella il film, lo stato visto/voto collegato e i file `cm-<id>.*`.
- Per entrambi: 404 film inesistente, 403 arrivo di un altro utente (non admin), 409 film non `source = app` (anche per l'admin).

### ESPORTA CSV

`POST /api/export/csv` `{ "scope": "new" }` (default `new`; `app`, `all`) → `200 text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="cinemanager-<scope>-AAAAMMGG-HHMM.csv"`, `X-CM-Movie-Ids: 1000000,1000001` (esposto con `Access-Control-Expose-Headers`; per `all` contiene solo gli arrivi dall'app, gli unici per cui `mark` ha senso).

- Colonne: i campi di `collection_fields` in ordine (`ordinal`, nome) con il loro **titolo** come intestazione (prima di ogni import: i titoli inglesi di Tellico), esclusi `image`, `dependent`, `id`, `cdate`, `mdate`; in coda la colonna del codice a barre (`Tellico__BarcodeField`, titolo `EAN` se il campo non esiste), riempita da `movies.ean`.
- Valori: multipli separati da `; `, tabelle come `a::b; c::d` (cast `Attore::Ruolo`), bool `true`/vuoto, date `AAAA-MM-GG`. UTF-8 senza BOM, separatore `,`, righe CRLF, quoting RFC 4180; nessun escape anti formula injection.
- Nessun effetto collaterale: dopo aver ricevuto il file il sito chiama `POST /api/export/mark` `{ "ids": [..] }` → `{ "marked": n }` (imposta `exported_at`; id inesistenti ignorati, duplicati contati una volta).

### Campi (`/api/fields`)

- `POST` `{ name, title, type, multiple?, allowed?, groupable?, groupMinSize?, inForm?, ordinal? }`: `name` `^[a-z][a-z0-9-]{0,40}$`, non riservato (`id`, `cdate`, `mdate`, `cover`); `type` tra `line, para, number, bool, date, choice, url, rating, table`; `allowed` solo per `choice` (max 200 valori); default `inForm: true`, `groupMinSize: 3`, `ordinal` in coda. Proprietà sconosciute → 400; nome già usato → 409.
- `PATCH` solo `title`, `groupable`, `groupMinSize` (1–1000), `inForm`, `ordinal` (0–100000), `allowed`; vale anche per i campi `tellico` (le preferenze del sito non vengono sovrascritte dall'import; titolo e `allowed` sì).
- `DELETE /api/fields/{name}`: solo campi `local` (i `tellico` → 409); i valori restano in `movies.data`, con `?purge=true` vengono rimossi da tutti i film.

## Avvio in locale

Postgres: `docker compose -f deploy/compose.dev.yml up -d db` (oppure un Postgres locale con ruolo `cinema`/`cinema` e permesso `CREATEDB`).

```bash
cd api/CineManager.Api
dotnet run            # profilo "http": http://localhost:5080, Development, Auth__DevUser=dev, Auth__DevRoles=user,admin
```

Le migrazioni si applicano all'avvio. Il proxy di Vite (`npm run dev`) inoltra `/api` a `http://localhost:5080`.

| Variabile | Sviluppo | Note |
|---|---|---|
| `ASPNETCORE_ENVIRONMENT` | `Development` | |
| `Auth__DevUser`, `Auth__DevRoles` | `dev`, `user,admin` (in `launchSettings.json`) | autenticazione finta; fuori da Development l'API rifiuta di partire. Lasciando vuoto `Auth__DevUser` si usa OIDC (se configurato) |
| `ConnectionStrings__Cinema` | `Host=localhost;Port=5432;Database=cinema;Username=cinema;Password=cinema` | `appsettings.Development.json` |
| `Covers__Path` | `../../assets/covers` (relativo a `api/CineManager.Api`, cioè `assets/covers/` del repo servito da Vite) | |
| `ASPNETCORE_URLS` | `http://localhost:5080` | già nel profilo |

Produzione (obbligatorie, §12): `ConnectionStrings__Cinema`, `PublicBaseUrl`, `Oidc__Authority`, `Oidc__ClientId`, `Oidc__ClientSecret`, `DataProtection__CertificateBase64` (+ `__CertificatePassword`), `Covers__Path`. Facoltative: `Oidc__UserGroup`, `Oidc__AdminGroup`, `Oidc__RequireHttpsMetadata` (default `true`), `Proxy__KnownNetworks`, `Proxy__KnownProxies` (separati da virgola), `Tellico__BarcodeField` (default `ean`), `RateLimit__PerMinute`.

Fase 3 (facoltative):

| Variabile | Default | Note |
|---|---|---|
| `Tmdb__ApiToken` | vuoto | token "API Read Access" (v4, bearer) di TMDb; vuoto ⇒ `search`/`tmdb` 503 e `lookup` senza TMDb |
| `Lookup__Providers` | `upcitemdb` | catena dei provider EAN, separati da virgola (nomi sconosciuti ignorati con un avviso) |
| `Lookup__UpcItemDbKey` | vuoto | chiave UPCitemdb a pagamento; senza si usa l'endpoint di prova (quota giornaliera per IP) |
| `App__VersionUrl` | vuoto | `version.json` dell'app per il controllo 426 (nello stack `http://web/app/version.json`); vuoto ⇒ nessun controllo |
| `Devices__MaxOwnerInactiveDays` | `90` | giorni dall'ultimo login sul sito oltre i quali i telefoni del proprietario ricevono 403 |
| `RateLimit__PairPerIp`, `RateLimit__PairGlobal`, `RateLimit__LookupPerDevice` | `10`, `30`, `60` | al minuto |

`PublicBaseUrl` serve anche per i QR (abbinamento e download dell'APK); in Development, se manca, si usa l'origine della richiesta.

## Strumento di prova `sign-request`

Console .NET in `api/tools/sign-request/` (nella solution) che fa da telefono: genera una chiave P-256, si abbina e invia richieste firmate come l'app. Il file della chiave contiene la chiave privata in chiaro: solo per sviluppo.

```bash
cd api
SR="dotnet run --project tools/sign-request --"

# 1. codice di abbinamento dal sito (in Development con l'utente finto)
curl -s -X POST -H 'X-CM-Request: 1' http://localhost:5080/api/pairing    # → { code, expiresAt, qrSvg }

# 2. chiave e abbinamento (--qr con il JSON del QR, oppure --api e --code)
$SR keygen --key /tmp/dev.json
$SR pair --key /tmp/dev.json --api http://localhost:5080/api --code <code> --name "Telefono di prova"

# 3. richieste firmate (stampa stato e corpo)
$SR send --key /tmp/dev.json GET /api/app/me
$SR send --key /tmp/dev.json GET "/api/app/lookup?ean=8012345678901"
$SR send --key /tmp/dev.json POST /api/app/movies --json '{"movie":{"title":"Il padrino","year":1972}}'
$SR send --key /tmp/dev.json --av 9999 GET /api/app/me      # versionCode diverso (426 se sotto il minimo)

# solo l'header, per curl (vale una volta: jti monouso)
curl -H "Authorization: $($SR token --key /tmp/dev.json GET /api/app/me)" http://localhost:5080/api/app/me
```

`pair` salva `deviceId` e indirizzo dell'API nel file della chiave; `PERCORSO` è relativo all'origine dell'API e finisce firmato in `htu`.

Certificato Data Protection di esempio:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=cinemanager-dp" -keyout dp.key -out dp.crt
openssl pkcs12 -export -inkey dp.key -in dp.crt -out dp.pfx -passout pass:<password>
base64 -w0 dp.pfx      # → DataProtection__CertificateBase64
```

## Test

```bash
cd api
CINEMA_TEST_CONNECTION="Host=localhost;Username=cinema;Password=cinema" dotnet test
```

Senza `CINEMA_TEST_CONNECTION` girano solo i test unitari; quelli d'integrazione vengono saltati. Ogni classe di test crea e distrugge un proprio database `cm_test_<guid>`.

I test della fase 3 non usano la rete: TMDb, copertine, `version.json` e provider EAN sono finti (`Support/AppFactory.cs`); `Support/TestDevice.cs` genera la chiave P-256 e firma le richieste come l'app.
