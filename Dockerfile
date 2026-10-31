# APK Android firmato + version.json (docs/scanner-dvd.md §11.1). In CI deploy.yml passa la
# cartella con --build-context android-app=<dir>; senza (build locale, keystore non configurata)
# resta questo stage vuoto e /app/ non contiene nulla.
FROM scratch AS android-app

# Build: typecheck + bundle Vite
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Il contesto è filtrato da .dockerignore: niente api/, android/, docs/, dati locali
COPY . .
RUN npm run typecheck && npm run build

# Runtime: nginx serve il bundle dall'immagine e i dati (config.json,
# collezione .tc, covers/, bgm/) dalla cartella del NAS montata in /srv/data;
# /api/ va al servizio "api" dello stack (deploy/compose.yml).
FROM nginx:stable-alpine
LABEL org.opencontainers.image.source="https://github.com/mcauzzi/MovieCarousel"
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/
# /app/: APK e version.json dell'app Android (§11.1). Se mancano, /app/* e /api/app/version
# rispondono 404: il sito mostra "App non disponibile in questa build", l'API salta il controllo 426.
RUN mkdir -p /usr/share/nginx/html/app
COPY --from=android-app / /usr/share/nginx/html/app/
EXPOSE 80
