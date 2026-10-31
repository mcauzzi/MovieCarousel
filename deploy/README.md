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
con i test, poi il sito); Komodo aggiorna lo stack quando escono. Design completo:
`docs/scanner-dvd.md` §4.1 e §12.

## Segreti (file env sul NAS)

I segreti non stanno nell'Environment di Komodo né passano dall'interpolazione del compose: il compose
li carica con `env_file` da due file nella cartella `SECRETS_DIR` del NAS, fuori dal repo, e arrivano
ai container così come sono (qualsiasi carattere).

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

Metti i valori tra **apici singoli**: così Compose non interpreta `$` o altri caratteri speciali.
L'API usa `POSTGRES_PASSWORD` come password del DB inserendola nella connection string in codice, quindi
non ci sono vincoli sui caratteri. Postgres legge la password solo al primo avvio (quando crea il DB):
per cambiarla dopo serve anche `ALTER ROLE cinema PASSWORD '...'`.

## Variabili dell'Environment Komodo

Nessun segreto. L'elenco completo, con i default, è nel commento in testa a `compose.yml`.

- Obbligatorie: `WEB_ROOT`, `DB_DIR`, `BACKUP_DIR`, `SECRETS_DIR`, `PUBLIC_BASE_URL`, `PROXY_IP`,
  `OIDC_AUTHORITY`, `OIDC_CLIENT_ID`, `OIDC_ADMIN_GROUP`.
- Facoltative: `PORT` (8091), `STACK_SUBNET` (172.31.91.0/24), `OIDC_USER_GROUP`,
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
base64 -w0 dp.pfx          # → DataProtection__CertificateBase64 in api.env (<password> → DataProtection__CertificatePassword)
shred -u dp.key            # dp.pfx va conservato fuori dal NAS insieme alla password
```

## Authelia e Caddy (fuori dal repo)

- **Client OIDC** in Authelia come in `docs/scanner-dvd.md` §4.1: client confidenziale,
  `token_endpoint_auth_method: client_secret_post`, PKCE S256, scope `openid profile groups`,
  `redirect_uris: [<PUBLIC_BASE_URL>/api/auth/callback]`, `consent_mode: implicit`. In Authelia va
  l'hash del segreto (`authelia crypto hash generate pbkdf2`), nello stack il segreto in chiaro
  (`Oidc__ClientSecret` in api.env). `OIDC_AUTHORITY` è l'URL pubblico di Authelia.
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

`backup.sh` viene montato dalla stessa cartella del compose: il compose va eseguito dal clone del repo.
