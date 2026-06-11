// Rileva un index.html stantio in cache: confronta il bundle referenziato
// dal documento corrente con quello nell'index.html fresco dal server e,
// se differiscono, ricarica la pagina una sola volta (guardia in
// sessionStorage contro i loop di reload).
const RELOAD_FLAG = 'cm_version_reloaded';

/** Ritorna true se ha avviato un reload della pagina: in tal caso il chiamante
 *  evita di lanciare l'auto-load (lavoro sprecato, la pagina sta per ricaricarsi). */
export async function checkForNewVersion(): Promise<boolean> {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;

  // In dev lo script è /src/main.ts: nessun match, check disattivato
  const ownBundle = document
    .querySelector('script[type="module"][src*="assets/"]')
    ?.getAttribute('src');
  if (!ownBundle) return false;

  if (sessionStorage.getItem(RELOAD_FLAG)) {
    // appena ricaricato: salta il check per evitare loop se anche un
    // proxy intermedio serve la versione vecchia
    sessionStorage.removeItem(RELOAD_FLAG);
    return false;
  }

  try {
    const res = await fetch(location.href, { cache: 'no-cache' });
    if (!res.ok) return false;
    const freshHtml = await res.text();
    if (!freshHtml.includes(ownBundle)) {
      sessionStorage.setItem(RELOAD_FLAG, '1');
      location.reload();
      return true;
    }
  } catch (_) { /* offline o server irraggiungibile: si resta sulla versione corrente */ }
  return false;
}
