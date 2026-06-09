# Deploy automatico su NAS Synology

A ogni push su `master`, il workflow `.github/workflows/deploy.yml` builda il sito
e lo copia nella cartella web del NAS. Il lavoro viene eseguito da un **runner
GitHub Actions self-hosted** che gira in un container Docker sul NAS: è il runner
a contattare GitHub (polling in uscita), quindi il NAS non espone alcuna porta.

Il percorso reale della cartella web e il token di accesso vivono **solo** nel
`docker-compose.yml` compilato sul NAS — su GitHub non compaiono mai: il workflow
copia in `/deploy`, un alias interno al container.

## Setup (una tantum)

### 1. Crea il PAT GitHub

1. GitHub → Settings → Developer settings → Personal access tokens → **Tokens (classic)** → Generate new token
2. Scope: solo **`repo`**
3. Scadenza a piacere (a scadenza basta rigenerarlo e aggiornare il compose sul NAS)

### 2. Prepara il progetto in Container Manager

1. Sul NAS crea una cartella per il progetto, es. `/volume1/docker/cinemanager-runner/`
2. Copia dentro questo `docker-compose.yml` e sostituisci i placeholder:
   - `<PAT_GITHUB>` → il token appena creato
   - `<PERCORSO_CARTELLA_WEB>` → il percorso assoluto della cartella web
     (quella che contiene `index.html`, `config.json`, `assets/`)
3. Container Manager → **Progetto** → **Crea**:
   - Percorso: la cartella del punto 1
   - Sorgente: usa il `docker-compose.yml` esistente
4. Avvia il progetto

### 3. Verifica il runner

Su GitHub: repo → Settings → Actions → **Runners**. Entro un minuto deve
comparire `nas-cinemanager` con stato **Idle** e label `nas`.

### 4. Primo deploy

Push su `master` (o repo → Actions → "Deploy NAS" → **Run workflow**).
Il job deve risultare verde e il sito aggiornato. Verifica che `config.json`,
`assets/collezione.tc` e `assets/covers/` siano rimasti intatti.

## Cosa copia il deploy

| File | Azione |
|---|---|
| `dist/index.html` | copiato nella web root |
| `dist/assets/index-*.js`, `index-*.css` | copiati in `assets/`, i bundle vecchi vengono rimossi |
| `dist/config.json` | **non copiato** — la fonte di verità è quella sul NAS |
| `collezione.tc`, `covers/` | mai toccati |

Se la build o il type-check falliscono, non viene copiato nulla: il sito resta
alla versione precedente e il workflow appare rosso su GitHub.

## Manutenzione

- **PAT scaduto / runner offline**: rigenera il token, aggiorna `ACCESS_TOKEN`
  nel compose sul NAS e riavvia il progetto in Container Manager.
- **Aggiornare il runner**: Container Manager → progetto → ricrea con pull
  dell'immagine (`myoung34/github-runner:latest`). L'auto-update interno è
  disattivato (`DISABLE_AUTO_UPDATE`) per evitare riavvii a sorpresa.
- Il runner è registrato sul solo repo `MovieCarousel` e il repo è privato:
  nessun codice di terzi può raggiungere il NAS tramite il runner.
