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
# /app/ ospiterà APK e version.json dell'app Android (docs/scanner-dvd.md §11.1, fase 5).
# Finché è vuota /app/* e /api/app/version rispondono 404, che il frontend gestisce.
RUN mkdir -p /usr/share/nginx/html/app
EXPOSE 80
