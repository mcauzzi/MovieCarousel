# Build: typecheck + bundle Vite
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm run build

# Runtime: nginx serve il bundle dall'immagine e i dati (config.json,
# collezione .tc, covers/, bgm/) dalla cartella del NAS montata in /srv/data
FROM nginx:stable-alpine
LABEL org.opencontainers.image.source="https://github.com/mcauzzi/MovieCarousel"
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/
EXPOSE 80
