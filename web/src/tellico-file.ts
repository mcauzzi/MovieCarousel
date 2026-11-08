import JSZip from 'jszip';
import { parseTellicoXml } from './parser';
import type { ParseResult } from './parser';

/* Lettura di un file Tellico (.tc), condivisa dal caricamento della modalità .tc
   (main.ts → handleFile) e da IMPORTA DA TELLICO (arrivals-import.ts): un solo
   posto che conosce il formato del contenitore.
   - .tc = zip con `tellico.xml`; se non è uno zip si prova come XML grezzo.
   - Immagini: quelle incorporate in base64 nell'XML (<images>, lette dal parser,
     in `embeddedImages` come data URL) e i file nella cartella `images/` dello
     zip, dove Tellico salva le immagini quando non le incorpora nell'XML
     (`zipImages`: voci ancora compresse, lette solo quando servono). Chiave =
     nome del file = id immagine Tellico (lo stesso valore del campo `cover`).
     In caso di doppione vince quella dell'XML.
   - Per la vista: zipImageUrls() le espone come object URL (da revocare al
     Reload o al file successivo). Per IMPORTA: imageBase64() legge i byte di
     un'immagine alla volta, al momento dell'invio. */

/** Immagine nella cartella `images/` dello zip (non ancora decompressa). */
export interface ZipImage {
  mime: string;
  entry: JSZip.JSZipObject;
}

export interface TellicoFile extends ParseResult {
  /** Immagini di `images/` dello zip non già incorporate nell'XML. */
  zipImages: Map<string, ZipImage>;
}

/** Nome immagine accettato dall'API (docs/api.md, import delle immagini). */
export const IMAGE_NAME_RE = /^(?!\.)[A-Za-z0-9._-]{1,200}$/;

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
};

function zipImageEntries(zip: JSZip): Map<string, ZipImage> {
  const out = new Map<string, ZipImage>();
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    const m = /^images\/([^/]+)$/.exec(path);
    if (!m) return;
    const mime = MIME_BY_EXT[m[1].split('.').pop()?.toLowerCase() ?? ''];
    if (mime) out.set(m[1], { mime, entry });
  });
  return out;
}

export async function readTellicoFile(
  file: Blob,
  onPhase?: (phase: 'extracting' | 'parsing') => void
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
  const result = parseTellicoXml(xmlString);
  const zipImages = zip ? zipImageEntries(zip) : new Map<string, ZipImage>();
  for (const k of result.embeddedImages.keys()) zipImages.delete(k);
  return { ...result, zipImages };
}

/** Object URL per le immagini dello zip (vista della modalità .tc). `revoke`
 *  li rilascia: va chiamato quando la collezione viene sostituita. */
export async function zipImageUrls(
  images: Map<string, ZipImage>
): Promise<{ urls: Map<string, string>; revoke: () => void }> {
  const urls = new Map<string, string>();
  await Promise.all([...images].map(async ([name, img]) => {
    const blob = await img.entry.async('blob');
    urls.set(name, URL.createObjectURL(blob.slice(0, blob.size, img.mime)));
  }));
  return { urls, revoke: () => { for (const u of urls.values()) URL.revokeObjectURL(u); } };
}

/** Base64 di un'immagine del file, per l'invio all'API: dello zip, o incorporata
 *  come data URL (`data:<mime>;base64,<dati>`; null se non è base64). */
export async function imageBase64(img: string | ZipImage): Promise<string | null> {
  if (typeof img !== 'string') return img.entry.async('base64');
  const i = img.indexOf(';base64,');
  return img.startsWith('data:') && i !== -1 ? img.slice(i + 8) : null;
}
