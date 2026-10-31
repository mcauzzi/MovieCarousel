# Deploy dello stack `cinemalometti`

Stack Komodo definito da [`compose.yml`](compose.yml): quattro container sulla stessa rete Docker
(subnet fissa), una sola porta pubblicata.

| Servizio | Immagine | Ruolo |
|---|---|---|
| `web` (container `cinemalometti`) | `ghcr.io/mcauzzi/moviecarousel` | nginx: sito, dati del NAS, proxy `/api/` → `api`, `/app/` e `/api/app/version` dall'immagine |
| `api` | `ghcr.io/mcauzzi/moviecarousel-api` | API CineManager (.NET), applica le migrazioni all'avvio |
| `db` | `postgres:17-alpine` | database |
| `backup` | `postgres:17-alpine` | `pg_dump` notturno con rotazione ([`backup.sh`](backup.sh)) |

Le immagini vengono pubblicate da `.github/workflows/deploy.yml` a ogni push su `master` (prima l'API,
con i test, poi il sito con l'APK Android, vedi [App Android](#app-android-apk-firmato)); Komodo
aggiorna lo stack quando escono. Design completo:
`docs/scanner-dvd.md` §4.1 e §12.

## Segreti

Due sorgenti, entrambe facoltative e usabili insieme (a parità di nome vince il file in `SECRETS_DIR`).
In tutti e due i casi i valori arrivano ai container con `env_file`, così come sono.

| Variabile | Servizi | File |
|---|---|---|
| `POSTGRES_PASSWORD` | db, backup, api | `db.env` |
| `Oidc__ClientSecret` | api | `api.env` |
| `DataProtection__CertificateBase64`, `DataProtection__CertificatePassword` | api | `api.env` |
| `Tmdb__ApiToken` | api | `api.env` |
| `Lookup__UpcItemDbKey` (facoltativo) | api | `api.env` |

### 1. Secret di Komodo

Crea i Secret in Komodo (Settings → Variables, flag *secret*) e richiamali nell'Environment dello
stack, insieme alle variabili normali:

```ini
POSTGRES_PASSWORD = '[[CINEMA_DB_PASSWORD]]'
Oidc__ClientSecret = '[[CINEMA_OIDC_SECRET]]'
DataProtection__CertificateBase64 = '[[CINEMA_DP_CERT]]'
DataProtection__CertificatePassword = '[[CINEMA_DP_CERT_PASSWORD]]'
Tmdb__ApiToken = '[[CINEMA_TMDB_TOKEN]]'
```

Komodo scrive l'Environment in `.env` nella run directory dello stack e i servizi `api`, `db` e
`backup` lo caricano. Per questo la **run directory deve essere `deploy`** (file `compose.yml`).
Gli apici singoli evitano che Compose interpreti `$`; il valore non può contenere `'` (in quel caso
usa i file env). Nota: con questa via ogni servizio che carica `.env` riceve tutto l'Environment,
quindi anche `db` e `backup` vedono i segreti dell'API.

### 2. File env sul NAS

Imposta `SECRETS_DIR` nell'Environment con una cartella fuori dal repo:

```sh
install -d -m 700 /percorso/segreti
install -m 600 /dev/null /percorso/segreti/db.env
install -m 600 /dev/null /percorso/segreti/api.env
```

`db.env` (letto da `db`, `backup` e `api`):

```ini
POSTGRES_PASSWORD='la-password'
```

`api.env` (letto da `api`):

```ini
Oidc__ClientSecret='segreto-in-chiaro-del-client'
DataProtection__CertificateBase64='MIIK...'
DataProtection__CertificatePassword='password-del-pfx'
Tmdb__ApiToken='eyJ...'
# Lookup__UpcItemDbKey='...'          facoltativo
```

Anche qui valori tra **apici singoli**. Con questa via `db` e `backup` vedono solo `db.env`.

### Note comuni

- `env_file` con `required: false` richiede Docker Compose ≥ 2.24. Se un segreto manca del tutto,
  Postgres non parte senza password e l'API lo segnala nei log all'avvio.
- L'API usa `POSTGRES_PASSWORD` come password del DB inserendola nella connection string in codice:
  nessun vincolo sui caratteri.
- Postgres legge la password solo al primo avvio (quando crea il DB): per cambiarla dopo serve anche
  `ALTER ROLE cinema PASSWORD '...'`.

## Variabili dell'Environment Komodo

Variabili normali (i segreti sono nella sezione sopra). L'elenco completo, con i default, è nel commento in testa a `compose.yml`.

- Obbligatorie: `WEB_ROOT`, `DB_DIR`, `BACKUP_DIR`, `PUBLIC_BASE_URL`, `PROXY_IP`,
  `OIDC_AUTHORITY`, `OIDC_CLIENT_ID`, `OIDC_ADMIN_GROUP`.
- Facoltative: `SECRETS_DIR` (solo con i file env), `PORT` (8091), `STACK_SUBNET` (172.31.91.0/24), `OIDC_USER_GROUP`,
  `DEVICE_MAX_OWNER_INACTIVE_DAYS` (90), `LOOKUP_PROVIDERS` (upcitemdb),
  `TELLICO_BARCODE_FIELD` (ean), `BACKUP_KEEP` (14), `BACKUP_AT` (03:30), `BACKUP_NOW` (0), `TZ` (Europe/Rome).

Note:

- `STACK_SUBNET` deve essere libera sul NAS (nessun'altra rete Docker sovrapposta).
- `PROXY_IP` è l'indirizzo con cui Caddy arriva al NAS: serve all'API per leggere l'IP reale del
  client dal `X-Forwarded-For` (rate limit e log), non per l'autenticazione.

## Certificato Data Protection

Cifra le chiavi che firmano il cookie di sessione (salvate nel DB): senza, chi ha un dump potrebbe
forgiare sessioni. Perderlo non perde dati, fa solo rifare il login a tutti. Conservalo con gli
altri secret.

```bash
openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=cinemanager-dp" \
  -keyout dp.key -out dp.crt
openssl pkcs12 -export -inkey dp.key -in dp.crt -out dp.pfx -passout pass:<password>
base64 -w0 dp.pfx          # → DataProtection__CertificateBase64 (<password> → DataProtection__CertificatePassword)
shred -u dp.key            # dp.pfx va conservato fuori dal NAS insieme alla password
```

## App Android (APK firmato)

Il job `android` di `.github/workflows/deploy.yml` compila l'app (`android/`), la firma con la
keystore di release e scrive `version.json`; il job `image` li copia in `/app/` dell'immagine del
sito (`/app/cinemanager.apk`, `/app/version.json`, servito anche come `/api/app/version`). Sito,
API e app escono così dallo stesso commit (`docs/scanner-dvd.md` §11.1).

**Secret del repository** (GitHub › Settings › Secrets and variables › Actions), mai nel repo:

| Secret | Contenuto |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | la keystore `.jks` in base64 (`base64 -w0 release.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | password della keystore |
| `ANDROID_KEY_ALIAS` | alias della chiave |
| `ANDROID_KEY_PASSWORD` | password della chiave |

Keystore (una sola per tutta la vita dell'app: con un'altra chiave gli aggiornamenti non si
installano sopra la versione esistente). Generala fuori dal repo e conservane una copia con le
password fuori da GitHub (es. password manager):

```bash
keytool -genkeypair -keystore release.jks -alias cinemanager -keyalg RSA -keysize 4096 \
  -validity 10000 -dname "CN=CineManager"
base64 -w0 release.jks          # → ANDROID_KEYSTORE_BASE64
```

Comportamento del deploy:

- **secret assenti**: il job `android` non compila nulla (avviso nel log) e l'immagine del sito
  viene pubblicata senza APK. `/app/version.json` e `/api/app/version` rispondono 404: il pannello
  ARRIVI mostra "App non disponibile in questa build" e l'API salta il controllo 426.
- **secret presenti**: test, `assembleRelease` firmato, `apksigner verify`, SHA-256 e
  `version.json`; se qualcosa fallisce il deploy si ferma (nessuna immagine con un APK vecchio).

**Pubblicare una nuova versione dell'app**: aggiorna `versionName` in `android/version.properties`
(e `minSupportedCode` solo se l'API è cambiata in modo incompatibile con le app precedenti), fai
merge su `master`. Al deploy successivo il sito offre il nuovo APK; le app installate mostrano
"Aggiornamento disponibile", o la schermata bloccante se sono sotto `minSupportedCode`.
L'installazione è manuale: il telefono scarica l'APK dal sito (dietro il login) e Android chiede
conferma; la prima volta va consentita l'installazione dal browser.

Build locale dell'immagine (`docker build .`): senza `--build-context android-app=<cartella>`
l'immagine non contiene l'APK.

## Authelia e Caddy (fuori dal repo)

- **Client OIDC** in Authelia come in `docs/scanner-dvd.md` §4.1: client confidenziale,
  `token_endpoint_auth_method: client_secret_post`, PKCE S256, scope `openid profile groups`,
  `redirect_uris: [<PUBLIC_BASE_URL>/api/auth/callback]`, `consent_mode: implicit`. In Authelia va
  l'hash del segreto (`authelia crypto hash generate pbkdf2`), nello stack il segreto in chiaro
  (segreto `Oidc__ClientSecret`). `OIDC_AUTHORITY` è l'URL pubblico di Authelia.
- **Caddy**: una route `/api/app/*` **prima** del forward auth, senza `forward_auth` (l'app firma le
  richieste da sé e `/api/app/version` è pubblico); tutto il resto resta dietro Authelia come oggi.
  Schema in `docs/scanner-dvd.md` §12.

## Cartelle sul NAS

- `WEB_ROOT`: come oggi (`config.json`, `assets/<collezione>.tc`, `assets/covers/`, `assets/bgm/`).
  Per la modalità DB aggiungi `"apiBase": "./api/"` a `config.json` (vedi `config.example.json`).
- `WEB_ROOT/assets/covers/` è l'unico mount in scrittura (copertine scritte dall'API) e deve
  coincidere con `imgDir` di `config.json`. L'API gira come utente non-root dell'immagine .NET
  (UID/GID 1654, `$APP_UID`):

  ```bash
  sudo chown -R 1654:1654 "$WEB_ROOT/assets/covers"     # oppure un ACL di scrittura per l'UID 1654
  ```

- `DB_DIR`: disco locale del NAS (mai NFS/SMB). Vuota al primo avvio: Postgres crea il ruolo e il
  database `cinema` da `POSTGRES_USER`/`POSTGRES_DB`, poi l'API applica le migrazioni.
- `BACKUP_DIR`: i dump `cinema-AAAAMMGG-HHMM.dump`; includila nei backup del NAS.

## Primo avvio (migrazione dallo stack con il solo nginx)

1. Crea `DB_DIR` e `BACKUP_DIR`, sistema i permessi di `assets/covers/`, imposta le variabili.
2. Il servizio si chiama ora `web` ma tiene `container_name: cinemalometti`: il vecchio container
   (servizio `cinemalometti`) va rimosso prima, altrimenti il nome è già in uso. In Komodo: **Destroy**
   dello stack, poi **Deploy**.
3. Controlla i log: `cinemalometti-api` deve applicare le migrazioni e restare su;
   `cinemalometti-backup` scrive `avvio: dump ogni giorno alle …`.
4. Verifica: `curl -s http://<nas>:<PORT>/api/health` → stato del DB; `/api/me` senza cookie → 401.
5. Login dal sito, poi IMPORTA DA TELLICO (amministratore) per popolare il DB.

## Backup e ripristino

`backup.sh` fa ogni giorno alle `BACKUP_AT` (ora di `TZ`) un `pg_dump -Fc` su file temporaneo, lo
verifica con `pg_restore --list`, lo rinomina e tiene gli ultimi `BACKUP_KEEP`. Gli errori finiscono
nei log del container e il ciclo continua. Con `BACKUP_NOW=1` nell'Environment fa un dump anche a
ogni avvio del container (utile per provare); un dump manuale al volo (fuori dalla rotazione):

```bash
docker exec cinemalometti-backup pg_dump -Fc -f /backup/manuale.dump
```

Ripristino (il container `backup` ha già host, utente e password nell'environment):

```bash
docker stop cinemalometti-api
docker exec cinemalometti-backup pg_restore --clean --if-exists --no-owner -d cinema \
  /backup/cinema-AAAAMMGG-HHMM.dump
docker start cinemalometti-api
```

Le copertine stanno già in `assets/covers/` sul NAS; il `.tc` di Tellico resta un backup
indipendente della collezione.

## Avvio manuale (senza Komodo)

```bash
cd deploy
docker compose -p cinemalometti --env-file /percorso/sicuro/stack.env up -d
```

`stack.env` contiene le variabili normali e `SECRETS_DIR`; i segreti stanno nei file env di quella
cartella. In alternativa metti tutto in `deploy/.env` (gitignorato, chmod 600): Compose lo usa sia per
le variabili sia, tramite `env_file`, come sorgente dei segreti.

`backup.sh` viene montato dalla stessa cartella del compose: il compose va eseguito dal clone del repo.
