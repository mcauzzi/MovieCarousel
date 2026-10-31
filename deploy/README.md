# Deploy dello stack

Guida passo passo per mettere in piedi sul NAS lo stack Komodo con sito, API, database e backup.
I segreti si generano da Windows (PowerShell), i comandi sul NAS si lanciano via SSH.

Lo stack ([`compose.yml`](compose.yml)) ha quattro servizi; solo `web` pubblica una porta. I container
prendono il nome dello stack Komodo: `<stack>-web-1`, `<stack>-api-1` e così via.

| Servizio | Cosa fa |
|---|---|
| `web` | nginx: il sito, i dati del NAS, inoltra `/api/` all'API, serve l'APK in `/app/` |
| `api` | l'API .NET; all'avvio crea o aggiorna le tabelle del DB |
| `db` | Postgres 17 |
| `backup` | dump notturno del DB, tiene gli ultimi 14 |

Le immagini le pubblica GitHub Actions a ogni push su `master`; Komodo aggiorna lo stack quando escono.

---

## Primo deploy

### 1. Docker Compose e cartelle sul NAS

Via SSH sul NAS. Prima controlla la versione di Compose: serve la **2.24 o successiva**.

```sh
docker compose version
```

Se Komodo Periphery gira in un container, conta la sua versione:
`docker exec <container-periphery> docker compose version`. Se è più vecchia:

- Periphery in container: aggiorna la sua immagine (porta con sé un Compose recente).
- Compose del NAS (Synology Container Manager può avere la 2.20): aggiorna Container Manager dal
  Centro pacchetti; se resta vecchio, installa il plugin ufficiale e riprova `docker compose version`:

  ```sh
  sudo mkdir -p /usr/local/lib/docker/cli-plugins
  sudo curl -fSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  ```

Poi le cartelle. Sostituisci i percorsi con i tuoi; `WEB_ROOT` è la cartella che usi già oggi per il sito.

```sh
WEB_ROOT=/percorso/sito                   # quella di oggi, con config.json
COVERS_DIR=<cartella-copertine>           # relativa a WEB_ROOT, la stessa di imgDir in config.json
sudo mkdir -p /percorso/db /percorso/backup "$WEB_ROOT/$COVERS_DIR"
sudo chown -R 1654:1654 "$WEB_ROOT/$COVERS_DIR"   # l'API ci scrive le copertine (utente 1654)
```

- `COVERS_DIR` è il percorso che hai in `imgDir` di `config.json`, senza `./` iniziale e senza `/`
  finale: con `"imgDir": "./assets/copertine/"` è `assets/copertine`.
- Se la cartella è in una condivisione Synology con ACL, `chown` può non bastare: dai a UID 1654 la
  scrittura dalle ACL, oppure tieni un gruppo comune con `g+w` se vuoi scriverci anche dalla condivisione.
- La cartella del DB deve stare su un disco locale del NAS, non su una condivisione di rete.
- Non toccare ancora `config.json`: `apiBase` si aggiunge dopo il deploy (passo 6).

### 2. Genera i segreti (Windows, PowerShell)

Apri **PowerShell** (va bene quella di Windows) e incolla questo blocco: definisce una funzione
che genera una stringa casuale di 64 caratteri esadecimali.

```powershell
function New-Secret {
    $b = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    -join ($b | ForEach-Object { $_.ToString('x2') })
}
```

Poi, nella stessa finestra, genera i valori uno alla volta. Ognuno va salvato come Secret in Komodo
(passo 5) con il nome indicato. Il segreto OIDC lo genera Authelia al passo 3.

I valori generati qui contengono solo lettere, cifre e `+/=`. Se scegli un segreto a mano, evita `$`:
Compose lo leggerebbe come una variabile.

**Password del database**: lancia il comando e salva l'output come `CINEMA_DB_PASSWORD`.

```powershell
New-Secret
```

**Certificato Data Protection**: cifra le chiavi del cookie di login salvate nel DB. Se lo perdi
non perdi dati, devi solo rifare il login.

```powershell
$certPassword = New-Secret
$cert = New-SelfSignedCertificate -Subject 'CN=cinemanager-dp' -KeyAlgorithm RSA -KeyLength 3072 `
    -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(10) -CertStoreLocation Cert:\CurrentUser\My
Export-PfxCertificate -Cert $cert -FilePath "$HOME\cinemanager-dp.pfx" `
    -Password (ConvertTo-SecureString $certPassword -AsPlainText -Force) | Out-Null
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\cinemanager-dp.pfx")) | Set-Clipboard
```

- Ora negli appunti c'è il certificato: incollalo come `CINEMA_DP_CERT` (è lungo qualche migliaio di
  caratteri, è normale).
- Poi scrivi `$certPassword` e salva l'output come `CINEMA_DP_CERT_PASSWORD`.
- Tieni `cinemanager-dp.pfx` (nella tua cartella utente) e la sua password in un posto sicuro, per
  esempio nel password manager.

**Token TMDb**: non si genera. Dal tuo account su themoviedb.org, *Impostazioni → API*, copia il
token "API Read Access Token" (inizia con `eyJ`) e salvalo come `CINEMA_TMDB_TOKEN`.

### 3. Client OIDC in Authelia

Authelia genera il segreto e il suo **hash** in un colpo solo. Sul NAS, via SSH (oppure
`docker exec <container-authelia> authelia crypto hash ...` nel container che hai già):

```sh
docker run --rm authelia/authelia:latest authelia crypto hash generate pbkdf2 --variant sha512 \
  --random --random.length 72 --random.charset alphanumeric
```

- `Random Password: ...` è il segreto in chiaro: salvalo come `CINEMA_OIDC_SECRET` (passo 5).
- `Digest: $pbkdf2-sha512$...` è il valore di `client_secret` in Authelia.

Nella configurazione di Authelia aggiungi il client:

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: '<client-id>'                  # lo stesso che metti in OIDC_CLIENT_ID
        client_name: 'CineManager'
        client_secret: '$pbkdf2-sha512$...'       # il Digest di sopra
        public: false
        authorization_policy: '<policy>'
        consent_mode: implicit
        require_pkce: true
        pkce_challenge_method: S256
        redirect_uris:
          - 'https://<host-sito>/api/auth/callback'
        scopes: [openid, profile, groups]
        response_types: [code]
        grant_types: [authorization_code]
        token_endpoint_auth_method: client_secret_post
```

Riavvia Authelia. Chi può entrare e chi è amministratore lo decidono i gruppi di LLDAP
(`OIDC_USER_GROUP`, `OIDC_ADMIN_GROUP` al passo 5).

### 4. Caddy

L'app Android firma da sé le sue richieste, quindi `/api/app/*` deve arrivare al NAS **senza**
passare da Authelia; tutto il resto resta dietro il forward auth come oggi. La route va messa
**prima** di quella con `forward_auth`:

```caddy
<host-sito> {
    handle /api/app/* {
        reverse_proxy <ip-nas>:<porta>
    }
    handle {
        forward_auth <authelia> { ... }       # come oggi
        reverse_proxy <ip-nas>:<porta>
    }
}
```

**Porta solo per Caddy.** Di default la porta è aperta su tutte le interfacce del NAS: chi è in LAN
può aprire `http://<ip-nas>:<porta>` e saltare Authelia. Chiudila in uno dei due modi:

- **consigliato**: nel firewall del NAS (*Pannello di controllo → Sicurezza → Firewall*) una regola
  che accetta `<porta>` solo da `PROXY_IP` e una che la nega a tutti gli altri;
- oppure `BIND_ADDR = <ip-nas>` nell'Environment (passo 5), se Caddy raggiunge il NAS da un'interfaccia
  diversa da quella della LAN.

Prova da un altro PC della LAN: `curl -m 5 http://<ip-nas>:<porta>/` non deve rispondere. Se risponde,
il firewall non filtra le porte pubblicate da Docker: usa `BIND_ADDR`, se la tua rete lo permette.
Così all'API arrivano solo richieste passate da Caddy, e l'IP reale che legge da `X-Forwarded-For` è
quello scritto da Caddy, non uno inventato da un client entrato dal gateway di Docker.

### 5. Stack in Komodo

**Secret.** In *Settings → Variables* crea una variabile per ogni valore del passo 2, con il flag
**Secret** attivo: `CINEMA_DB_PASSWORD`, `CINEMA_OIDC_SECRET`, `CINEMA_DP_CERT`,
`CINEMA_DP_CERT_PASSWORD`, `CINEMA_TMDB_TOKEN`.

**Stack.** Modifica lo stack esistente del sito:

| Campo | Valore |
|---|---|
| Repo / Branch | `mcauzzi/MovieCarousel` / `master` |
| Run Directory | `deploy` |
| File Paths | `compose.yml` |
| Auto Update | attivo (aggiorna quando escono immagini nuove) |

**Immagini.** Komodo scarica `ghcr.io/mcauzzi/moviecarousel` e `ghcr.io/mcauzzi/moviecarousel-api`
senza login, quindi tutti e due i package devono essere pubblici, e un package nuovo nasce privato.
Dopo il primo push su `master`, prova dal NAS:

```sh
docker pull ghcr.io/mcauzzi/moviecarousel:latest
docker pull ghcr.io/mcauzzi/moviecarousel-api:latest
```

Per ogni immagine che risponde `unauthorized` o `denied`: su GitHub apri *il tuo profilo → Packages →
il package → Package settings → Change visibility* e scegli **Public**. In alternativa lasciali privati:
in Komodo aggiungi un account registry per `ghcr.io` con un token GitHub (classic) con il solo permesso
`read:packages` e selezionalo nello stack.

**Environment.** Sostituiscilo con questo, completando i valori tra `< >`:

```ini
# Cartelle sul NAS (passo 1)
WEB_ROOT = /percorso/sito
COVERS_DIR = <cartella-copertine>
DB_DIR = /percorso/db
BACKUP_DIR = /percorso/backup

# Porta sul NAS a cui punta Caddy e fuso orario (ora del backup)
PORT = <porta>
# BIND_ADDR = <ip-nas>        # facoltativo, vedi passo 4
TZ = <fuso orario, es. Europe/Berlin>

# Indirizzi
PUBLIC_BASE_URL = https://<host-sito>
PROXY_IP = <ip da cui Caddy raggiunge il NAS>
OIDC_AUTHORITY = https://<host-auth>
OIDC_CLIENT_ID = <client-id>
OIDC_USER_GROUP = <gruppo-utenti>
OIDC_ADMIN_GROUP = <gruppo-admin>

# Segreti: rimandano ai Secret creati sopra
POSTGRES_PASSWORD = [[CINEMA_DB_PASSWORD]]
Oidc__ClientSecret = [[CINEMA_OIDC_SECRET]]
DataProtection__CertificateBase64 = [[CINEMA_DP_CERT]]
DataProtection__CertificatePassword = [[CINEMA_DP_CERT_PASSWORD]]
Tmdb__ApiToken = [[CINEMA_TMDB_TOKEN]]
```

Le altre variabili hanno un default; l'elenco completo è in [Riferimento](#riferimento-variabili).

> La Run Directory deve essere `deploy`: Komodo scrive l'Environment in `deploy/.env` e i container
> leggono i segreti da lì. Se `OIDC_USER_GROUP` resta vuoto, entra chiunque abbia un account Authelia.
> Compose interpreta `$` anche in quel file: un `$` vero in un valore (o in un Secret) va scritto `$$`.

### 6. Deploy

1. **Destroy** dello stack, poi **Deploy**. Solo la prima volta: il vecchio container del sito ha un
   altro nome e occupa già la porta, quindi va tolto prima.
2. Nei log:
   - `api` deve applicare le migrazioni e restare acceso;
   - `backup` scrive `avvio: dump ogni giorno alle 03:30`.
3. Prova dal NAS (con `BIND_ADDR` usa `<ip-nas>` al posto di `localhost`):
   - `curl -s http://localhost:<porta>/api/health` deve rispondere con lo stato del DB;
   - `curl -si http://localhost:<porta>/api/me` deve rispondere `401`.
4. Solo ora, in `WEB_ROOT/config.json` aggiungi `"apiBase": "./api/"`: il sito legge la collezione dal
   DB invece che dal `.tc` (esempio in [`config.example.json`](../config.example.json)). Prima del
   deploy il sito vecchio non avrebbe avuto un'API a cui chiedere.
5. Apri il sito, fai login, e da **ARRIVI → IMPORTA** (serve essere amministratore) carica il `.tc` di
   Tellico per riempire il DB.

Se l'API si ferma subito, il log dice quale segreto manca o è sbagliato.

---

## App Android (APK firmato)

GitHub Actions compila e firma l'APK e lo mette nell'immagine del sito: si scarica da
**ARRIVI → TELEFONO**. Senza i secret qui sotto il sito funziona lo stesso, ma senza APK ("App non
disponibile").

### Keystore di firma (una volta sola)

Serve una sola keystore per tutta la vita dell'app: se la perdi, gli aggiornamenti non si
installano sopra l'app esistente. In PowerShell, con Android Studio installato:

```powershell
& "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -genkeypair -keystore release.jks `
    -alias cinemanager -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=CineManager"
[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path release.jks))) | Set-Clipboard
```

keytool chiede una password: usa quella anche come password della chiave. Conserva `release.jks` e la
password nel password manager.

### Secret su GitHub

Nel repository, *Settings → Secrets and variables → Actions → New repository secret*:

| Secret | Valore |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | quello che è negli appunti dopo il comando sopra |
| `ANDROID_KEYSTORE_PASSWORD` | la password scelta |
| `ANDROID_KEY_ALIAS` | `cinemanager` |
| `ANDROID_KEY_PASSWORD` | la stessa password |

### Nuova versione dell'app

1. In `android/version.properties` aumenta `versionName`. Aumenta `minSupportedCode` solo se le
   versioni vecchie non funzionano più con l'API.
2. Merge su `master`.

Dopo il deploy le app installate mostrano "Aggiornamento disponibile" (o una schermata bloccante se
sono sotto `minSupportedCode`). L'aggiornamento si installa a mano: il telefono scarica l'APK dal
sito e Android chiede conferma.

---

## Backup e ripristino

Ogni notte alle 03:30 `backup.sh` salva un dump in `BACKUP_DIR` (`cinema-AAAAMMGG-HHMM.dump`), lo
verifica e tiene gli ultimi 14. Includi `BACKUP_DIR` nei backup del NAS. Le copertine sono già nella
cartella del sito (`COVERS_DIR`).

I comandi qui sotto passano dal container `db`, che dentro di sé accetta l'utente `cinema` senza
password. Lanciali da root (`sudo -i`): i dump in `BACKUP_DIR` sono leggibili solo da root.

Dump manuale (fuori dalla rotazione):

```sh
docker exec <stack>-db-1 pg_dump -U cinema -Fc cinema > /percorso/backup/manuale.dump
```

Ripristino (l'API va fermata prima e riavviata dopo):

```sh
docker stop <stack>-api-1
docker exec -i <stack>-db-1 pg_restore -U cinema -d cinema --clean --if-exists --no-owner \
  < /percorso/backup/cinema-AAAAMMGG-HHMM.dump
docker start <stack>-api-1
```

---

## Riferimento variabili

**Obbligatorie**

| Variabile | Cosa |
|---|---|
| `WEB_ROOT` | cartella del sito sul NAS (`config.json`, collezione, copertine) |
| `COVERS_DIR` | cartella delle copertine relativa a `WEB_ROOT`, la stessa di `imgDir` in `config.json` |
| `DB_DIR` | dati di Postgres, disco locale |
| `BACKUP_DIR` | dump notturni |
| `PUBLIC_BASE_URL` | indirizzo pubblico del sito (`https://<host-sito>`) |
| `PROXY_IP` | IP da cui Caddy raggiunge il NAS (serve all'API per l'IP reale dei client) |
| `OIDC_AUTHORITY` | indirizzo pubblico di Authelia |
| `OIDC_CLIENT_ID` | client creato in Authelia |
| `OIDC_ADMIN_GROUP` | gruppo LLDAP degli amministratori |
| `PORT` | porta sul NAS a cui punta Caddy |

**Segreti**

| Variabile | Cosa |
|---|---|
| `POSTGRES_PASSWORD` | password del DB (niente `$`, o vedi sotto) |
| `Oidc__ClientSecret` | segreto OIDC in chiaro (in Authelia va l'hash) |
| `DataProtection__CertificateBase64` | certificato PFX in base64 |
| `DataProtection__CertificatePassword` | password del PFX |
| `Tmdb__ApiToken` | token TMDb |
| `Lookup__UpcItemDbKey` | facoltativo, chiave a pagamento di UPCitemdb |

**Facoltative** (default tra parentesi)

| Variabile | Cosa |
|---|---|
| `BIND_ADDR` (0.0.0.0) | indirizzo del NAS su cui aprire `PORT`; 0.0.0.0 = tutte le interfacce (passo 4) |
| `OIDC_USER_GROUP` (vuoto) | gruppo LLDAP di chi può entrare; vuoto = tutti |
| `STACK_SUBNET` (172.31.91.0/24) | subnet della rete dello stack; deve essere libera sul NAS |
| `DEVICE_MAX_OWNER_INACTIVE_DAYS` (90) | dopo quanti giorni senza login i telefoni di un utente si bloccano |
| `LOOKUP_PROVIDERS` (upcitemdb) | servizi per cercare l'EAN |
| `TELLICO_BARCODE_FIELD` (ean) | nome del campo codice a barre in Tellico |
| `BACKUP_AT` (03:30), `BACKUP_KEEP` (14), `TZ` (UTC) | ora del backup, quanti tenerne, fuso orario |
| `BACKUP_NOW` (0) | 1 = fa un backup anche a ogni avvio (per provare) |
| `SECRETS_DIR` | solo per l'alternativa sotto |

### Alternativa: segreti in file sul NAS

Invece dei Secret di Komodo puoi mettere i segreti in due file in una cartella del NAS, e indicarla
con `SECRETS_DIR` nell'Environment. Se un segreto c'è in tutti e due i posti, vince il file.

```sh
sudo install -d -m 700 /percorso/segreti
sudo install -m 600 /dev/null /percorso/segreti/db.env
sudo install -m 600 /dev/null /percorso/segreti/api.env
```

- `db.env`: `POSTGRES_PASSWORD='...'`
- `api.env`: una riga per ognuno degli altri segreti, es. `Tmdb__ApiToken='...'`

Scrivi i valori sempre tra apici singoli: così anche un `$` resta com'è (il valore non può contenere
a sua volta un apice singolo).

### Note

- Serve Docker Compose 2.24 o successivo (passo 1).
- Postgres legge la password solo quando crea il DB. Per cambiarla dopo: aggiorna il Secret e lancia
  `docker exec <stack>-db-1 psql -U cinema -c "ALTER ROLE cinema PASSWORD 'nuova'"`.
- Con i Secret di Komodo anche `db` e `backup` ricevono tutto l'Environment, segreti dell'API compresi.
  Con i file env vedono solo `db.env`.
- Senza Komodo: dal clone del repo, `cd deploy`, metti tutte le variabili in `deploy/.env` (è
  ignorato da git) e lancia `docker compose -p <stack> up -d`.
- Build locale dell'immagine del sito: `docker build .` funziona così com'è, ma senza l'APK
  l'immagine non contiene l'app. Per includerlo: `docker build --build-context android-app=<cartella> .`,
  con dentro `cinemanager.apk` e `version.json` (è quello che fa la CI).
