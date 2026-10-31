# Design: collezione su database e scanner DVD da Android

> Stato: **proposta**, nessuna implementazione ancora. Vive sul ramo `feature/scanner-dvd`, di cui costituisce i primi commit; le fasi di lavoro sono in fondo (§14).
>
> Il repository è pubblico: qui compaiono solo nomi di variabili e segnaposto (`<host-sito>`, `<host-auth>`), mai host reali, indirizzi IP, segreti o chiavi. I valori veri vivono solo nello stack Komodo (Environment e Secret, o file env sul NAS) e nella configurazione di Authelia/Caddy.

## 1. Obiettivo

1. Aggiungere film alla collezione **scansionando il codice a barre di un DVD/Blu-ray** con un'app Android: l'app legge l'EAN, il server propone i dati del film, l'utente li corregge e conferma.
2. Il sito smette di leggere il file `.tc` all'avvio e **carica tutto da un database**: film, stato visto/watchlist e voti (per utente).
3. Tellico resta lo strumento di catalogazione sul PC, collegato in due direzioni:
   - **IMPORTA DA TELLICO** (dal sito): carica un `.tc` e fa un *upsert* nel DB;
   - **ESPORTA CSV** (dal sito): i film arrivati dall'app escono in un CSV importabile in Tellico.

Il sito e l'app usano **solo** il database; il `.tc` è un formato di scambio, non più la sorgente a runtime.

### Fuori ambito (per ora)

- Modifica completa delle schede film dal sito (solo correzione/eliminazione degli arrivi).
- Sincronizzazione automatica con Tellico (niente lettura/scrittura diretta del `.tc` sul NAS).
- Pubblicazione dell'app sul Play Store (APK installato a mano).

## 2. Situazione attuale e cosa cambia

| Oggi | Dopo |
|---|---|
| App solo browser, nessun backend | Web API .NET + Postgres |
| `tryAutoLoad` scarica `config.json` → `.tc` → parser nel browser | il sito chiama `GET /api/collection` |
| Visto/voto in `localStorage`, per browser, con seed dai campi del `.tc` | Visto/voto nel DB, per utente, **senza seed dal `.tc`** (§5); le scelte manuali in localStorage vengono migrate una volta |
| Container nginx `read_only`, dati NAS montati `:ro` | invariato per nginx (servizio rinominato `web` nello stack); solo l'API scrive (copertine) |
| Accesso protetto dal forward auth di Authelia in Caddy | forward auth invariato sul sito + **OIDC** verso l'API; l'app usa **chiavi nel Keystore** |

La modalità `.tc` attuale resta come **fallback** (sviluppo locale, deploy senza API): vedi §10.

## 3. Architettura

```
                     Caddy (reverse proxy)
                      │
     ┌────────────────┴───────────────────────────────┐
     │ /api/app/*  → nessun forward auth               │ tutto il resto → forward auth Authelia
     ▼                                                  ▼
┌───────────────────────── stack Komodo del sito ────────────────────────────────┐
│                                                                                 │
│   web (nginx, porta pubblicata ${PORT})                                         │
│     ├─ /            bundle dell'immagine + dati NAS (:ro), come oggi            │
│     ├─ /app/        APK + version.json inclusi nell'immagine (§11.1)            │
│     └─ /api/        proxy → api:8080 (tranne /api/app/version, statico)         │
│                                                                                 │
│   api (.NET 10, nessuna porta pubblicata)                                       │
│     ├─ sessione sito: OIDC con Authelia → cookie HttpOnly                       │
│     ├─ app Android: richieste firmate con chiave del dispositivo                │
│     ├─ ricerca EAN → titolo → TMDb (chiavi solo lato server)                    │
│     └─ scrive le copertine in WEB_ROOT/COVERS_DIR (unico mount in scrittura)    │
│                                                                                 │
│   db (Postgres 17, nessuna porta pubblicata, volume sul NAS)                    │
│   backup (pg_dump notturno con rotazione)                                       │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
          ▲                                       ▲
     browser (sito)                         app Android
```

**Stack completamente separato** dagli altri stack del NAS: rete Docker privata dello stack, Postgres dedicato, nessuna dipendenza da altri servizi. L'unico legame esterno è Authelia, usato via HTTPS come provider OIDC (come un qualsiasi client).

### Struttura del repository

```
src/                    sito (Vite + lit), come oggi
api/
  CineManager.Api/      Web API (Minimal API, EF Core, Npgsql)
  CineManager.Api.Tests/ test xUnit (upsert, CSV, verifica firme)
  Dockerfile
android/                app Kotlin (fase 5), nello stesso repo: contratto e codice evolvono insieme
deploy/
  compose.yml           web + api + db + backup
  compose.dev.yml       solo Postgres per lo sviluppo locale (§10.2)
  backup.sh             pg_dump notturno con rotazione
  nginx.conf            + location /api/, /api/app/version, /app/
docs/
  scanner-dvd.md        questo documento
  api.md                contratto HTTP (generato/aggiornato con l'implementazione)
```

## 4. Autenticazione e autorizzazione

Due canali distinti, nessuno dei due si fida di header o della rete.

### 4.1 Sito: OIDC con Authelia (backend-for-frontend)

L'API è un client OIDC **confidenziale** di Authelia; il browser non tocca mai token.

```
browser → GET /api/me                         → 401 (nessuna sessione)
browser → GET /api/auth/login?returnUrl=/     → 302 verso <host-auth> (authorization code + PKCE)
Authelia (sessione attiva, consenso implicito → nessun prompt) → 302 /api/auth/callback?code=…
api     → scambia il code, verifica l'id_token firmato da Authelia (JWKS)
api     → Set-Cookie: __Host-cm_session (HttpOnly, Secure, SameSite=Lax) → 302 returnUrl
browser → /api/... con il cookie
```

- Implementazione: `AddAuthentication().AddCookie().AddOpenIdConnect()` di ASP.NET Core, nessuna libreria esterna.
- Identità dell'utente: claim `sub` (chiave stabile nel DB) + `preferred_username`/`name` per la visualizzazione.
- Gruppi e ruoli: vedi §4.3. I gruppi arrivano dal claim `groups` (letto da userinfo e mappato esplicitamente con `ClaimActions.MapJsonKey("groups", "groups")`, altrimenti non finisce nel cookie); l'API non gestisce utenti né gruppi propri.
- **Autenticazione del client verso Authelia**: `client_secret_post`. L'handler OIDC di ASP.NET Core invia il segreto nel corpo della richiesta al token endpoint; Authelia applica il metodo configurato per il client, quindi l'esempio sotto usa quello (da verificare su .NET 10 se è disponibile anche `client_secret_basic`).
- **`returnUrl`** accettato solo se è un percorso locale (`Url.IsLocalUrl`: inizia con `/`, non con `//` o `/\`); altrimenti si usa `/`. Evita l'open redirect.
- **Callback come GET**: `ResponseMode = query` (il default di ASP.NET è `form_post`, che il controllo CSRF bloccherebbe) e **PAR disattivato** (in .NET 9+ è attivo di default se il provider lo espone), così il flusso è esattamente quello configurato in Authelia. Un errore nel login risponde 401 problem invece di un nuovo redirect, per evitare cicli.
- **`redirect_uri`** costruito da `PublicBaseUrl` (configurazione), non dagli header della richiesta: un solo meccanismo, che non dipende da cosa inoltra il proxy.
- **Durata della sessione**: cookie con durata **assoluta** di 12 ore (non scorrevole: con una scadenza che si rinnova a ogni richiesta un utente attivo non rifarebbe mai il login e i gruppi non verrebbero mai riletti); alla scadenza il frontend rifà il giro su Authelia, che con la sessione attiva risponde senza chiedere nulla. Così i gruppi vengono riletti almeno ogni 12 ore (§4.3). Gestione lato frontend in §10 (`api.ts`): una lettura che riceve 401 naviga al login; una **scrittura** che riceve 401 annulla la modifica ottimistica e mostra un toast "Sessione scaduta — ACCEDI", senza navigare via perdendo il contesto.
- **Chiavi Data Protection** (cifrano e firmano il cookie) salvate nel DB (`PersistKeysToDbContext`), così un riavvio del container non scollega tutti, ma **cifrate** con un certificato (`ProtectKeysWithCertificate`) che non sta nel DB: PFX passato come secret dell'environment (`DataProtection__CertificateBase64` + password). Senza questa cifratura chiunque abbia un dump del DB o un file di backup potrebbe forgiare un cookie valido per qualsiasi utente, amministratore compreso. Perdere il certificato non perde dati: invalida solo le sessioni attive (tutti rifanno il login). Va conservato insieme agli altri secret.
- **Sessioni revocabili**: il cookie contiene il `security_stamp` dell'utente (§5, `users`); `OnValidatePrincipal` lo confronta con il DB (con cache di 1 minuto) e, se diverso, rifiuta la sessione. `DELETE /api/users/{sub}/sessions` (§6.2) rigenera il timbro.
- **CSRF**: cookie `SameSite=Lax` + tutte le chiamate che modificano dati richiedono l'header `X-CM-Request: 1` (header personalizzato ⇒ preflight CORS ⇒ un sito terzo non può inviarlo). Nessun CORS abilitato: sito e API sono sullo stesso origin.
- Logout: `POST /api/auth/logout` cancella il cookie locale (la sessione Authelia resta, come per qualsiasi client OIDC).
- **IP del client** (`ForwardedHeaders`, solo `X-Forwarded-For`): la catena è Caddy → nginx (`web`) → api. L'API considera fidati il container `web` (subnet della rete Docker, **fissata** nel compose perché quella di default è dinamica) e l'IP di Caddy (`Proxy__KnownProxies`), con `ForwardLimit = 2`; così vede l'IP reale e il rate limit (§6) non mette tutti nello stesso secchio. nginx imposta `X-Forwarded-For` con `$proxy_add_x_forwarded_for`. Non è un meccanismo di autenticazione: serve solo al rate limit e ai log.

Il forward auth di Caddy resta davanti al sito statico e alle `/api/*` del sito: è un primo filtro, ma l'API **non** ne dipende. Una richiesta che arriva direttamente alla porta pubblicata dalla LAN, senza passare da Caddy, non ha cookie valido ⇒ 401.

**Configurazione Authelia** (a cura dell'operatore, fuori dal repo; nomi di policy e gruppi sono segnaposto):

```yaml
identity_providers:
  oidc:
    authorization_policies:
      <policy>:
        default_policy: deny
        rules:
          - policy: two_factor
            subject: 'group:<gruppo-utenti>'
    clients:
      - client_id: <client-id>
        client_name: CineManager
        client_secret: '<hash del segreto>'
        authorization_policy: <policy>
        consent_mode: implicit          # nessuna schermata di consenso (da verificare sulla versione in uso)
        require_pkce: true
        pkce_challenge_method: S256
        redirect_uris:
          - https://<host-sito>/api/auth/callback
        scopes: [openid, profile, groups]
        response_types: [code]
        grant_types: [authorization_code]
        token_endpoint_auth_method: client_secret_post
```

### 4.2 App Android: chiave privata nel Keystore

Nessun segreto condiviso: ogni dispositivo ha una coppia di chiavi **EC P-256** generata nell'**Android Keystore** (non esportabile; StrongBox quando disponibile). Il server conserva solo la chiave pubblica.

#### Abbinamento tramite QR

```
1. Sito (sessione OIDC)  → POST /api/pairing
   api: codice casuale 128 bit, valido 5 minuti, monouso; nel DB solo SHA-256(codice)
   risposta: { code, expiresAt, qrSvg }
   QR = {"v":1,"api":"https://<host-sito>/api","code":"<code>"}

2. App: legge il QR, genera la coppia di chiavi nel Keystore
   → POST /api/app/pair
     { code, deviceName, publicKey: <SPKI base64>, proof: <firma ES256 di "pair:"+code> }

3. api: codice valido, non scaduto, non usato; verifica `proof` con publicKey
   (prova di possesso della chiave privata) → crea Device(userSub del codice, publicKey)
   risposta: { deviceId, user: { name } }
```

Il codice è l'unico segreto del passaggio 2 ed è generabile solo da chi ha già superato Authelia (con il secondo fattore): il QR collega la sessione Authelia al telefono senza indebolirla. Il QR si genera una sola volta, nella risposta di `POST /api/pairing`: il DB conserva solo l'hash, quindi il codice non è più ricostruibile. Il sito mostra il QR in un pannello che scade insieme al codice e, dopo l'abbinamento, compare il nuovo dispositivo nella lista.

Opzionale (fase successiva): **key attestation** Android, cioè l'app invia la catena di certificati di attestazione e il server verifica che la chiave sia davvero hardware-backed.

#### Richieste firmate

Ogni richiesta a `/api/app/*` (tranne `pair` e `version`) porta un JWT **ES256** creato al momento, valido 60 secondi:

```
Authorization: CM-Device <jwt>

header : { "alg": "ES256", "typ": "cm-req+jwt", "kid": "<deviceId>" }
payload: {
  "iat": 1793430000,
  "exp": 1793430060,
  "jti": "<128 bit casuali>",
  "htm": "POST",                       // metodo HTTP
  "htu": "/api/app/movies",            // percorso + query
  "bh":  "<base64url SHA-256 del corpo>", // assente per richieste senza corpo
  "av":  10300                         // versionCode dell'app (§11.1)
}
```

Il server:

1. trova il dispositivo da `kid`, rifiuta se revocato;
2. verifica la firma con la chiave pubblica salvata;
3. controlla `exp`/`iat` (tolleranza ±30 s sull'orologio, e `exp - iat ≤ 60`: senza questo limite un JWT con scadenza lunga sopravvivrebbe alla cache dei `jti`), `htm`, `htu` e `bh` contro la richiesta reale; una richiesta con corpo non vuoto e senza `bh` viene rifiutata;
4. rifiuta un `jti` già visto (cache in memoria con scadenza 2 minuti: c'è una sola istanza dell'API);
5. controlla che il **proprietario** del dispositivo sia ancora autorizzato (§4.3): aveva il gruppo utenti al suo ultimo login sul sito (se `Oidc__UserGroup` è vuoto conta solo la data) ed è entrato negli ultimi `Devices__MaxOwnerInactiveDays` giorni; altrimenti `403` con motivo `owner_inactive` (l'app invita ad aprire il sito una volta);
6. rifiuta con `426 Upgrade Required` se `av` è sotto `minSupportedCode` (§11.1);
7. aggiorna `last_seen_at` del dispositivo.

Così una richiesta intercettata non si può riusare né modificare, e il DB non contiene nulla che permetta di impersonare un dispositivo.

Revoca: dal sito (`DELETE /api/devices/{id}`); l'app riceve 401 e torna alla schermata di abbinamento. **Scollega** dal telefono chiama prima `DELETE /api/app/me` (firmata), che revoca il dispositivo sul server, e solo dopo cancella la chiave locale; se il server non è raggiungibile l'app avvisa che il dispositivo resta attivo finché non lo si revoca dal sito.

#### Protezione locale della chiave

- **Versione minima di Android**: `minSdk 30` (Android 11), perché `setUserAuthenticationParameters` richiede API 30 (`setUnlockedDeviceRequired` API 28).
- **Sempre attivo**: `setUnlockedDeviceRequired(true)`. La chiave firma solo a telefono sbloccato; nessun passaggio in più per l'utente (l'app si usa comunque da sbloccato), ma niente firme a telefono bloccato.
- **Opzione nelle impostazioni dell'app, spenta di default**: "Chiedi impronta all'apertura". La chiave viene creata con `setUserAuthenticationRequired(true)` e `setUserAuthenticationParameters(600, AUTH_BIOMETRIC_STRONG or AUTH_DEVICE_CREDENTIAL)`: un'impronta (o il PIN) all'apertura sblocca le firme per **10 minuti**, quindi una sessione di scansioni costa una sola conferma, non una per richiesta. Con timeout 0 ogni firma chiederebbe conferma, e una scansione fa 2–3 richieste firmate: escluso.
- Protegge un solo caso, il telefono sbloccato lasciato in mano ad altri; per un'app che può solo aggiungere film il rischio è basso, per questo è facoltativa.
- Effetto collaterale: con l'opzione attiva Android può invalidare la chiave in modo permanente: quando si disattiva o si reimposta il blocco schermo sicuro e, per le chiavi legate alla biometria, quando si registra una nuova impronta (`setInvalidatedByBiometricEnrollment`, default `true`). I casi esatti con `AUTH_BIOMETRIC_STRONG or AUTH_DEVICE_CREDENTIAL` sono da verificare sui dispositivi. In ogni caso l'app intercetta `KeyPermanentlyInvalidatedException` e propone di rifare l'abbinamento.
- Le impostazioni di protezione sono fissate alla creazione della chiave: attivare o disattivare l'opzione genera una chiave nuova e richiede un nuovo abbinamento (l'app lo spiega prima di procedere).

### 4.3 Utenti e gruppi (Authelia e la sua directory utenti)

Utenti e gruppi si gestiscono **solo nella directory utenti di Authelia** (backend LDAP); Authelia li legge da lì e li passa all'API nel login OIDC (scope `groups`, claim `groups`). L'API non ha registrazione, password né gestione dei gruppi: salva soltanto una copia dei dati ricevuti al login (§5, tabella `users`).

**Due livelli:**

1. **Chi entra** — lo decide Authelia: la `authorization_policy` del client OIDC (§4.1) e la regola `access_control` del forward auth sul dominio del sito ammettono solo il gruppo utenti (`<gruppo-utenti>`), con due fattori. Chi non è nel gruppo non arriva all'API.
2. **Cosa fa dentro** — lo decide l'API dal claim `groups`, con due ruoli configurabili:

| Ruolo | Gruppo (variabile) | Cosa può fare |
|---|---|---|
| utente | `Oidc__UserGroup` (`<gruppo-utenti>`) | vedere la collezione, segnare visto/voti, abbinare e revocare i **propri** dispositivi, aggiungere film dall'app, correggere/eliminare i **propri** arrivi |
| amministratore | `Oidc__AdminGroup` (`<gruppo-admin>`) | tutto il resto: IMPORTA DA TELLICO, ESPORTA CSV, gestione dei campi personalizzati, correggere/eliminare qualsiasi arrivo, vedere e revocare i dispositivi di **tutti** |

L'amministratore deve essere anche nel gruppo utenti (altrimenti Authelia non lo fa entrare). Se `Oidc__UserGroup` non è impostato, ogni utente che Authelia lascia passare è "utente" (utile per un'installazione con un solo utente). Un utente presente solo nel gruppo amministratore (con `Oidc__UserGroup` impostato) non ha ruoli: `GET /api/me` risponde `roles: []` e il resto dell'API 403. Il frontend nasconde i controlli non permessi in base a `GET /api/me`, ma il controllo vero è sempre nell'API (policy di autorizzazione ASP.NET per endpoint).

**Da dove arriva il claim `groups`.** Nelle versioni recenti Authelia, di default, restituisce i dati dell'utente (gruppi compresi) dall'endpoint **userinfo** e non nell'id_token. L'API quindi usa `GetClaimsFromUserInfoEndpoint = true` e mappa `groups` sui ruoli. In alternativa si aggiungono i gruppi all'id_token con una `claims_policy` in Authelia. Da verificare sulla versione in uso durante la fase 1.

**Quando valgono i cambi di gruppo.**

- *Sito*: i gruppi vengono letti a ogni login e restano nel cookie; con la sessione di 12 ore (§4.1) una rimozione da un gruppo nella directory ha effetto al più entro 12 ore. Per un effetto immediato basta un logout forzato (`DELETE /api/users/{sub}/sessions`, amministratore) oppure la disattivazione dell'utente nella directory, che blocca il login successivo.
- *Telefono*: non passa da Authelia, quindi non vede direttamente i cambi nella directory. Interrogare la directory dall'API renderebbe lo stack dipendente da altri servizi, quindi:
  - a ogni login sul sito l'API aggiorna `users.groups` e `users.last_login_at`;
  - le richieste dal telefono sono accettate solo se l'ultimo login registrato del proprietario aveva il gruppo utenti (se `Oidc__UserGroup` è vuoto, questa condizione non si applica) **e** risale a meno di `Devices__MaxOwnerInactiveDays` giorni (default 90);
  - un utente tolto dal gruppo smette di poter usare i suoi telefoni al primo login sul sito senza il gruppo, oppure al più dopo quel numero di giorni;
  - per un effetto immediato l'amministratore revoca i dispositivi dal sito (anche tutti quelli di un utente in un colpo).

### 4.4 Modello delle minacce

| Scenario | Mitigazione |
|---|---|
| Accesso diretto alla porta pubblicata dalla LAN, senza Caddy | l'API richiede cookie OIDC o firma del dispositivo: 401 |
| Header di identità falsificati | l'API non legge header di identità |
| QR fotografato da altri | codice monouso, 5 minuti; il nuovo dispositivo appare nella lista ed è revocabile |
| Richiesta dell'app intercettata e rinviata | `jti` monouso + `exp` 60 s + firma su metodo/percorso/corpo |
| Telefono perso | revoca dal sito; chiave non esportabile dal Keystore e utilizzabile solo a telefono sbloccato (con impronta, se l'opzione è attiva) |
| Utente rimosso da un gruppo o disattivato nella directory | sito: niente login, e la sessione esistente scade entro 12 ore; telefono: bloccato al primo login senza gruppo o dopo `Devices__MaxOwnerInactiveDays`; revoca immediata dall'amministratore |
| Utente senza ruolo amministratore che chiama endpoint di amministrazione | policy di autorizzazione nell'API, non solo controlli nascosti nel frontend |
| Furto del dump del DB o di un file di backup | solo chiavi pubbliche e hash dei codici; le chiavi Data Protection sono cifrate con un certificato che non sta nel DB (§4.1), quindi non si possono forgiare cookie di sessione |
| CSRF dal browser | `SameSite=Lax` + header `X-CM-Request` obbligatorio sulle scritture |
| SSRF tramite URL della copertina | l'API scarica solo da `image.tmdb.org` (vedi §7) |
| XSS dai dati importati | invariato: lit esegue l'escape; mai `unsafeHTML` |
| Brute force su `pair`, o esaurimento del rate limit per bloccare gli abbinamenti | codice a 128 bit; rate limit per IP reale (§4.1, catena dei proxy) più un limite globale; `/api/app/*` è senza forward auth, quindi il limite per IP da solo non basterebbe |
| Open redirect via `returnUrl` | solo percorsi locali (§4.1) |
| Copertina scaricata da un host diverso via redirect | download senza redirect automatici (§7) |
| Chiavi API esterne (TMDb, UPC) | solo nell'environment dell'API, mai nell'app o nel repo |

## 5. Modello dati (Postgres, EF Core)

Migrazioni EF Core nel repo, applicate all'avvio dell'API (`Database.Migrate()`; una sola istanza).

**Perché Postgres e non un DB documentale (es. MongoDB).** Lo schema è già ibrido: i dati del film sono un documento libero (`jsonb`), mentre dispositivi, codici di abbinamento e stato per utente sono relazionali. Postgres copre entrambe le parti. In più dà, senza codice aggiuntivo, vincoli nel DB (EAN univoco, chiavi esterne dispositivo → utente e stato → film), transazioni semplici per l'import tutto-o-niente, un provider EF Core maturo con migrazioni e un backup in un solo file (`pg_dump`). Con qualche migliaio di film le prestazioni non sono un criterio. Un DB documentale avrebbe senso se i dati fossero solo documenti senza relazioni; qui le relazioni ci sono, e la flessibilità dello schema la dà già `jsonb`.

### `movies`

| Colonna | Tipo | Note |
|---|---|---|
| `id` | `int` PK | per i film importati **= id Tellico** (vedi sotto); per quelli dall'app da una sequenza che parte da `1 000 000` |
| `tellico_id` | `int` unique null | id dell'entry nel `.tc`; null per gli arrivi non ancora importati in Tellico |
| `ean` | `text` unique null | codice a barre normalizzato (solo cifre, EAN-13; UPC-A con zero davanti) |
| `data` | `jsonb` | oggetto `Movie` così come lo produce `parser.ts` (titolo, anno, regista[], cast[], generi…, `cover`) |
| `source` | `text` | `tellico` \| `app` |
| `tmdb_id` | `int` null | per gli arrivi dall'app |
| `created_at`, `updated_at` | `timestamptz` | |
| `created_by` | `text` null | `sub` dell'utente |
| `created_by_device` | `uuid` null | FK `devices` |
| `exported_at` | `timestamptz` null | ultimo export CSV che lo includeva |

Tenere `data` come JSON evita di replicare nello schema tutti i campi Tellico (anche quelli personalizzati) e lascia il frontend invariato: `GET /api/collection` restituisce `data` + `id`, cioè esattamente i `Movie[]` di oggi.

**Perché `id` = id Tellico per gli importati**: le chiavi di `localStorage` (`cm_status`, `cm_rating`) sono gli id del `.tc`, quindi la migrazione di visto/voto è diretta, e gli id restano stabili tra un import e l'altro. Gli arrivi dall'app partono da 1 000 000 per non collidere mai con gli id che Tellico assegna.

### `collection_fields`

Definizione dei campi della collezione: da dove vengono, come si leggono, dove compaiono. È la base dei campi personalizzati (§5.1), del CSV con le **intestazioni della propria collezione** (§9) e del modulo dell'app (§11).

| Colonna | Tipo | Note |
|---|---|---|
| `name` | `text` PK | nome tecnico, uguale alla chiave in `movies.data` (es. `genre`, `edizione`); immutabile |
| `title` | `text` | titolo mostrato e usato come intestazione CSV (es. "Edizione") |
| `type` | `text` | `line`, `para`, `number`, `bool`, `date`, `choice`, `url`, `rating`, `table`, `image`, `dependent` (mappati dai codici numerici di Tellico; `dependent` = campo calcolato da altri, solo in lettura: escluso da modulo, validazione e CSV) |
| `multiple` | `bool` | valori multipli (array in `data`) |
| `allowed` | `text[]` null | valori ammessi per `choice` (attributo `allowed` di Tellico) |
| `origin` | `text` | `tellico` (dall'ultimo import) \| `local` (creato dal sito) |
| `groupable` | `bool` | compare tra i raggruppamenti del carosello e di FILTRI |
| `group_min_size` | `int` | soglia minima di film per mostrare un gruppo (come le soglie fisse di oggi) |
| `in_form` | `bool` | compare nel modulo dell'app e nella correzione degli arrivi |
| `ordinal` | `int` | ordine di visualizzazione |

All'import da Tellico (§8) le definizioni con `origin = tellico` vengono aggiornate da quelle del `.tc` (`multiple` dal flag "valori multipli" di Tellico, `groupable` di default dal flag "raggruppabile"). Le preferenze impostate dal sito (`groupable`, `group_min_size`, `in_form`, `ordinal`) non vengono sovrascritte. Un campo `local` con lo stesso `name` di un campo arrivato da Tellico diventa `tellico`.

### 5.1 Campi personalizzati

Non serve cambiare lo schema del DB per aggiungere un campo: i valori vivono in `movies.data` (`jsonb`), la definizione in `collection_fields`.

- **Campi creati in Tellico** (es. "Edizione", "Scaffale", "Prestato a"): l'import ne porta valori e definizione; compaiono nel sito e nel CSV senza altro lavoro.
- **Campi creati dal sito** (`POST /api/fields`, origine `local`): nome, titolo, tipo, valori multipli, eventuali valori ammessi. Il modulo dell'app e la scheda film si costruiscono da `collection_fields`, quindi il campo è subito compilabile. Per portarlo in Tellico basta creare lo stesso campo anche lì: il CSV lo esporta con quel titolo.
- **Validazione lato API** in base al tipo (numero, data ISO, booleano, valore tra gli `allowed`, lunghezza massima) su `POST /api/app/movies` e `PATCH /api/movies/{id}`.
- **Eliminazione** (`DELETE /api/fields/{name}`, solo `local`): rimuove la definizione; i valori restano in `data` finché non si chiede esplicitamente la pulizia (`?purge=true`). I campi `tellico` si eliminano in Tellico e spariscono al successivo import.
- **Indici**: se un campo personalizzato viene usato spesso per filtri o ordinamenti lato server, si indicizza direttamente dentro il `jsonb` (indice GIN su `data` o indice su espressione, es. `((data->>'edizione'))`) con una migrazione, senza toccare il modello. Oggi filtri e raggruppamenti girano nel browser, quindi non serve.

### `user_movie_state`

| Colonna | Note |
|---|---|
| `user_sub`, `movie_id` | PK composta |
| `status` | `seen` \| `watchlist` \| null |
| `rating` | 1–5 \| null |
| `updated_at` | |

La riga si cancella quando stato e voto tornano entrambi null.

**Nessun seed dal `.tc`** (decisione). Oggi il sito usa i campi "Visto" e voto personale del `.tc` come valore di partenza; con più utenti quei valori (le scelte di chi cataloga in Tellico) comparirebbero come scelte di tutti. In modalità DB quindi stato e voto partono vuoti per ogni utente e contano solo le scelte fatte nel sito. I campi `visto`/voto restano dentro `data` come gli altri campi Tellico (visibili nei dati, esportati nel CSV `all`), ma non alimentano `user_movie_state`. La migrazione di §10 porta nel DB solo le scelte manuali salvate in localStorage, non i valori del `.tc`. Il calcolo del seed in `handleFile` (`main.ts`) resta solo nella modalità `.tc`.

### `users`

Copia dei dati ricevuti da Authelia all'ultimo login; nessuna gestione locale.

| Colonna | Tipo | Note |
|---|---|---|
| `sub` | `text` PK | identificativo stabile dell'utente da Authelia |
| `username` | `text` | `preferred_username` |
| `display_name` | `text` null | `name` |
| `groups` | `text[]` | gruppi al momento dell'ultimo login |
| `last_login_at` | `timestamptz` | |
| `security_stamp` | `uuid` | inserito nel cookie a ogni login; rigenerato da `DELETE /api/users/{sub}/sessions` per invalidare le sessioni attive (§4.1) |

`user_movie_state.user_sub`, `devices.user_sub`, `pairing_codes.user_sub` e `movies.created_by` sono chiavi esterne verso `users.sub`.

### `devices`

`id` (uuid), `user_sub`, `name`, `public_key` (SPKI DER), `created_at`, `last_seen_at`, `revoked_at`.

### `pairing_codes`

`code_hash` (PK), `user_sub`, `expires_at`, `used_at`. Pulizia periodica dei codici scaduti.

### `ean_lookup_cache`

`ean` (PK), `provider`, `response` (`jsonb`), `fetched_at`. Riduce le chiamate ai provider a quota limitata; scadenza 30 giorni, nessuna cache per i "non trovato" oltre 24 ore.

### `data_protection_keys`

Tabella standard di `PersistKeysToDbContext`; il contenuto è cifrato con il certificato di §4.1.

## 6. API HTTP

Tutte le risposte sono JSON salvo dove indicato. Errori: `application/problem+json`. Il contratto dettagliato andrà in `docs/api.md`.

### 6.1 Pubbliche

| Metodo | Percorso | |
|---|---|---|
| GET | `/api/health` | stato dell'API e del DB (per il monitoraggio) |
| GET | `/api/app/version` | file statico servito da **nginx**, non dall'API (§11.1, §12): versione dell'app disponibile, anche per un'app troppo vecchia o non abbinata |
| GET | `/app/cinemanager.apk`, `/app/version.json` | statici, serviti da nginx dietro il forward auth (§11.1) |

### 6.2 Sito (cookie OIDC; scritture con `X-CM-Request: 1`)

| Metodo | Percorso | Descrizione |
|---|---|---|
| GET | `/api/auth/login?returnUrl=` | avvia il login OIDC |
| GET | `/api/auth/callback` | callback OIDC (gestita dal middleware) |
| POST | `/api/auth/logout` | chiude la sessione dell'API |
| GET | `/api/me` | `{ sub, name, roles: ["user", "admin"] }` |
| GET | `/api/collection` | `{ movies: Movie[], fields: Field[] }` |
| GET | `/api/state` | `{ status: {id: s}, rating: {id: r} }` (solo le scelte esplicite dell'utente) |
| PUT | `/api/state/{movieId}` | `{ status }` oppure `{ rating }`; il campo presente è quello scelto (null = "nessuno") |
| POST | `/api/state/migrate` | `{ status: {...}, rating: {...} }` da localStorage; scrive solo dove l'utente non ha già una scelta |
| POST | `/api/import/tellico/images` | carica un lotto di immagini incorporate (§8), idempotente |
| POST | `/api/import/tellico` | import/upsert di campi e film (§8) → riepilogo |
| GET | `/api/arrivals?scope=new\|app` | film dall'app: `new` mai esportati, `app` tutti quelli non ancora collegati a Tellico (stessa semantica di §9) |
| PATCH | `/api/movies/{id}` | correzione di un arrivo (solo `source = app`) |
| DELETE | `/api/movies/{id}` | elimina un arrivo sbagliato (solo `source = app`) |
| POST | `/api/export/csv` | `{ scope: new\|app\|all }` → `text/csv` (§9); header `X-CM-Movie-Ids` con gli id inclusi |
| POST | `/api/export/mark` | `{ ids }`: segna come esportati i film del CSV appena scaricato (§9) |
| POST | `/api/pairing` | nuovo codice di abbinamento → `{ code, expiresAt, qrSvg }`; il QR si ottiene solo qui (il DB conserva l'hash) |
| GET | `/api/app-download-qr.svg` | QR con l'URL assoluto dell'APK (`PublicBaseUrl` + `/app/cinemanager.apk`), per §10.1 |
| GET | `/api/devices` | dispositivi dell'utente |
| DELETE | `/api/devices/{id}` | revoca |
| GET | `/api/fields` | definizioni dei campi (§5.1) |
| POST | `/api/fields` | nuovo campo personalizzato (`origin = local`) |
| PATCH | `/api/fields/{name}` | titolo, `groupable`, `group_min_size`, `in_form`, `ordinal`, `allowed` |
| DELETE | `/api/fields/{name}?purge=` | elimina un campo `local` (con `purge=true` cancella anche i valori) |

Permessi: gli endpoint di import, export e gestione dei campi richiedono il ruolo **amministratore**; `PATCH`/`DELETE /api/movies/{id}` e `DELETE /api/devices/{id}` sono permessi all'utente solo sui propri arrivi/dispositivi, all'amministratore su tutti; il resto richiede il ruolo **utente** (§4.3). `GET /api/me` restituisce i ruoli (non i gruppi grezzi) per adattare l'interfaccia.

Endpoint solo per l'amministratore, in aggiunta:

| Metodo | Percorso | Descrizione |
|---|---|---|
| GET | `/api/devices?all=true` | dispositivi di tutti gli utenti, con proprietario e ultimo utilizzo |
| DELETE | `/api/users/{sub}/devices` | revoca tutti i dispositivi di un utente |
| DELETE | `/api/users/{sub}/sessions` | invalida le sessioni del sito di un utente (rigenera `users.security_stamp`, §4.1) |

### 6.3 App (richieste firmate, §4.2)

| Metodo | Percorso | Descrizione |
|---|---|---|
| POST | `/api/app/pair` | abbinamento (non firmata: autenticata dal codice + prova di possesso) |
| GET | `/api/app/me` | verifica dell'abbinamento → `{ deviceId, deviceName, user }` |
| DELETE | `/api/app/me` | il dispositivo si revoca da solo ("Scollega", §4.2) |
| GET | `/api/app/fields` | campi con `in_form = true`, per costruire il modulo (inclusi i personalizzati) |
| GET | `/api/app/lookup?ean=` | ricerca da codice a barre → bozza, candidati e possibili duplicati (§7) |
| GET | `/api/app/search?q=&year=` | ricerca manuale su TMDb (EAN non trovato o titolo sbagliato) |
| GET | `/api/app/tmdb/{tmdbId}` | bozza completa per un candidato scelto |
| POST | `/api/app/movies` | inserisce il film confermato → `201 { id }`; `409 { reason: "ean", existingId, title }` se l'EAN esiste già; `409 { reason: "possible_duplicate", candidates }` se esiste un film con stesso titolo + anno normalizzati o stesso `tmdb_id`, a meno che il corpo contenga `"confirmDuplicate": true` |

Corpo di `POST /api/app/movies`:

```json
{
  "ean": "8012345678901",
  "tmdbId": 238,
  "posterPath": "/abc123.jpg",
  "movie": {
    "title": "Il padrino",
    "year": 1972,
    "director": ["Francis Ford Coppola"],
    "genre": ["Drammatico", "Crime"],
    "cast": [{ "actor": "Marlon Brando", "role": "Vito Corleone" }],
    "running-time": 175,
    "nationality": ["USA"],
    "language": ["Inglese"],
    "plot": "…",
    "medium": "DVD",
    "edizione": "Steelbook"
  },
  "confirmDuplicate": false
}
```

L'API valida i campi in base alle definizioni di `collection_fields` (tipi, valori ammessi, lunghezze, anno plausibile; i campi sconosciuti vengono rifiutati), normalizza l'EAN, scarica la copertina e salva `data` nello stesso formato prodotto dal parser, impostando `cdate` alla data di inserimento (`AAAA-MM-GG`) così il film compare nel raggruppamento delle novità come quelli di Tellico. Il `medium` (supporto) segue gli `allowed` del campo nella collezione, se definiti.

### Limiti

- Rate limit (ASP.NET `RateLimiter`, sull'IP reale ricavato come in §4.1): `pair` 10/min per IP e 30/min globali; `lookup`/`search` 60/min per dispositivo; generale 300/min per IP o dispositivo. Un ulteriore limite su Caddy per `/api/app/*` è consigliato ma facoltativo.
- Corpo massimo: 256 KB per le chiamate dell'app; **32 MB** per `import/tellico/images` (un lotto) e per `import/tellico` (campi + film, senza immagini), impostati con `[RequestSizeLimit]` sull'endpoint (il default di Kestrel è circa 30 MB) e con lo stesso valore in nginx solo per quelle location, insieme a `proxy_read_timeout 300s`. Dividere le immagini in lotti evita di deserializzare in memoria un unico JSON da centinaia di MB.

## 7. Ricerca dei dati da codice a barre

I database di codici a barre restituiscono il **nome del prodotto** ("Il Padrino (DVD) [Edizione Speciale]"), non i metadati del film. Due passaggi, tutti lato server:

1. **EAN → nome prodotto**: catena di provider configurabile (`Lookup__Providers`), il primo che risponde vince. Iniziale: UPCitemdb (piano gratuito a quota giornaliera, chiave opzionale per piani superiori). Interfaccia `IBarcodeProvider` per aggiungerne altri (EAN-Search, Go-UPC…). Risultato in `ean_lookup_cache`.
2. **Pulizia del titolo**: rimozione di formato e confezione (`DVD`, `Blu-ray`, `4K`, `Steelbook`, `Edizione…`, `Import`, contenuto tra parentesi), anno se presente → filtro.
3. **TMDb**: `search/movie` con `language=it-IT`, `region=IT` (+ `year` se noto); per il candidato migliore `movie/{id}?append_to_response=credits`. Mappatura:
   - `title` (italiano), `original-title` se il campo esiste nella collezione;
   - `year` da `release_date`; `running-time`; `plot` da `overview`;
   - `genre` (nomi italiani TMDb); `director` dai `crew` con job `Director`; `cast` primi 10 con ruolo;
   - `nationality` da `production_countries` con la stessa normalizzazione del parser (`USA`, `UK`…); `language` da `spoken_languages`.
4. Risposta di `lookup`: `{ ean, productName, draft, candidates: [{ tmdbId, title, year, posterUrl }], possibleDuplicates: [{ id, title, year }] }`. Se più candidati sono plausibili, l'app li mostra prima del modulo. Se l'EAN non è noto a nessun provider: `draft` vuoto e l'app propone la ricerca manuale.
5. **Possibili duplicati**: i film importati da Tellico di solito non hanno EAN né `tmdb_id`, quindi il controllo per EAN non basta. `possibleDuplicates` elenca i film della collezione con titolo + anno normalizzati uguali alla bozza (stessa normalizzazione del passo 3 di §8) o con lo stesso `tmdb_id`; l'app li mostra ("Forse ce l'hai già") prima dell'invio, e l'invio richiede `confirmDuplicate` (§6.3).

**Copertine**: l'app invia solo `posterPath` di TMDb, validato con `^/[A-Za-z0-9_-]+\.(jpg|jpeg|png)$`; l'API costruisce l'URL su `https://image.tmdb.org/t/p/w500` (unico host consentito ⇒ niente SSRF), scarica con `HttpClient` **senza redirect automatici** (`AllowAutoRedirect = false`: un redirect porterebbe fuori dall'host consentito), controlla content-type immagine e dimensione (≤ 5 MB) e salva `cm-<id>.jpg` in `assets/covers/`. `data.cover` = nome del file, quindi `coverUrl()` funziona come oggi con `imgDir`.

**TMDb** richiede l'attribuzione ("This product uses the TMDB API but is not endorsed or certified by TMDB") nel sito e nell'app: nel sito va in una nota del pannello ARRIVI (fase 3), nell'app nella schermata Impostazioni (fase 5).

## 8. IMPORTA DA TELLICO (upsert)

Il browser riusa il codice esistente (JSZip + `parseTellicoXml`, esteso per restituire anche i `<fields>`, §10) e invia all'API in due passi:

1. **Immagini**, a lotti di al massimo ~20 MB: `POST /api/import/tellico/images { "images": { "<id immagine>": "<base64>" } }`. Le immagini vengono da due posti: quelle incorporate in base64 nell'XML (`<images>`, già lette dal parser) e i file nella cartella `images/` dentro lo zip del `.tc`, se Tellico le salva lì (oggi `handleFile` legge solo `tellico.xml`: va esteso; il formato esatto è da verificare su un `.tc` reale).
2. **Campi e film**, in una sola richiesta: `POST /api/import/tellico`

```json
{ "fields": [{ "name": "title", "title": "Titolo", "type": "1", "flags": 0, "allowed": null }, …],
  "movies": [ /* Movie[] dal parser */ ] }
```

Così il parsing resta in un solo posto e l'API non deve replicare il formato Tellico.

### Abbinamento di ogni entry

In quest'ordine:

1. **EAN**: se l'entry ha un campo codice a barre (nome configurabile, default `ean`, vedi §9) e un film nel DB ha lo stesso EAN ⇒ quel film. È il caso dei film arrivati dall'app, esportati in CSV e importati in Tellico, che ricevono un nuovo id Tellico.
2. **`tellico_id`** = id dell'entry, **con controllo di identità**: se il film nel DB e l'entry hanno entrambi `cdate` (data di creazione dell'entry in Tellico) e sono diverse, l'id è stato riusato da Tellico per un film nuovo dopo una cancellazione. In quel caso il vecchio film perde il collegamento (`tellico_id` = null, finisce tra i `missing`) e l'entry prosegue ai passi successivi. Si usa `cdate` e non il titolo perché il titolo cambia legittimamente quando lo si corregge in Tellico. Se `cdate` manca da una delle due parti, l'abbinamento per id viene accettato. (Che Tellico riusi gli id è da verificare; il controllo costa poco e protegge visto/voto dal passare a un altro film.)
3. **Titolo + anno** normalizzati (minuscole, senza accenti/punteggiatura), solo tra i film `source = app` con `tellico_id` null: copre i film esportati senza EAN.
4. Nessuna corrispondenza ⇒ **nuovo film** con `id` = id Tellico se libero (altrimenti dalla sequenza) e `tellico_id` = id Tellico.

Quando un film viene collegato a un `tellico_id` già assegnato a un altro film (passi 1, 3 o 4), il collegamento dell'altro film viene azzerato prima di assegnarlo, per rispettare il vincolo di unicità.

### Aggiornamento

- `data` viene sostituito da quello di Tellico (Tellico è la fonte per i film catalogati), **tranne** `cover`: se l'entry non ha copertina e il DB sì (tipico dei film arrivati dall'app e importati da CSV), si tiene quella del DB.
- I valori dei campi `local` (creati dal sito, §5.1) che **non** esistono nel `.tc` vengono conservati: il `.tc` non può sovrascrivere ciò che non conosce. Se il campo esiste anche in Tellico, vince Tellico come per gli altri campi.
- `ean` viene aggiornato solo se Tellico ne ha uno.
- `source` diventa `tellico` quando un arrivo viene collegato.
- Le definizioni in `collection_fields` vengono aggiornate come descritto in §5.

### Immagini incorporate

Salvate nella cartella delle copertine (`COVERS_DIR`, la stessa di `imgDir`) con il loro id Tellico come nome file (solo `[A-Za-z0-9._-]`, nessun percorso), scritte solo se il file non esiste già: l'id Tellico è un hash del contenuto, quindi l'import è idempotente. Le immagini sono caricate prima e fuori dalla transazione dei film: se l'import dei film fallisce restano sul disco, il che è innocuo (al tentativo successivo vengono saltate).

### Cosa non fa

I film presenti nel DB ma assenti dal `.tc` **non vengono cancellati**: il riepilogo li elenca (`missing`), ed eventualmente si eliminano a mano.

Risposta: `{ inserted, updated, linked, unchanged, missing: [{ id, title }], fieldsUpdated }` (le immagini hanno già il loro `{ written, skipped }` da `import/tellico/images`). `missing` = film con `source = tellico` non abbinati in questo import, compresi quelli scollegati per id riusato o per conflitto; gli arrivi dall'app non ci finiscono mai.

Tutto in **una transazione**: o l'import va a buon fine per intero o il DB resta com'era.

## 9. ESPORTA CSV per Tellico

- `POST /api/export/csv { scope }`:
  - `new`: film `source = app` mai esportati (default);
  - `app`: tutti i film dall'app ancora non collegati a Tellico;
  - `all`: l'intera collezione (backup/portabilità).
- **Intestazioni = titoli dei campi** in `collection_fields` (quelli della propria collezione, quindi l'abbinamento delle colonne nell'import CSV di Tellico è automatico). Senza un import precedente: titoli inglesi standard di Tellico.
- Colonne: titolo, anno, regista, cast, genere, nazionalità, lingua, durata, trama, supporto, **codice a barre** e tutti i **campi personalizzati** di `collection_fields` (esclusi `image` e `dependent`). Il tipo `bool` esce come `true`/vuoto, `date` come `AAAA-MM-GG`.
- Formato: UTF-8 senza BOM, separatore `,`, quoting RFC 4180; valori multipli separati da `; `; tabella cast come `Attore::Ruolo; Attore::Ruolo`.
- L'export **non** modifica nulla: il server non può sapere se il download è andato a buon fine. La risposta porta gli id inclusi (header `X-CM-Movie-Ids`); quando il browser ha ricevuto il file completo, il sito chiama `POST /api/export/mark { ids }`, che imposta `exported_at`. Se il download fallisce, i film restano "nuovi".
- Le copertine non viaggiano nel CSV (Tellico non le importa): restano nel DB e, grazie alla regola di §8, non vengono perse al successivo IMPORTA DA TELLICO.

**Prerequisito in Tellico**: aggiungere alla collezione un campo testo per il codice a barre (es. nome `ean`, titolo "EAN"). Senza, l'abbinamento al re-import ripiega su titolo + anno. Il nome è configurabile (`Tellico__BarcodeField`).

Il CSV non applica l'escape anti "formula injection" (`=`, `+`, `-`, `@` iniziali): corromperebbe i dati in Tellico. È pensato per Tellico, non per essere aperto in un foglio di calcolo.

## 10. Sito: modifiche al frontend

Restano valide tutte le regole di `CLAUDE.md` (template lit puri, stato solo in `main.ts`, grafo dei moduli aciclico, testi per tema in `copy.ts`).

### Modalità di avvio

`config.json` acquista una chiave opzionale:

```json
{ "apiBase": "./api/", "imgDir": "./assets/covers/", "title": "…" }
```

- **`apiBase` presente** ⇒ modalità DB: `GET /api/me` (401 ⇒ redirect a `/api/auth/login?returnUrl=…`), poi `GET /api/collection` + `GET /api/state`. Niente drop zone e niente seed (§5). Il pulsante Reload oggi rimette il loader con la drop zone (`main.ts`): in modalità DB invece ricarica collezione e stato dall'API restando nella vista.
- `config.example.json` va aggiornato con `apiBase` (commentato nella documentazione: presente solo nei deploy con API).
- **`apiBase` assente** ⇒ modalità `.tc` attuale, invariata (sviluppo, deploy senza API).

La scelta è esplicita e deterministica: nessun "provo l'API e se fallisce uso il `.tc`", che nasconderebbe un'API rotta. Per lo stesso motivo un vero errore di rete (API spenta) non porta al login: mostra l'errore.

**Collezione vuota** (primo avvio in modalità DB, prima di qualsiasi import): l'header compare comunque con un messaggio e, per gli amministratori, il pulsante ARRIVI, così il primo import è possibile dal sito.

### Nuovi moduli

| File | Ruolo |
|---|---|
| `src/api.ts` | foglia: client `fetch` (header `X-CM-Request`, errori `problem+json`), tipi delle risposte. **Sessione scaduta**: le richieste partono con `redirect: "manual"`. Se la sessione dell'API è scaduta arriva un 401; se è scaduta anche quella di Authelia, il forward auth di Caddy risponde con un redirect verso `<host-auth>` che `fetch` non può seguire (cross-origin) e che con `redirect: "manual"` si presenta come risposta `opaqueredirect`. In entrambi i casi (un vero errore di rete invece è "API non raggiungibile", non sessione scaduta): per le letture navigazione completa a `/api/auth/login?returnUrl=<pagina corrente>`; per le scritture annullamento della modifica e toast con il pulsante ACCEDI (§4.1) |
| `src/api-store.ts` | `ApiStoreAdapter implements StoreAdapter`: cache in memoria caricata da `/api/state`, getter sincroni come oggi, setter ottimistici + `PUT` (in caso di errore ripristina e notifica); `setSeed`/`setSeedRating` sono no-op (nessun seed, §5). Al ritorno della scheda in primo piano (`visibilitychange`) ricarica lo stato e chiama `onExternalChange`, al posto dell'evento `storage` |
| `src/arrivals.ts` | pannello **ARRIVI** (shell da `filters.ts`, cache a livello modulo come RANDOM/FILTRI, `resetArrivals()`) |
| `src/templates/arrivals.templates.ts` | template: sezione "Collega un telefono" in due passi (§10.1), QR di abbinamento con conto alla rovescia, lista dispositivi con revoca, lista arrivi (copertina, titolo, anno, EAN, correggi/elimina), pulsanti ESPORTA CSV e IMPORTA DA TELLICO con riepilogo |

Modifiche: `main.ts` (avvio in modalità DB, Reload senza drop zone, seed solo in modalità `.tc`, pulsante ARRIVI nel masthead accanto a INTEL e RANDOM, solo in modalità DB), `parser.ts` (restituisce anche i `fields`, vedi sotto), `groupers.ts` e `modal.ts` (campi personalizzati, vedi sotto), `copy.ts` (testi di colore del pannello per tema; le etichette funzionali ARRIVI, IMPORTA, ESPORTA restano uguali in ogni tema), `scripts/a11y-scan.mjs` (nuovo stato "ARRIVI" con API simulata), `vite.config.ts` (proxy di sviluppo, §10.2), `config.example.json`, `CLAUDE.md` (moduli, grafo, chiavi di localStorage).

### 10.1 Scarica l'app dal sito

Il pannello ARRIVI apre con la sezione **Collega un telefono**, in due passi affiancati:

```
┌ ARRIVI · Collega un telefono ─────────────────────────────┐
│  1. Installa l'app             2. Abbina                  │
│     [QR → APK]                    [QR di abbinamento]     │
│     CineManager 1.3.0             scade tra 4:59          │
│     [SCARICA APK]  SHA-256 ⧉                              │
└───────────────────────────────────────────────────────────┘
```

- **Passo 1**: QR che punta all'URL assoluto di `/app/cinemanager.apk` (SVG da `GET /api/app-download-qr.svg`, costruito dall'API con `PublicBaseUrl`), pulsante SCARICA APK, versione e SHA-256 letti da `/app/version.json` (copiabile, per chi vuole verificare). Inquadrando il QR con la fotocamera il telefono apre il browser, passa da Authelia e scarica l'APK. Breve nota sotto: la prima volta Android chiede di consentire l'installazione da fonti sconosciute per il browser.
- **Passo 2**: il QR di abbinamento di §4.2, generato solo quando l'utente preme ABBINA (il codice scade in 5 minuti, inutile crearlo a ogni apertura del pannello).
- Se `version.json` manca (immagine costruita senza APK, sviluppo locale) il passo 1 mostra "App non disponibile in questa build" e il resto del pannello funziona.

### Parser: campi a valori multipli dai flag di Tellico

Oggi `parser.ts` considera multivalore solo una lista fissa di campi (`MULTIVALUE_FIELDS`: genere, regista, nazionalità…). Un campo personalizzato di Tellico a valori multipli oggi viene **perso del tutto**: Tellico scrive i valori dentro un elemento contenitore al plurale (nome del campo + `s`, es. `<ediziones><edizione>…`), mentre il parser cerca un figlio con il nome singolare del campo e non lo trova.

Correzione, valida in entrambe le modalità (`.tc` e DB):

- il parser legge l'attributo `flags` di ogni `<field>`: il bit "valori multipli" (e "raggruppabile", usato come default di `groupable`) decide come leggere il campo; `MULTIVALUE_FIELDS` resta solo come ripiego per file senza `flags`;
- legge anche `allowed` (valori ammessi dei campi a scelta);
- `ParseResult` restituisce le definizioni (`fields: TellicoField[]` con `name`, `title`, `type`, `flags`, `multiple`, `groupable`, `allowed`; `toCollectionFields` li converte in `CollectionField[]`), usate dall'import (§8) e, in modalità `.tc`, dai raggruppamenti;
- le normalizzazioni di paese e lingua restano legate ai rispettivi campi;
- **campi data** (tipo Tellico 12): oggi il formato `<year><month><day>` è gestito solo per `cdate`/`mdate`; va applicato a tutti i campi di tipo data, che altrimenti diventano il testo concatenato (es. "20240115") invece di `AAAA-MM-GG`, come richiesto da §5.1 e §9;
- **campi tabella** (tipo 8) diversi da `cast`: letti come righe di colonne (`string[][]`), con lo stesso schema di `cast`;
- **immagini nello zip**: `handleFile` legge anche i file in `images/` del `.tc` oltre a `tellico.xml` (§8).

I valori esatti dei bit di `flags` e dei codici di tipo vanno verificati su un `.tc` reale prima dell'implementazione.

### Raggruppamenti e scheda film con campi personalizzati

Oggi `buildGroupers` crea una lista fissa di raggruppamenti: `genre`, `director`, `nationality`, `language`, `studio` (da `groupByField`, con soglie minime di film 3/3/4/5/5), poi `rating`, `decade`, `duration`, `alpha` e quello delle novità (da `cdate`), con logiche proprie e senza soglia. Ogni raggruppamento compare solo se ha almeno 2 gruppi.

- `buildGroupers(movies, store, fields)` aggiunge, dopo quelli fissi, un raggruppamento per ogni campo con `groupable = true` il cui `name` non coincide con quello di un raggruppamento fisso (la chiave è condivisa con `filterSelections`, quindi un nome uguale andrebbe in conflitto), con etichetta = `title` e soglia = `group_min_size` (riusa `groupByField`). Il valore speciale `__none__` di FILTRI ("nessun valore") funziona già per campo, quindi FILTRI e RANDOM li ricevono senza modifiche.
- I raggruppamenti fissi restano quelli di oggi; per i cinque basati su `groupByField` la soglia può venire da `collection_fields.group_min_size` quando presente.
- In modalità `.tc` i `fields` vengono dal parser (`groupable` = flag di Tellico, soglia di default 3).
- La scheda film (`modal.ts`) mostra in una sezione "Altri campi" i campi personalizzati con un valore, formattati per tipo (`bool` → sì, `url` → link con `rel="noopener noreferrer"`, `date` → data locale). Sempre interpolati con lit, mai `unsafeHTML`.
- La ricerca testuale resta su titolo, regista, cast e genere; estenderla ai campi personalizzati è una scelta da fare in seguito (flag `searchable`).

### Migrazione di localStorage

Al primo avvio in modalità DB, se esistono `cm_status`/`cm_rating` e non c'è il flag `cm_migrated_db:<sub>` per l'utente corrente, il sito **chiede conferma** ("Importare nel tuo profilo N scelte salvate in questo browser?" SÌ / NO): su un browser condiviso le scelte salvate potrebbero essere di un'altra persona. Con SÌ invia gli override a `POST /api/state/migrate` (gli id coincidono, §5); in entrambi i casi imposta il flag per quell'utente. Si migrano solo le scelte manuali, non i valori del `.tc` (nessun seed). I dati locali non vengono cancellati. La nuova chiave va aggiunta alla tabella di persistenza di `CLAUDE.md`.

### Il QR

Entrambi i QR sono generati dall'API come SVG (QRCoder): quello di abbinamento arriva nel campo `qrSvg` della risposta di `POST /api/pairing` (unico momento in cui il codice esiste in chiaro), quello di download da `GET /api/app-download-qr.svg`. Il client li mostra come immagine (`<img src="data:image/svg+xml;…">` per il primo, `<img src="/api/app-download-qr.svg">` per il secondo): nessuna dipendenza nuova nel frontend, nessun `unsafeHTML`.

### 10.2 Sviluppo locale

- `vite.config.ts` acquista un `server.proxy` che inoltra `/api` all'API in esecuzione in locale (`dotnet run`, es. porta 5080), così il sito su `localhost:5173` resta same-origin come in produzione.
- L'API in ambiente **Development** può usare un'autenticazione finta (`Auth__DevUser=<nome>`, `Auth__DevRoles=user,admin`) al posto di OIDC, che richiederebbe un provider raggiungibile con `redirect_uri` su localhost. È attiva solo se `ASPNETCORE_ENVIRONMENT=Development` **e** la variabile è impostata; all'avvio in produzione con la variabile presente l'API rifiuta di partire.
- Postgres locale con `docker compose -f deploy/compose.dev.yml up db` (solo il DB, porta pubblicata su localhost).
- `config.json` locale con `apiBase` per la modalità DB, senza per la modalità `.tc`.

## 11. App Android

- **Stack**: Kotlin, Jetpack Compose, CameraX + **ML Kit Barcode Scanning** (modello incluso nell'APK, funziona offline), OkHttp, kotlinx.serialization, DataStore.
- **Schermate**:
  1. *Abbinamento*: scansione del QR (stesso scanner) → genera chiave → `pair`.
  2. *Scansione*: EAN-13 / UPC-A, conferma vibrazione, chiamata `lookup`.
  3. *Scelta*: se più candidati, lista con locandine; "Cerca a mano" se nessun risultato.
  4. *Modulo*: costruito dai campi di `GET /api/app/fields` (inclusi i personalizzati, con il controllo adatto al tipo: testo, numero, data, interruttore, scelta da lista, valori multipli come chip), locandina; il supporto usa gli `allowed` del campo `medium` della collezione (default DVD/Blu-ray/4K se il campo non li definisce). Se `lookup` ha trovato possibili duplicati compare prima un avviso "Forse ce l'hai già" con i titoli; INVIA.
  5. *Esito*: aggiunto / già presente (409 `ean`, con titolo esistente) / possibile duplicato (409 `possible_duplicate`: conferma esplicita e reinvio con `confirmDuplicate`) → torna alla scansione.
  6. *Impostazioni*: server e utente abbinati, "Chiedi impronta all'apertura" (§4.2, richiede un nuovo abbinamento), scollega (`DELETE /api/app/me`, poi cancella la chiave dal Keystore, §4.2), attribuzione TMDb.
- **Chiave**: `KeyPairGenerator.getInstance(EC, "AndroidKeyStore")`, `KeyGenParameterSpec` con `PURPOSE_SIGN`, `DIGEST_SHA256`, curva `secp256r1`, `setIsStrongBoxBacked(true)` con fallback, `setUnlockedDeviceRequired(true)`, autenticazione utente con finestra di 10 minuti solo se l'opzione è attiva (§4.2). La firma `SHA256withECDSA` restituisce DER: va convertita in `R||S` (64 byte) per ES256.
- **Versione minima**: `minSdk 30` (Android 11), per le API del Keystore usate in §4.2.
- **Firma delle richieste**: interceptor OkHttp che calcola `bh`, costruisce e firma il JWT per ogni richiesta.
- Nessuna chiave TMDb/UPC nell'app.
- **Offline** (opzionale): coda locale delle scansioni confermate, inviate con WorkManager quando torna la rete.
- **Distribuzione**: APK firmato costruito dalla CI e **incluso nell'immagine del sito**, scaricabile dal pannello ARRIVI (§10.1); dettagli in §11.1.

**Implementazione (fase 5, `android/`)** — differenze e precisazioni rispetto a quanto sopra:

- Due moduli Gradle: `core` (Kotlin/JVM senza Android: JWT e prova di possesso, QR, client OkHttp, mappatura degli errori, modulo) con test JUnit, e `app` (Compose, Keystore, CameraX). Navigazione con uno stato nel ViewModel, senza libreria di navigazione. Build e test: `android/README.md`.
- La firma avviene in un *network interceptor* di OkHttp (ogni tentativo di connessione ha un `jti` nuovo); redirect disattivati. Il JSON dell'header è scritto da kotlinx.serialization: rispetto a `sign-request` cambia solo l'escape di `+` (`cm-req+jwt` contro `cm-req\u002Bjwt` di System.Text.Json), stesso JSON per il server.
- Il campo codice a barre della collezione (`Tellico__BarcodeField`) non compare nel modulo: `GET /api/app/fields` lo esclude (l'EAN viaggia in `ean`; dentro `movie` verrebbe rifiutato).
- Abbinamento: oltre alla scansione del QR si può incollarne il contenuto (telefono senza fotocamera funzionante, emulatore); nome del dispositivo modificabile, di default produttore + modello. Le build di debug accettano indirizzi `http://` (API locale), la release solo `https://`.
- Scansione: EAN-13/EAN-8/UPC-A/UPC-E con cifra di controllo verificata, vibrazione (haptic `CONFIRM`), EAN anche a mano.
- Modulo: le tabelle diverse da `cast` si modificano come righe con le celle separate da `::`; il supporto propone gli `allowed` del campo `medium` (vincolanti se il campo è `choice`) o DVD/Blu-ray/4K come suggerimenti.
- "Chiedi impronta all'apertura": prompt all'avvio e al ritorno in primo piano dopo almeno 10 minuti, oltre che quando la chiave chiede di nuovo l'autenticazione (`UserNotAuthenticatedException`); se il telefono non ha un blocco schermo sicuro l'opzione è disattivata.
- 403 `owner_inactive` → schermata con "Apri il sito" e Riprova; altri 401 (es. `expired` per l'orologio) → messaggio, senza riabbinamento.
- Non implementati (facoltativi): coda offline, aggiornamento integrato (§11.1 livello 2), correzione/eliminazione degli arrivi dall'app (restano nel pannello ARRIVI).

### 11.1 Distribuzione e aggiornamenti

**Dove sta l'APK.** Dentro l'immagine del sito, in `/app/`:

| File | Contenuto |
|---|---|
| `/app/cinemanager.apk` | APK firmato di release |
| `/app/version.json` | `{ "version": "1.3.0", "versionCode": 10300, "minSupportedCode": 10000, "sha256": "…", "commit": "<sha>" }` |

Motivi rispetto a GitHub Releases come unica fonte:

- sito, API e app escono dallo **stesso commit**: l'APK scaricabile è sempre compatibile con l'API in esecuzione;
- download dal proprio dominio, **dietro Authelia**, senza dipendenze esterne a runtime;
- costo accettabile: l'immagine cresce di 10–20 MB, e ogni deploy compila l'APK (pochi minuti con la cache di Gradle) usando i secret della keystore (§12, CI).

Facoltativo: la CI pubblica lo stesso APK anche come release GitHub (`android-v1.3.0`) per avere lo storico delle versioni. L'APK non contiene segreti, quindi può essere pubblico.

**Versioni.**

- `versionName` e `versionCode` vengono da `android/version.properties` (unica fonte, modificata a mano a ogni rilascio dell'app); `versionCode = major*10000 + minor*100 + patch`.
- `minSupportedCode` sta nello stesso file e si alza solo quando l'API introduce una modifica incompatibile con le app precedenti.
- La CI scrive `version.json` (con lo SHA-256 calcolato sull'APK firmato) e lo copia nell'immagine insieme all'APK.
- Gradle legge la keystore da variabili d'ambiente (`CM_RELEASE_KEYSTORE`, `CM_RELEASE_KEYSTORE_PASSWORD`, `CM_RELEASE_KEY_ALIAS`, `CM_RELEASE_KEY_PASSWORD`), valorizzate in CI dai secret qui sotto; senza, `assembleRelease` produce un APK non firmato. La release usa R8 e solo le librerie native ARM (circa 15 MB).

**Endpoint della versione.** `GET /api/app/version` è servito da **nginx** come file statico: è lo stesso `version.json` dell'immagine del sito, esposto sotto `/api/app/` perché quel percorso non passa dal forward auth (§12), così anche un'app non abbinata o troppo vecchia lo legge. L'API, che sta in un'altra immagine, legge `minSupportedCode` per il controllo `426` da `http://web/app/version.json` sulla rete dello stack (cache di 5 minuti; se il file non è raggiungibile il controllo viene saltato e registrato nei log). Lo schema è uno solo, quello di `version.json`; l'URL di download è sempre `/app/cinemanager.apk` relativo all'indirizzo del server salvato all'abbinamento.

**Controllo all'avvio dell'app:**

- `versionCode < minSupportedCode` ⇒ schermata bloccante "Aggiornamento necessario" con il pulsante di download; l'invio di film è disabilitato;
- `versionCode` dell'app < `versionCode` di `version.json` ⇒ banner non bloccante "Aggiornamento disponibile";
- l'API rifiuta comunque con `426 Upgrade Required` le richieste firmate di app sotto `minSupportedCode` (il JWT di §4.2 porta il claim `av` con il `versionCode` dell'app), così la regola vale anche se il controllo dell'app viene saltato.

**Installazione dell'aggiornamento**, in due livelli:

1. *Base*: il pulsante apre l'URL di download (`/app/cinemanager.apk`) nel browser, che scarica l'APK; l'utente lo apre e conferma.
2. *Integrato* (opzionale): l'app scarica l'APK con la propria sessione HTTP verso il sito, verifica lo SHA-256 contro `version.json` e avvia l'installer di sistema (`PackageInstaller`, permesso `REQUEST_INSTALL_PACKAGES`). Android chiede comunque conferma all'utente. Attenzione: il download diretto dall'app passa da Caddy e dal forward auth di Authelia, che l'app non può superare; per questo livello serve servire l'APK anche da `/api/app/download`, firmato come le altre richieste dell'app.

**Firma dell'APK.**

- Una sola keystore di release per tutta la vita dell'app: un aggiornamento firmato con una chiave diversa **non si installa** sopra la versione esistente (bisognerebbe disinstallare, perdendo l'abbinamento).
- La keystore e le sue password sono secret della CI (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`), con una copia di sicurezza fuori da GitHub (es. password manager). Mai nel repo, nemmeno cifrata.
- Le build di debug locali usano la keystore di debug di Android Studio e non si installano sopra quella di release (applicationId con suffisso `.debug` per tenerle separate).

**Avvisi noti all'installazione manuale**: permesso "Installa app sconosciute" da concedere al browser la prima volta; Play Protect può segnalare un'app non proveniente dal Play Store e proporre una scansione. Sono comportamenti normali per un'app installata a mano.

## 12. Deploy

### Stack Komodo (`deploy/compose.yml`, schema)

```yaml
networks:
  default:
    ipam:
      config: [{ subnet: "${STACK_SUBNET:-172.31.91.0/24}" }]   # fissa: l'API la usa come proxy fidato (§4.1)

services:
  web:
    image: ghcr.io/mcauzzi/moviecarousel:latest
    restart: unless-stopped
    ports: ["${PORT:?}:80"]
    volumes: ["${WEB_ROOT:?}:/srv/data:ro"]
    read_only: true
    tmpfs: [/var/cache/nginx, /var/run, /tmp]

  api:
    image: ghcr.io/mcauzzi/moviecarousel-api:latest
    restart: unless-stopped
    env_file:                            # segreti: Environment di Komodo (.env) o SECRETS_DIR, vedi sotto
      - { path: .env, required: false }
      - { path: "${SECRETS_DIR:-./.secrets-non-impostata}/db.env", required: false }
      - { path: "${SECRETS_DIR:-./.secrets-non-impostata}/api.env", required: false }
    environment:
      ConnectionStrings__Cinema: "Host=db;Database=cinema;Username=cinema"   # password da POSTGRES_PASSWORD, in codice
      PublicBaseUrl: "${PUBLIC_BASE_URL:?}"            # es. https://<host-sito>: redirect_uri OIDC e QR
      Proxy__KnownNetworks: "${STACK_SUBNET:-172.31.91.0/24}"
      Proxy__KnownProxies: "${PROXY_IP:?}"             # IP da cui Caddy raggiunge il NAS
      Oidc__Authority: "${OIDC_AUTHORITY:?}"
      Oidc__ClientId: "${OIDC_CLIENT_ID:?}"
      Oidc__UserGroup: "${OIDC_USER_GROUP:-}"
      Oidc__AdminGroup: "${OIDC_ADMIN_GROUP:?}"
      Devices__MaxOwnerInactiveDays: "${DEVICE_MAX_OWNER_INACTIVE_DAYS:-90}"
      Lookup__Providers: "${LOOKUP_PROVIDERS:-upcitemdb}"
      Tellico__BarcodeField: "${TELLICO_BARCODE_FIELD:-ean}"
      App__VersionUrl: "http://web/app/version.json"
      Covers__Path: /data/covers
    volumes: ["${WEB_ROOT:?}/${COVERS_DIR:?}:/data/covers"]   # unico mount in scrittura
    read_only: true
    tmpfs: [/tmp]
    depends_on: { db: { condition: service_healthy } }

  db:
    image: postgres:17-alpine
    restart: unless-stopped
    env_file: [{ path: .env, required: false }, { path: "${SECRETS_DIR:-./.secrets-non-impostata}/db.env", required: false }]
    environment: { POSTGRES_DB: cinema, POSTGRES_USER: cinema }
    volumes: ["${DB_DIR:?}:/var/lib/postgresql/data"]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U cinema"], interval: 10s }

  backup:
    image: postgres:17-alpine
    restart: unless-stopped
    env_file: [{ path: .env, required: false }, { path: "${SECRETS_DIR:-./.secrets-non-impostata}/db.env", required: false }]
    environment:                           # backup.sh copia POSTGRES_PASSWORD in PGPASSWORD
      PGHOST: db
      PGUSER: cinema
      PGDATABASE: cinema
      BACKUP_KEEP: "${BACKUP_KEEP:-14}"
    volumes:
      - "${BACKUP_DIR:?}:/backup"
      - ./backup.sh:/backup.sh:ro
    entrypoint: ["/bin/sh", "/backup.sh"]   # altrimenti partirebbe un secondo server Postgres
    depends_on: { db: { condition: service_healthy } }
```

`deploy/backup.sh` (nel repo, nessun segreto): ciclo infinito che attende l'ora configurata (`BACKUP_AT`, default 03:30), esegue `pg_dump -Fc -f /backup/cinema-<data>.dump`, verifica il file con `pg_restore --list` e cancella i dump oltre i `BACKUP_KEEP` più recenti. In alternativa `crond` di BusyBox con lo stesso script.

Note:

- Nessuna porta pubblicata per `api`, `db`, `backup`; rete Docker dello stack con subnet fissa, nessuna rete esterna.
- `web` è il nome del servizio nello stack (usato dall'API come hostname). Nessun `container_name`: i container prendono il nome dello stack.
- **Copertine**: il percorso montato nell'API (`COVERS_DIR`, relativo a `WEB_ROOT`) deve coincidere con `imgDir` di `config.json`. L'immagine .NET gira come utente non-root (UID 1654 nelle immagini ufficiali recenti, da verificare): la cartella sul NAS deve essere scrivibile da quell'UID, oppure si imposta `user:` nel compose.
- **Postgres** su `DB_DIR` solo su disco locale del NAS, non su una condivisione di rete (NFS/SMB).
- I secret di firma dell'APK stanno solo nella CI (§11.1), non nello stack. Il certificato Data Protection (§4.1) sta nello stack ed è conservato con gli altri secret.

**Segreti** (mai nel repo), da una delle due sorgenti o da entrambe (a parità di nome vince il file):

- **Secret di Komodo** richiamati nell'Environment dello stack (`POSTGRES_PASSWORD = [[CINEMA_DB_PASSWORD]]`). Komodo scrive l'Environment in `.env` nella run directory (`deploy/`), che i servizi caricano con `env_file`.
- **File env** in `SECRETS_DIR` sul NAS: `db.env` (`POSTGRES_PASSWORD`, per db, backup, api) e `api.env` (`Oidc__ClientSecret`, `DataProtection__CertificateBase64`, `DataProtection__CertificatePassword`, `Tmdb__ApiToken`, facoltativo `Lookup__UpcItemDbKey`).

Passando da `env_file` i valori arrivano ai container così come sono; la password del DB non sta nella connection string ma viene inserita in codice, quindi nessun vincolo sui caratteri. Guida operativa: `deploy/README.md`.

**Variabili** (Environment di Komodo, nessun segreto):

| Variabile | Obbligatoria | Note |
|---|---|---|
| `WEB_ROOT`, `PORT` | sì | cartella dei dati e porta sull'host |
| `COVERS_DIR` | sì | cartella delle copertine relativa a `WEB_ROOT`, uguale a `imgDir` |
| `DB_DIR`, `BACKUP_DIR`, `BACKUP_KEEP` | sì / sì / no (14) | cartelle sul NAS |
| `SECRETS_DIR` | no | cartella con `db.env` e `api.env`, se non si usano i Secret di Komodo |
| `STACK_SUBNET` | no | subnet fissa della rete dello stack |
| `PROXY_IP` | sì | IP con cui Caddy raggiunge il NAS (proxy fidato per l'IP reale) |
| `PUBLIC_BASE_URL` | sì | indirizzo pubblico del sito: `redirect_uri` OIDC e URL nel QR di download |
| `OIDC_AUTHORITY`, `OIDC_CLIENT_ID` | sì | client OIDC in Authelia |
| `OIDC_USER_GROUP`, `OIDC_ADMIN_GROUP` | no / sì | ruoli (§4.3) |
| `DEVICE_MAX_OWNER_INACTIVE_DAYS` | no (90) | §4.3 |
| `LOOKUP_PROVIDERS` | no | catena dei provider EAN (§7) |
| `TELLICO_BARCODE_FIELD` | no (`ean`) | nome del campo codice a barre in Tellico (§8, §9) |

### nginx (`deploy/nginx.conf`)

```nginx
resolver 127.0.0.11 valid=30s;          # DNS di Docker: nginx parte anche se api non è ancora su

location /api/ {
    set $api http://api:8080;
    proxy_pass $api;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # solo per l'IP reale (§4.1)
    add_header Cache-Control "no-store" always;
}
location ~ ^/api/import/tellico(/images)?$ {
    client_max_body_size 32m;
    proxy_read_timeout 300s;
    set $api http://api:8080;
    proxy_pass $api;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

# Versione dell'app: file statico dell'immagine, sotto /api/app/ per evitare il forward auth (§11.1)
location = /api/app/version {
    default_type application/json;
    add_header Cache-Control "no-cache" always;
    alias /usr/share/nginx/html/app/version.json;
}

# APK e versione inclusi nell'immagine (§11.1)
location /app/ {
    types { application/vnd.android.package-archive apk; application/json json; }
    add_header Cache-Control "no-cache" always;
    try_files $uri =404;              # mai ripiegare sui dati del NAS
}
```

Non si inoltrano `X-Forwarded-Proto`/`Host`: il `redirect_uri` viene da `PublicBaseUrl` (§4.1). `index.html` resta `no-cache` (serve a `version-check.ts`).

### Caddy (a cura dell'operatore)

Una route in più **prima** del forward auth, per l'app:

```caddy
<host-sito> {
    handle /api/app/* {
        reverse_proxy <nas>:<porta>      # nessun forward_auth: firma del dispositivo (e /api/app/version statico)
    }
    handle {
        forward_auth <authelia> { … }    # come oggi
        reverse_proxy <nas>:<porta>
    }
}
```

### CI/CD

- `ci.yml`: nuovo job `dotnet` (restore, build, test) accanto a quello Node.
- `deploy.yml`: costruisce e pubblica anche `moviecarousel-api` (`latest` + SHA), da `api/Dockerfile`. Komodo aggiorna lo stack quando escono le immagini.
- `.dockerignore`: aggiungere `api/`, `android/` e `docs/`, perché il `Dockerfile` del sito fa `COPY . .` (e simmetricamente un `.dockerignore` per l'API).
- Android (fase 5):
  - **CI**: workflow separato `android-ci.yml` (lint, test, `assembleDebug`) con filtro `paths: [android/**]`. I filtri `paths` di GitHub valgono per l'intero workflow, non per il singolo job, quindi non si può mettere in `ci.yml` come job condizionato senza un'azione di filtro;
  - **Deploy**: in `deploy.yml` un job `android` (JDK 21, cache Gradle) che decodifica la keystore dai secret, esegue `assembleRelease`, calcola lo SHA-256 e scrive `version.json`; il job dell'immagine del sito scarica l'artefatto e lo copia in `/app/` (Dockerfile con uno stage che accetta la cartella dell'APK come build context aggiuntivo). Il build context si chiama `android-app`; nel Dockerfile uno stage vuoto con lo stesso nome fa da default, così `docker build .` funziona anche senza APK. Con i secret della keystore il job è obbligatorio (stesso commit di sito e API, §11.1): se fallisce, il deploy si ferma, niente immagine con un APK vecchio. **Senza i secret** (scelta dell'implementazione) il job non compila nulla e il sito viene pubblicato lo stesso, senza APK: `version.json` risponde 404, il pannello ARRIVI mostra "App non disponibile in questa build" e l'API salta il controllo 426. Secret e procedura: `deploy/README.md`;
  - opzionale (non implementato): pubblicazione della release GitHub `android-v<versione>` quando cambia `version.properties`.

### Backup e ripristino

- `pg_dump -Fc` notturno con rotazione nella cartella `BACKUP_DIR` sul NAS (inclusa nei backup del NAS).
- Ripristino documentato: `pg_restore --clean -d cinema` sul servizio `db`.
- Le copertine stanno già nella cartella del sito sul NAS (`COVERS_DIR`).
- Il `.tc` di Tellico resta comunque un backup indipendente della collezione (ESPORTA CSV `all` per i film non ancora in Tellico).

## 13. Test

Prima suite di test del repo, limitata all'API (xUnit):

- abbinamento dell'upsert (EAN, `tellico_id`, titolo + anno, id riusato riconosciuto da `cdate`, copertina e campi `local` preservati);
- possibili duplicati in `lookup` e `409 possible_duplicate`;
- generazione del CSV (quoting, valori multipli, cast, intestazioni dalla collezione);
- verifica delle richieste firmate (firma valida, scaduta, `exp - iat` oltre 60 s, `jti` ripetuto, `htu`/`bh` alterati, corpo senza `bh`, dispositivo revocato, proprietario inattivo, `av` sotto il minimo);
- autorizzazione: ruoli per endpoint, risorse proprie contro altrui, `returnUrl` non locale, timbro di sicurezza rigenerato;
- pulizia dei titoli prodotto e mappatura TMDb (risposte registrate, niente rete);
- integrazione con Postgres via Testcontainers (in CI).

Il frontend resta senza test automatici, come oggi; `npm run a11y` copre il nuovo pannello.

## 14. Piano di lavoro

Ogni fase è una PR separata verso `master` a partire da questo ramo (o rami figli).

| Fase | Contenuto | Verificabile con |
|---|---|---|
| 0 | questo documento | revisione |
| 1 | API: progetto, EF Core + migrazioni, OIDC (con utenti, ruoli, timbro di sicurezza, Data Protection cifrata), autenticazione di sviluppo, `/api/health`, `/api/me`, `/api/collection`, `/api/state` (+ `migrate`), `/api/import/tellico` (+ `images`), `compose.dev.yml`, test, `docs/api.md` iniziale | `dotnet test`, Postgres locale |
| 2 | Sito: modalità DB, `api.ts`, `ApiStoreAdapter`, proxy di Vite (§10.2), migrazione localStorage, parser (`flags`, date, tabelle, immagini nello zip), raggruppamenti e scheda con campi personalizzati, prima versione del pannello ARRIVI con la sola sezione IMPORTA DA TELLICO (solo amministratore), `config.example.json`, `CLAUDE.md` | sito in dev con API locale |
| 3 | Abbinamento, dispositivi (anche endpoint di amministrazione e logout forzato), endpoint `/api/app/*` (tranne la versione), ricerca EAN/TMDb con duplicati, ESPORTA CSV, gestione dei campi (`/api/fields`), pannello ARRIVI completo con attribuzione TMDb, stato ARRIVI in `a11y-scan.mjs`, test di firme e TMDb, `docs/api.md` completo | `curl` + script che firma le richieste come farà l'app |
| 4 | Deploy: compose, nginx, `backup.sh`, `.dockerignore`, CI/CD dell'API, aggiornamento `CLAUDE.md` | stack su NAS, client OIDC in Authelia, route in Caddy |
| 5 | App Android, `android-ci.yml`, build firmata in `deploy.yml`, APK e `version.json` nell'immagine del sito, `/api/app/version` statico e controllo `426`, sezione "Collega un telefono" con `GET /api/app-download-qr.svg` | APK scaricato dal sito e installato sul telefono |

## 15. Questioni aperte

- **Copertura dei DVD italiani** nei database di codici a barre: da verificare con un campione della propria collezione prima di scegliere il provider definitivo.
- **Aggiornamento integrato nell'app** (§11.1, livello 2): richiede l'endpoint `/api/app/download` e il permesso `REQUEST_INSTALL_PACKAGES`; da decidere se vale la pena rispetto al semplice link nel browser.

### Decisioni prese

- **App Android nello stesso repo**, cartella `android/`, con job CI separati attivati solo da modifiche in `android/**` (§12).
- **Più utenti**: gestiti da Authelia e dalla sua directory utenti, con ruoli utente e amministratore (§4.3).
- **Biometria**: chiave sempre legata al telefono sbloccato; impronta all'apertura come opzione spenta di default, con finestra di 10 minuti (§4.2).
- **Nessun seed di visto/voto dal `.tc`** in modalità DB: si parte vuoti, si migrano solo le scelte manuali di localStorage (§5, §10).
- **Versione dell'app servita da nginx** come file statico, letta dall'API sulla rete dello stack per il controllo `426` (§11.1).

## 16. TODO futuri

Fuori dalle fasi 0–5, da riprendere dopo:

- **Cancellazioni da Tellico**: oggi un film eliminato in Tellico resta nel DB finché non lo si elimina a mano (§8 lo elenca tra i `missing`). Da aggiungere un'azione "rimuovi i mancanti" nel riepilogo dell'import (solo amministratore, con conferma e lista dei titoli), che elimini anche lo stato visto/voto collegato.
