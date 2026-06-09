// Rileva un index.html stantio in cache: confronta il bundle referenziato
// dal documento corrente con quello nell'index.html fresco dal server e,
// se differiscono, ricarica la pagina una sola volta (guardia in
// sessionStorage contro i loop di reload).
const RELOAD_FLAG = 'cm_version_reloaded';

export async function checkForNewVersion(): Promise<void> {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  // In dev lo script è /src/main.ts: nessun match, check disattivato
  const ownBundle = document
    .querySelector('script[type="module"][src*="assets/"]')
    ?.getAttribute('src');
  if (!ownBundle) return;

  if (sessionStorage.getItem(RELOAD_FLAG)) {
    // appena ricaricato: salta il check per evitare loop se anche un
    // proxy intermedio serve la versione vecchia
    sessionStorage.removeItem(RELOAD_FLAG);
    return;
  }

  try {
    const res = await fetch(location.href, { cache: 'no-cache' });
    if (!res.ok) return;
    const freshHtml = await res.text();
    if (!freshHtml.includes(ownBundle)) {
      sessionStorage.setItem(RELOAD_FLAG, '1');
      location.reload();
    }
  } catch (_) { /* offline o server irraggiungibile: si resta sulla versione corrente */ }
}
