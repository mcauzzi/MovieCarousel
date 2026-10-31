import JSZip from 'jszip';
import { parseTellicoXml } from './parser';
import type { ParseResult } from './parser';

/* Lettura di un file Tellico (.tc), condivisa dal caricamento della modalità .tc
   (main.ts → handleFile) e da IMPORTA DA TELLICO (arrivals.ts): un solo posto
   che conosce il formato del contenitore.
   - .tc = zip con `tellico.xml`; se non è uno zip si prova come XML grezzo.
   - Immagini: quelle incorporate in base64 nell'XML (<images>, lette dal parser)
     e i file nella cartella `images/` dello zip, dove Tellico salva le immagini
     quando non le incorpora nell'XML. Chiave = nome del file = id immagine
     Tellico (lo stesso valore del campo `cover`). In caso di doppione vince
     quella dell'XML. */

export interface TellicoFile extends ParseResult {
  /** Fase raggiunta, per i messaggi di stato del chiamante. */
  source: 'zip' | 'xml';
}

export type TellicoPhase = 'extracting' | 'parsing';

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
};

function mimeFor(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? null;
}

async function zipImages(zip: JSZip): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const jobs: Promise<void>[] = [];
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    const m = /^images\/([^/]+)$/.exec(path);
    if (!m) return;
    const name = m[1];
    // Solo nomi "sicuri" (come li salva Tellico): niente percorsi né caratteri strani.
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return;
    const mime = mimeFor(name);
    if (!mime) return;
    jobs.push(entry.async('base64').then(b64 => { out.set(name, `data:${mime};base64,${b64}`); }));
  });
  await Promise.all(jobs);
  return out;
}

export async function readTellicoFile(
  file: Blob,
  onPhase?: (phase: TellicoPhase) => void
): Promise<TellicoFile> {
  const arrayBuf = await file.arrayBuffer();
  let xmlString: string;
  let zip: JSZip | null = null;
  try {
    zip = await JSZip.loadAsync(arrayBuf);
    const xmlFile = zip.file('tellico.xml');
    if (!xmlFile) throw new Error('tellico.xml non trovato nello zip');
    xmlString = await xmlFile.async('string');
    onPhase?.('extracting');
  } catch (zipErr) {
    const text = new TextDecoder('utf-8').decode(arrayBuf);
    if (text.trim().startsWith('<?xml') || text.includes('<tellico')) {
      xmlString = text;
      zip = null;
      onPhase?.('parsing');
    } else throw zipErr;
  }
  const images = zip ? await zipImages(zip) : new Map<string, string>();
  const result = parseTellicoXml(xmlString);
  for (const [k, v] of result.embeddedImages) images.set(k, v);
  return { ...result, embeddedImages: images, source: zip ? 'zip' : 'xml' };
}

/** Base64 puro da un data URL (`data:<mime>;base64,<dati>`); null se non è base64. */
export function base64FromDataUrl(url: string): string | null {
  const i = url.indexOf(';base64,');
  return url.startsWith('data:') && i !== -1 ? url.slice(i + 8) : null;
}
