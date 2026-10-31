# Deploy dello stack `cinemalometti`

Guida passo passo per mettere in piedi sul NAS lo stack Komodo con sito, API, database e backup.
I segreti si generano da Windows (PowerShell), i comandi sul NAS si lanciano via SSH.

Lo stack ([`compose.yml`](compose.yml)) ha quattro container; solo `web` pubblica una porta:

| Container | Cosa fa |
|---|---|
| `cinemalometti` (servizio `web`) | nginx: il sito, i dati del NAS, inoltra `/api/` all'API, serve l'APK in `/app/` |
| `cinemalometti-api` | l'API .NET; all'avvio crea o aggiorna le tabelle del DB |
| `cinemalometti-db` | Postgres 17 |
| `cinemalometti-backup` | dump notturno del DB, tiene gli ultimi 14 |

Le immagini le pubblica GitHub Actions a ogni push su `master`; Komodo aggiorna lo stack quando escono.

---

## Primo deploy

### 1. Cartelle sul NAS

Via SSH sul NAS. Sostituisci i percorsi con i tuoi; `WEB_ROOT` è la cartella che usi già oggi per il sito.

```sh
WEB_ROOT=/percorso/cinemalometti                  # quella di oggi, con config.json e assets/
sudo mkdir -p /percorso/cinemalometti-db /percorso/cinemalometti-backup
sudo chown -R 1654:1654 "$WEB_ROOT/assets/covers"   # l'API ci scrive le copertine (utente 1654)
```

- La cartella del DB deve stare su un disco locale del NAS, non su una condivisione di rete.
- In `WEB_ROOT/config.json` aggiungi `"apiBase": "./api/"`: il sito legge la collezione dal DB invece
  che dal `.tc` (esempio in [`config.example.json`](../config.example.json)).

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
(passo 5) con il nome indicato.

**Password del database**: lancia il comando e salva l'output come `CINEMA_DB_PASSWORD`.

```powershell
New-Secret
```

**Segreto del client OIDC**: lancia il comando e salva l'output come `CINEMA_OIDC_SECRET`. Ti serve
anche al passo 3.

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

Authelia vuole l'**hash** del segreto OIDC, non il segreto. Sul NAS, via SSH (sostituisci
`SEGRETO` con il valore di `CINEMA_OIDC_SECRET`):

```sh
docker run --rm authelia/authelia:latest \
  authelia crypto hash generate pbkdf2 --variant sha512 --password 'SEGRETO'
```

La riga `Digest: $pbkdf2-sha512$...` è il valore di `client_secret`. Nella configurazione di Authelia
aggiungi il client:

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
        reverse_proxy <ip-nas>:8091
    }
    handle {
        forward_auth <authelia> { ... }       # come oggi
        reverse_proxy <ip-nas>:8091
    }
}
```

### 5. Stack in Komodo

**Secret.** In *Settings → Variables* crea una variabile per ogni valore del passo 2, con il flag
**Secret** attivo: `CINEMA_DB_PASSWORD`, `CINEMA_OIDC_SECRET`, `CINEMA_DP_CERT`,
`CINEMA_DP_CERT_PASSWORD`, `CINEMA_TMDB_TOKEN`.

**Stack.** Modifica lo stack `cinemalometti` esistente:

| Campo | Valore |
|---|---|
| Repo / Branch | `mcauzzi/MovieCarousel` / `master` |
| Run Directory | `deploy` |
| File Paths | `compose.yml` |
| Auto Update | attivo (aggiorna quando escono immagini nuove) |

**Environment.** Sostituiscilo con questo, completando i valori tra `< >`:

```ini
# Cartelle sul NAS (passo 1)
WEB_ROOT = /percorso/cinemalometti
DB_DIR = /percorso/cinemalometti-db
BACKUP_DIR = /percorso/cinemalometti-backup

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

### 6. Deploy

1. **Destroy** dello stack, poi **Deploy**. Solo la prima volta: il vecchio servizio si chiamava
   `cinemalometti` e ora si chiama `web`, quindi il vecchio container va tolto prima.
2. Nei log:
   - `cinemalometti-api` deve applicare le migrazioni e restare acceso;
   - `cinemalometti-backup` scrive `avvio: dump ogni giorno alle 03:30`.
3. Prova dal NAS:
   - `curl -s http://localhost:8091/api/health` deve rispondere con lo stato del DB;
   - `curl -si http://localhost:8091/api/me` deve rispondere `401`.
4. Apri il sito, fai login, e da **ARRIVI → IMPORTA** (serve essere amministratore) carica il `.tc` di
   Tellico per riempire il DB.

Se l'API si ferma subito, il log dice quale segreto manca o è sbagliato.

---

## App Android

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
verifica e tiene gli ultimi 14. Includi `BACKUP_DIR` nei backup del NAS. Le copertine sono già in
`assets/covers/`.

Dump manuale (fuori dalla rotazione):

```sh
docker exec cinemalometti-backup pg_dump -Fc -f /backup/manuale.dump
```

Ripristino:

```sh
docker stop cinemalometti-api
docker exec cinemalometti-backup pg_restore --clean --if-exists --no-owner -d cinema \
  /backup/cinema-AAAAMMGG-HHMM.dump
docker start cinemalometti-api
```

---

## Riferimento variabili

**Obbligatorie**

| Variabile | Cosa |
|---|---|
| `WEB_ROOT` | cartella del sito sul NAS (`config.json`, `assets/`) |
| `DB_DIR` | dati di Postgres, disco locale |
| `BACKUP_DIR` | dump notturni |
| `PUBLIC_BASE_URL` | indirizzo pubblico del sito (`https://<host-sito>`) |
| `PROXY_IP` | IP da cui Caddy raggiunge il NAS (serve all'API per l'IP reale dei client) |
| `OIDC_AUTHORITY` | indirizzo pubblico di Authelia |
| `OIDC_CLIENT_ID` | client creato in Authelia |
| `OIDC_ADMIN_GROUP` | gruppo LLDAP degli amministratori |

**Segreti**

| Variabile | Cosa |
|---|---|
| `POSTGRES_PASSWORD` | password del DB (qualsiasi carattere) |
| `Oidc__ClientSecret` | segreto OIDC in chiaro (in Authelia va l'hash) |
| `DataProtection__CertificateBase64` | certificato PFX in base64 |
| `DataProtection__CertificatePassword` | password del PFX |
| `Tmdb__ApiToken` | token TMDb |
| `Lookup__UpcItemDbKey` | facoltativo, chiave a pagamento di UPCitemdb |

**Facoltative** (default tra parentesi)

| Variabile | Cosa |
|---|---|
| `PORT` (8091) | porta sul NAS a cui punta Caddy |
| `OIDC_USER_GROUP` (vuoto) | gruppo LLDAP di chi può entrare; vuoto = tutti |
| `STACK_SUBNET` (172.31.91.0/24) | subnet della rete dello stack; deve essere libera sul NAS |
| `DEVICE_MAX_OWNER_INACTIVE_DAYS` (90) | dopo quanti giorni senza login i telefoni di un utente si bloccano |
| `LOOKUP_PROVIDERS` (upcitemdb) | servizi per cercare l'EAN |
| `TELLICO_BARCODE_FIELD` (ean) | nome del campo codice a barre in Tellico |
| `BACKUP_AT` (03:30), `BACKUP_KEEP` (14), `TZ` (Europe/Rome) | ora del backup, quanti tenerne, fuso orario |
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

Scrivi i valori sempre tra apici singoli.

### Note

- Serve Docker Compose 2.24 o successivo.
- Postgres legge la password solo quando crea il DB. Per cambiarla dopo: aggiorna il Secret e lancia
  `docker exec cinemalometti-db psql -U cinema -c "ALTER ROLE cinema PASSWORD 'nuova'"`.
- Con i Secret di Komodo anche `db` e `backup` ricevono tutto l'Environment, segreti dell'API compresi.
  Con i file env vedono solo `db.env`.
- Senza Komodo: dal clone del repo, `cd deploy`, metti tutte le variabili in `deploy/.env` (è
  ignorato da git) e lancia `docker compose -p cinemalometti up -d`.
- Build locale dell'immagine del sito (`docker build .`): senza l'APK passato dalla CI l'immagine non
  contiene l'app.
