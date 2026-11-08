#!/bin/sh
# Backup notturno del DB (servizio "backup" di deploy/compose.yml).
# POSIX sh (BusyBox/alpine). Nessun segreto: le credenziali arrivano dall'environment del container.
#
#   PGHOST, PGUSER, PGPASSWORD, PGDATABASE   connessione (variabili standard di libpq);
#                 PGPASSWORD, se assente, viene presa da POSTGRES_PASSWORD (env_file: Environment di Komodo o db.env)
#   BACKUP_DIR    cartella dei dump              (default /backup)
#   BACKUP_AT     ora del dump, HH:MM            (default 03:30, ora locale del container: vedi TZ)
#   BACKUP_KEEP   quanti dump tenere             (default 14)
#   BACKUP_NOW    1 = un dump anche all'avvio    (default 0)
#
# Ogni dump: pg_dump -Fc su un file temporaneo, verifica con pg_restore --list, rename in
# cinema-AAAAMMGG-HHMM.dump, poi rotazione. Un errore viene registrato e il ciclo continua.
# Ripristino: vedi deploy/README.md.

set -u
umask 077

BACKUP_DIR=${BACKUP_DIR:-/backup}
BACKUP_AT=${BACKUP_AT:-03:30}
BACKUP_KEEP=${BACKUP_KEEP:-14}
BACKUP_NOW=${BACKUP_NOW:-0}
PREFIX=cinema

# La password arriva via env_file come POSTGRES_PASSWORD (come per il servizio db): libpq legge PGPASSWORD.
if [ -z "${PGPASSWORD:-}" ] && [ -n "${POSTGRES_PASSWORD:-}" ]; then
    PGPASSWORD=$POSTGRES_PASSWORD
    export PGPASSWORD
fi

child=""
tmp=""

log()  { printf '%s [backup] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*"; }
fail() { printf '%s [backup] ERRORE: %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*" >&2; }

on_term() {
    log "segnale ricevuto, esco"
    [ -n "$child" ] && kill "$child" 2>/dev/null
    [ -n "$tmp" ] && rm -f "$tmp"
    exit 0
}
trap on_term TERM INT HUP

# Configurazione: un valore sbagliato è un errore dell'operatore, meglio fermarsi subito.
case "$BACKUP_AT" in
    [01][0-9]:[0-5][0-9] | 2[0-3]:[0-5][0-9]) ;;
    *) fail "BACKUP_AT='$BACKUP_AT' non valido (formato HH:MM, es. 03:30)"; exit 1 ;;
esac
case "$BACKUP_KEEP" in
    '' | *[!0-9]*) fail "BACKUP_KEEP='$BACKUP_KEEP' non è un intero"; exit 1 ;;
esac
if [ "$BACKUP_KEEP" -lt 1 ]; then
    fail "BACKUP_KEEP deve essere almeno 1"; exit 1
fi
if [ ! -d "$BACKUP_DIR" ] || [ ! -w "$BACKUP_DIR" ]; then
    fail "$BACKUP_DIR non esiste o non è scrivibile"; exit 1
fi

# Esegue un comando in background e lo attende: così SIGTERM interrompe subito anche un dump lungo.
run() {
    "$@" &
    child=$!
    wait "$child"
    rc=$?
    child=""
    return "$rc"
}

rotate() {
    # I nomi contengono AAAAMMGG-HHMM: l'ordine alfabetico è quello cronologico.
    ls -1 "$BACKUP_DIR" 2>/dev/null | grep -E "^${PREFIX}-[0-9]{8}-[0-9]{4}\.dump\$" | sort -r |
        tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
            if rm -f "$BACKUP_DIR/$old"; then log "rotazione: rimosso $old"; else fail "rotazione: non riesco a rimuovere $old"; fi
        done
}

dump() {
    stamp=$(date +%Y%m%d-%H%M)
    final="$BACKUP_DIR/$PREFIX-$stamp.dump"
    tmp="$BACKUP_DIR/.$PREFIX-$stamp.dump.partial"
    log "dump di '${PGDATABASE:-?}' su ${PGHOST:-?} -> $final"
    start=$(date +%s)

    if ! run pg_dump -Fc -f "$tmp"; then
        fail "pg_dump non riuscito"
        rm -f "$tmp"; tmp=""
        return 1
    fi
    if ! run pg_restore --list "$tmp" >/dev/null; then
        fail "verifica con pg_restore --list non riuscita: dump scartato"
        rm -f "$tmp"; tmp=""
        return 1
    fi
    if ! mv -f "$tmp" "$final"; then
        fail "rename di $tmp non riuscito"
        rm -f "$tmp"; tmp=""
        return 1
    fi
    tmp=""
    size=$(wc -c < "$final" | tr -d ' ')
    log "ok: $final ($size byte, $(( $(date +%s) - start )) s)"
    rotate
    return 0
}

# File temporanei lasciati da un'esecuzione interrotta.
rm -f "$BACKUP_DIR"/."$PREFIX"-*.dump.partial

log "avvio: dump ogni giorno alle $BACKUP_AT (TZ=${TZ:-UTC}), tengo gli ultimi $BACKUP_KEEP in $BACKUP_DIR"

last_day=""
if [ "$BACKUP_NOW" = "1" ]; then
    dump || true
fi

# Controllo ogni 30 s: robusto a cambi d'ora legale e a orologi corretti a caldo
# (un solo sleep lungo fino alle HH:MM andrebbe fuori di un'ora al cambio d'ora).
while :; do
    today=$(date +%Y%m%d)
    if [ "$(date +%H:%M)" = "$BACKUP_AT" ] && [ "$last_day" != "$today" ]; then
        last_day=$today
        dump || true
    fi
    run sleep 30
done
