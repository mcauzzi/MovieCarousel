# API CineManager — contratto HTTP

Contratto degli endpoint implementati (fase 1 di [`scanner-dvd.md`](scanner-dvd.md)). Codice in `api/CineManager.Api/`, test in `api/CineManager.Api.Tests/`.

## Convenzioni

- JSON in camelCase. Gli errori sono `application/problem+json` (`{ type, title, status, detail?, traceId }`).
- **Autenticazione sito**: cookie `__Host-cm_session` (HttpOnly, Secure, SameSite=Lax, durata assoluta 12 h) emesso dal login OIDC. Senza sessione valida → **401** (mai redirect HTML); ruolo mancante → **403**.
- **CSRF**: ogni richiesta non-GET verso `/api/*` (esclusi `/api/app/*` e la callback OIDC) deve avere `X-CM-Request: 1`, altrimenti **400**. Il controllo avviene prima dell'autenticazione.
- **Ruoli** (§4.3): `user` se `Oidc__UserGroup` è vuoto o tra i gruppi; `admin` se in più c'è `Oidc__AdminGroup`. Chi è solo nel gruppo admin non riceve ruoli.
- **Rate limit**: 300 richieste/minuto per IP reale (`RateLimit__PerMinute`) → **429** con `Retry-After`. `/api/health` è escluso.
- **Corpo massimo**: 1 MB, 32 MB per i due endpoint di import.

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
