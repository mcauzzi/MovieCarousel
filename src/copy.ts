/* Testi "di colore" dipendenti dal tema: ogni tema parla il gergo del suo gioco
   (P5 i Ladri Fantasma, P3 la Velvet Room e la S.E.E.S., P4 l'Investigation
   Team e il Midnight Channel). Restano invece fissi i nomi funzionali dei
   controlli (FILTRI, RANDOM, INTEL, VISTA, SEEN/WATCHLIST) e i messaggi
   d'errore, così l'app si usa allo stesso modo in ogni tema.
   Foglia senza import: i template la leggono al render con currentCopy();
   al cambio tema main.ts ri-renderizza la vista e aggiorna i testi statici. */

export type ThemeId = 'p5' | 'p3' | 'p4';

export interface ThemeCopy {
  /** Unità del contatore film (masthead, card INTEL, messaggio di caricamento). */
  unit: string;
  /** Etichetta sopra il numero di riga. */
  rowEyebrow: string;
  /** Numero di riga (1-based) come va mostrato. */
  rowNumber: (n: number) => string;
  /** Timbro sui film visti / tag sui film in watchlist. */
  seenBadge: string;
  watchBadge: string;
  /** Etichetta del segnaposto quando manca la copertina (card / scheda). */
  noCover: string;
  noVisual: string;
  /** Intestazione della scheda film. */
  fileEyebrow: (id: number) => string;
  /** Toast della scheda. */
  toastSeen: string;
  toastWatchlist: string;
  toastCleared: string;
  toastRating: string;
  /** Parola accentata nel titolo del popup RANDOM. */
  randomAccent: string;
  /** All-Out Attack e biglietto. */
  attack: string;
  ccGreeting: string;
  ccStolen: (minutes: number | null) => string;
  ccClosing: string;
  ccSignature: string;
  /** Vista INTEL. */
  intelEyebrow: string;
  intelTitle: string;
  intelSubtitle: string;
  statSeen: string;
  statWatchlist: string;
  statProgress: string;
  /** Loader e toolbar (testi statici di index.html). */
  loaderIssue: string;
  loaderLede: string;
  loaderStamp: string;
  loaderStep1: string;
  loaderStep2: string;
  searchPlaceholder: string;
  /** Messaggi di stato del caricamento. */
  statusReading: string;
  statusExtracting: string;
  statusParsing: string;
  statusLoaded: (n: number) => string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function roman(n: number): string {
  const table: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

export const COPY: Record<ThemeId, ThemeCopy> = {
  // PHANTOM — Persona 5: i Ladri Fantasma, bersagli, colpi, biglietti da visita.
  p5: {
    unit: 'targets',
    rowEyebrow: 'MISSION',
    rowNumber: pad2,
    seenBadge: 'STOLEN',
    watchBadge: 'TARGET',
    noCover: '▰ No cover',
    noVisual: '▰ NO VISUAL ▰',
    fileEyebrow: id => `▰ TARGET FILE Nº ${String(id).padStart(3, '0')} ▰`,
    toastSeen: 'TARGET NEUTRALIZED',
    toastWatchlist: 'ADDED TO WATCHLIST',
    toastCleared: 'TARGET CLEARED',
    toastRating: 'INTEL UPDATED',
    randomAccent: 'TARGET',
    attack: 'All-out attack!',
    ccGreeting: 'Gentile spettatore,',
    ccStolen: min => min ? `stasera ti ruberemo ${min} minuti di vita con` : 'stasera ti ruberemo il tempo con',
    ccClosing: 'Non potrai opporti.',
    ccSignature: '— I LADRI DI PELLICOLE',
    intelEyebrow: '▰ PHANTOM INTEL ▰',
    intelTitle: "Thieves' Den",
    intelSubtitle: 'ARCHIVE REPORT',
    statSeen: 'NEUTRALIZED',
    statWatchlist: 'ON RADAR',
    statProgress: 'PROGRESS',
    loaderIssue: '▰ MISSION 01 ▰ COLLECTION DATA',
    loaderLede: 'Take your films back.',
    loaderStamp: '★ ALL OUT ATTACK',
    loaderStep1: '▶ STEP 01 ▶ TARGET',
    loaderStep2: '▶ STEP 02 ▶ COPERTINE',
    searchPlaceholder: 'search target...',
    statusReading: '▶ READING TARGET...',
    statusExtracting: '▶ EXTRACTING DATA...',
    statusParsing: '▶ PARSING DIRECT XML...',
    statusLoaded: n => `✓ ${n} TARGETS ACQUIRED`,
  },
  // MEMENTO — Persona 3: Velvet Room, Arcani, compendio, Ora Buia, memento mori.
  p3: {
    unit: 'memories',
    rowEyebrow: 'ARCANA',
    rowNumber: roman,
    seenBadge: 'CLEARED',
    watchBadge: 'REQUEST',
    noCover: '◇ No image',
    noVisual: '◇ NO IMAGE ◇',
    fileEyebrow: id => `◇ COMPENDIUM Nº ${String(id).padStart(3, '0')} ◇`,
    toastSeen: 'MEMORY RECORDED',
    toastWatchlist: 'REQUEST ACCEPTED',
    toastCleared: 'MEMORY RELEASED',
    toastRating: 'COMPENDIUM UPDATED',
    randomAccent: 'ARCANA',
    attack: 'All-out attack!',
    ccGreeting: 'Benvenuto nella Velvet Room.',
    ccStolen: min => min ? `Le carte hanno scelto per te ${min} minuti con` : 'Le carte hanno scelto per te',
    ccClosing: 'Ricorda: memento mori.',
    ccSignature: '— LA VELVET ROOM',
    intelEyebrow: '◇ S.E.E.S. REPORT ◇',
    intelTitle: 'Velvet Room',
    intelSubtitle: 'COMPENDIUM',
    statSeen: 'CLEARED',
    statWatchlist: 'REQUESTS',
    statProgress: 'COMPLETION',
    loaderIssue: '◇ FULL MOON ◇ COLLECTION DATA',
    loaderLede: 'Memento mori.',
    loaderStamp: '☾ DARK HOUR',
    loaderStep1: '◇ STEP 01 ◇ COMPENDIUM',
    loaderStep2: '◇ STEP 02 ◇ COPERTINE',
    searchPlaceholder: 'search compendium...',
    statusReading: '◇ OPENING COMPENDIUM...',
    statusExtracting: '◇ RECALLING MEMORIES...',
    statusParsing: '◇ READING THE CARDS...',
    statusLoaded: n => `✓ ${n} MEMORIES RECORDED`,
  },
  // MAYONAKA — Persona 4: Investigation Team, Midnight Channel, casi, nebbia.
  p4: {
    unit: 'channels',
    rowEyebrow: 'CHANNEL',
    rowNumber: pad2,
    seenBadge: 'CASE CLOSED',
    watchBadge: 'ON AIR',
    noCover: '▣ No signal',
    noVisual: '▣ NO SIGNAL ▣',
    fileEyebrow: id => `▣ CASE FILE Nº ${String(id).padStart(3, '0')} ▣`,
    toastSeen: 'CASE CLOSED!',
    toastWatchlist: 'NOW ON AIR!',
    toastCleared: 'SIGNAL LOST',
    toastRating: 'CASE NOTES UPDATED',
    randomAccent: 'CHANNEL',
    attack: 'All-out attack!',
    ccGreeting: 'Attenzione, Inaba!',
    ccStolen: min => min ? `Stanotte sul Midnight Channel: ${min} minuti di` : 'Stanotte sul Midnight Channel:',
    ccClosing: 'Restate sintonizzati.',
    ccSignature: '— INVESTIGATION TEAM',
    intelEyebrow: '▣ INVESTIGATION TEAM ▣',
    intelTitle: 'Special HQ',
    intelSubtitle: 'CASE BOARD',
    statSeen: 'SOLVED',
    statWatchlist: 'ON AIR',
    statProgress: 'CASES SOLVED',
    loaderIssue: '▣ MIDNIGHT CHANNEL ▣ COLLECTION DATA',
    loaderLede: 'Reach out to the truth.',
    loaderStamp: '☂ TUNE IN',
    loaderStep1: '▣ STEP 01 ▣ CHANNEL',
    loaderStep2: '▣ STEP 02 ▣ COPERTINE',
    searchPlaceholder: 'search channel...',
    statusReading: '▣ TUNING IN...',
    statusExtracting: '▣ CLEARING THE FOG...',
    statusParsing: '▣ DECODING SIGNAL...',
    statusLoaded: n => `✓ ${n} CHANNELS FOUND`,
  },
};

export function themeCopy(id: string | undefined): ThemeCopy {
  return COPY[(id ?? 'p5') as ThemeId] ?? COPY.p5;
}

/** Testi del tema attivo (letto da data-theme su <html>; assente = PHANTOM). */
export function currentCopy(): ThemeCopy {
  return themeCopy(document.documentElement.dataset.theme);
}
