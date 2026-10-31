# CineManager per Android (scanner DVD)

App che scansiona il codice a barre di un DVD, cerca il film tramite l'API e lo aggiunge alla
collezione dopo che hai controllato e corretto i dati. Design: [`docs/scanner-dvd.md`](../docs/scanner-dvd.md)
§4.2 e §11; contratto dell'API: [`docs/api.md`](../docs/api.md).

Kotlin, Jetpack Compose, CameraX + ML Kit (modello incluso, funziona offline), OkHttp,
kotlinx.serialization, DataStore. `minSdk` 30, `targetSdk` 36.

| Modulo | Contenuto |
|---|---|
| `core/` | Kotlin/JVM puro, senza Android: JWT delle richieste firmate e prova di possesso (`crypto/`), QR di abbinamento e indirizzi del server (`pairing/`), client dell'API e mappatura degli errori (`api/`), modulo del film dai campi della collezione (`form/`). Test JUnit sulla JVM. |
| `app/` | Interfaccia: chiave nell'Android Keystore (`security/`), abbinamento salvato in DataStore (`data/`), schermate Compose e scanner (`ui/`). |

## Build locale

Servono JDK 17+ e l'SDK Android (platform 36, build-tools 36): Android Studio, oppure i
command-line tools con `sdkmanager "platforms;android-36" "build-tools;36.0.0"`. Indica l'SDK in
`local.properties` (`sdk.dir=/percorso/sdk`, non committato) o con `ANDROID_HOME`.

```bash
cd android
./gradlew assembleDebug assembleRelease testDebugUnitTest lint   # come la CI (android-ci.yml)
./gradlew installDebug                             # su un telefono collegato con il debug USB
```

`testDebugUnitTest` esegue anche i test di `:core`. La build di debug ha `applicationId`
`…cinemanager.debug` (si installa accanto alla release) e accetta server `http://`, utile con
l'API locale: dall'emulatore l'host è `http://10.0.2.2:5080/api`, da un telefono in LAN
`http://<ip-del-pc>:5080/api` (l'API deve ascoltare su quell'interfaccia, es.
`ASPNETCORE_URLS=http://0.0.0.0:5080`). La release accetta solo `https://`.

Per abbinare l'app di debug all'API locale: crea il codice con
`curl -s -X POST -H 'X-CM-Request: 1' http://localhost:5080/api/pairing`, poi incolla nell'app
(ABBINAMENTO › "Incolla il contenuto") il JSON `{"v":1,"api":"http://10.0.2.2:5080/api","code":"<code>"}`,
oppure inquadra il QR del pannello ARRIVI del sito in sviluppo.

## Test

- `core`: firma ES256 (DER del Keystore → `R||S`), JWT confrontato con i vettori prodotti da
  `api/tools/sign-request` (payload identico byte per byte; nell'header .NET scrive `+` come
  `+`, stesso JSON), verifica con una trascrizione dei controlli di `DeviceTokens.cs`,
  prova di possesso, QR, client contro `MockWebServer` (htu = request-target, `bh`, `jti` nuovo
  a ogni richiesta, 401/403/409/426/429), modulo dalla bozza e ritorno, espansione UPC-E → UPC-A.
- `app`: messaggi d'errore, decisioni dopo un errore (riabbinamento solo per chiave invalidata o
  mancante, "Riprova", scollegamento solo locale), classificazione delle eccezioni del Keystore.
- **End-to-end facoltativo** contro l'API vera (stessa logica di firma del server): con l'API
  avviata in Development (`cd api/CineManager.Api && dotnet run`)

  ```bash
  CM_E2E_API=http://localhost:5080 ./gradlew :core:test --tests '*EndToEndTest*' --rerun
  ```

  abbina una chiave software, fa `me`, `fields`, `lookup` firmate, poi scollega e verifica il
  401 `device_revoked`. Senza la variabile il test viene saltato. In CI lo esegue il job `e2e` di
  `android-ci.yml` (API e Postgres avviati nel job), anche quando cambiano
  `api/CineManager.Api/Auth/**`, `api/CineManager.Api/Devices/**` o `docs/api.md`.

## Versione

`version.properties` è l'unica fonte: `versionName` (a mano a ogni rilascio) e
`minSupportedCode`. `versionCode = major*10000 + minor*100 + patch` (es. 1.3.0 → 10300) viene
calcolato da `app/build.gradle.kts` e finisce nel claim `av` delle richieste firmate;
`./gradlew -q :app:printVersion` stampa `versionName`, `versionCode` e `minSupportedCode`, ed è
ciò che il deploy usa per `version.json` (la build fallisce se `minSupportedCode` supera il
`versionCode`). Alza
`minSupportedCode` solo quando l'API cambia in modo incompatibile: l'API risponde 426 alle app
più vecchie e l'app mostra "Aggiornamento necessario".

## Firma della release

La keystore di release non sta nel repo (`.gitignore` esclude `*.jks`, `*.keystore`, `*.p12`).
Gradle firma `assembleRelease` solo se trova queste variabili d'ambiente, altrimenti produce un
APK non firmato:

| Variabile | Contenuto |
|---|---|
| `CM_RELEASE_KEYSTORE` | percorso del file `.jks` |
| `CM_RELEASE_KEYSTORE_PASSWORD` | password della keystore |
| `CM_RELEASE_KEY_ALIAS` | alias della chiave |
| `CM_RELEASE_KEY_PASSWORD` | password della chiave |

In CI le valorizza il job `android` di `.github/workflows/deploy.yml` dai GitHub Secrets
(nomi e procedura in [`deploy/README.md`](../deploy/README.md#app-android-apk-firmato)); il file
della keystore decodificato viene cancellato a fine step anche se la build fallisce. Usa
**sempre la stessa keystore**: un APK firmato con un'altra chiave non si installa sopra quello
esistente (bisogna disinstallare e rifare l'abbinamento).

Per accorgersene prima del deploy, imposta la variabile di repository (Settings › Secrets and
variables › Actions › Variables; va bene anche un secret con lo stesso nome)
`ANDROID_CERT_SHA256` con l'impronta SHA-256 del certificato di firma: il job `android` la
confronta con quella dell'APK firmato e si ferma se sono diverse. Maiuscole, minuscole e `:` non
contano. Senza la variabile il job scrive un avviso nel log e prosegue. L'impronta si legge con

```bash
keytool -list -v -keystore release.jks -alias <alias> | grep SHA256
# oppure, da un APK firmato:
apksigner verify --print-certs cinemanager.apk | grep 'SHA-256'
```

La release usa R8 (`isMinifyEnabled`) e include solo le librerie native ARM (telefoni reali).
Senza le variabili di firma `assembleRelease` produce `app-release-unsigned.apk`: la CI dei PR lo
costruisce comunque per verificare R8.

## Non ancora implementato

- Aggiornamento integrato (download dell'APK dall'app e `PackageInstaller`, §11.1 livello 2): il
  pulsante apre il download nel browser.
- Coda offline delle scansioni (WorkManager, §11, facoltativa).
- Correzione o eliminazione dall'app di un arrivo appena inviato: si fa dal pannello ARRIVI del sito.
