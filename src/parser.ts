export interface Movie {
  id: number;
  title?: string;
  year?: number;
  cover?: string;
  plot?: string;
  director?: string[];
  genre?: string[];
  nationality?: string[];
  language?: string[];
  studio?: string[];
  writer?: string[];
  composer?: string[];
  producer?: string[];
  cast?: { actor: string; role: string }[];
  'running-time'?: number;
  rating?: number;
  visto?: string;
  cdate?: string;
  mdate?: string;
  [key: string]: unknown;
}

export interface ParseResult {
  movies: Movie[];
  embeddedImages: Map<string, string>;
  /** Tutti i campi dichiarati in `<fields>`, nell'ordine del file. */
  fields: TellicoField[];
}

/** Definizione di un `<field>` così come la dichiara il `.tc`. */
export interface TellicoField {
  name: string;
  title: string;
  /** Codice numerico di tipo Tellico, come stringa (attributo `type`). */
  type: string;
  /** Attributo `flags` (bitmask, 0 se assente). */
  flags: number;
  multiple: boolean;
  groupable: boolean;
  /** Valori ammessi dei campi a scelta (attributo `allowed`, separato da `;`). */
  allowed: string[] | null;
}

/** Definizione normalizzata di un campo della collezione (schema di
 *  `collection_fields`, §5 di docs/scanner-dvd.md): stessa forma in modalità
 *  `.tc` (da `toCollectionFields`) e in modalità DB (dall'API). */
export interface CollectionField {
  name: string;
  title: string;
  /** Nome normalizzato: line, para, choice, bool, number, url, table, image, date, rating, dependent. */
  type: string;
  multiple: boolean;
  groupable: boolean;
  /** Soglia minima di film per mostrare un gruppo del raggruppamento. */
  groupMinSize?: number;
  allowed?: string[] | null;
}

/* Codici di tipo di Tellico (enum Data::Field::Type in src/field.h di Tellico).
   La stessa mappatura codice → nome sta nell'API: tenerle allineate.
   5 (ReadOnly) e 9 (Table2) sono deprecati e ricadono su `line`. */
const TELLICO_TYPE_NAMES: Record<string, string> = {
  '1': 'line', '2': 'para', '3': 'choice', '4': 'bool', '6': 'number', '7': 'url',
  '8': 'table', '10': 'image', '11': 'dependent', '12': 'date', '14': 'rating',
};
const TYPE_TABLE = '8';
const TYPE_DATE = '12';

/* Bit dell'attributo `flags` (enum Data::Field::FieldFlag di Tellico).
   Da verificare su un .tc reale: AllowMultiple = 1<<0, AllowGrouped = 1<<1,
   Derived = 1<<5 (campo calcolato, "dependent"). */
const FLAG_ALLOW_MULTIPLE = 0x01;
const FLAG_ALLOW_GROUPED  = 0x02;
const FLAG_DERIVED        = 0x20;

/** Soglie minime di default dei raggruppamenti fissi basati su un campo
 *  (le stesse di sempre); per gli altri campi raggruppabili la soglia è 3. */
export const DEFAULT_GROUP_MIN_SIZE: Readonly<Record<string, number>> = {
  genre: 3, director: 3, nationality: 4, language: 5, studio: 5,
};
const FALLBACK_GROUP_MIN_SIZE = 3;

/** Nome normalizzato del tipo di un campo Tellico (codice + flag derivato). */
function collectionType(f: TellicoField): string {
  if (f.flags & FLAG_DERIVED) return 'dependent';
  return TELLICO_TYPE_NAMES[f.type] ?? 'line';
}

/** Converte le definizioni lette dal `.tc` nello schema `CollectionField`
 *  (in modalità `.tc` i raggruppamenti usano questo, in modalità DB l'API). */
export function toCollectionFields(fields: TellicoField[]): CollectionField[] {
  return fields.map(f => ({
    name: f.name,
    title: f.title,
    type: collectionType(f),
    multiple: f.multiple,
    groupable: f.groupable,
    groupMinSize: DEFAULT_GROUP_MIN_SIZE[f.name] ?? FALLBACK_GROUP_MIN_SIZE,
    allowed: f.allowed,
  }));
}

/** Ripiego per i file senza attributo `flags`: campi standard a valori multipli. */
const MULTIVALUE_FIELDS = new Set([
  'genre', 'nationality', 'director', 'producer', 'writer', 'composer',
  'studio', 'language', 'subtitle', 'audio-track', 'keyword', 'aspect-ratio',
]);

const COUNTRY_NORMALIZE: Record<string, string> = {
  'United States': 'USA', 'United Kingdom': 'UK', 'Great Britain': 'UK', 'England': 'UK',
};

const LANG_NORMALIZE: Record<string, string> = {
  'Inglese US': 'Inglese', 'English': 'Inglese', 'Inglese UK': 'Inglese',
  'Italian': 'Italiano', 'Japanese': 'Giapponese', 'Giapponese': 'Giapponese',
  'French': 'Francese', 'German': 'Tedesco', 'Chinese': 'Cinese', 'cn': 'Cinese',
  'Spanish': 'Spagnolo', 'Russian': 'Russo', 'Korean': 'Coreano',
};

// Codici di tipo trattati come numerici (Number e Rating): il loro testo viene
// convertito a `number`. Coerente con TELLICO_TYPE_NAMES (number, rating); il 5
// (ReadOnly, deprecato) non è più convertito: la mappatura lo tratta come `line`.
const NUMERIC_TYPES = new Set(['6', '14']);

function localName(el: Element): string {
  return el.localName || el.tagName.replace(/^[^:]*:/, '');
}

function childrenByName(el: Element, name: string): Element[] {
  return Array.from(el.children).filter(c => localName(c) === name);
}

function findChild(el: Element | Document, name: string): Element | null {
  for (const c of el.children) {
    if (localName(c) === name) return c;
  }
  return null;
}

function groupChildrenByName(el: Element): Map<string, Element[]> {
  const map = new Map<string, Element[]>();
  for (const c of el.children) {
    const name = localName(c);
    const arr = map.get(name);
    if (arr) arr.push(c); else map.set(name, [c]);
  }
  return map;
}

/** Data Tellico (`<year><month><day>`) → `AAAA-MM-GG` (o `AAAA-MM` / `AAAA` se
 *  incompleta). Senza figli (testo già ISO, file scritti a mano) usa il testo. */
function readDate(el: Element): string {
  const y = findChild(el, 'year')?.textContent?.trim();
  const mo = findChild(el, 'month')?.textContent?.trim();
  const d = findChild(el, 'day')?.textContent?.trim();
  if (!y && !mo && !d) return (el.textContent || '').trim();
  const parts: string[] = [];
  if (y) parts.push(y);
  if (mo) parts.push(mo.padStart(2, '0'));
  if (d) parts.push(d.padStart(2, '0'));
  return parts.join('-');
}

/** Valore scalare di un elemento secondo il tipo del campo ('' = vuoto). */
function readValue(el: Element, type: string): string | number {
  if (type === TYPE_DATE) return readDate(el);
  const val = (el.textContent || '').trim();
  if (val && NUMERIC_TYPES.has(type)) {
    const n = Number(val);
    if (!isNaN(n)) return n;
  }
  return val;
}

/** Riga di una tabella: testi delle `<column>` (righe vuote → null). */
function readRow(el: Element): string[] | null {
  const cols = childrenByName(el, 'column').map(col => (col.textContent || '').trim());
  // Tabella a una colonna scritta senza <column>: il testo è la cella.
  if (!cols.length) { const t = (el.textContent || '').trim(); return t ? [t] : null; }
  return cols.some(Boolean) ? cols : null;
}

function parseEntry(entry: Element, fields: TellicoField[]): Movie {
  const data: Record<string, unknown> = {};

  // Raggruppa i figli diretti dell'entry una sola volta: i lookup per campo
  // diventano O(1) invece di riscansionare i figli per ogni campo (O(campi×figli)).
  const byName = groupChildrenByName(entry);
  const first = (name: string): Element | null => byName.get(name)?.[0] ?? null;

  // Tellico scrive i campi a valori multipli e le tabelle dentro un contenitore
  // col nome del campo + "s", senza badare alla grammatica (<genres><genre>,
  // <nationalitys><nationality>, <casts><cast>, <ediziones><edizione>).
  const castsEl = first('casts');
  if (castsEl) {
    const castList: { actor: string; role: string }[] = [];
    for (const c of childrenByName(castsEl, 'cast')) {
      const cols = childrenByName(c, 'column').map(col => (col.textContent || '').trim());
      if (cols.length && cols[0]) castList.push({ actor: cols[0], role: cols[1] || '' });
    }
    if (castList.length) data['cast'] = castList;
  }

  const idAttr = entry.getAttribute('id');
  if (idAttr) data['id'] = parseInt(idAttr, 10);

  for (const f of fields) {
    const fname = f.name;
    if (fname === 'cast' || fname === 'id') continue;
    // cdate/mdate sono date anche nei file che non ne dichiarano il tipo.
    const type = fname === 'cdate' || fname === 'mdate' ? TYPE_DATE : f.type;
    // Il contenitore al plurale vale solo se il campo è multiplo/tabella o se
    // contiene davvero figli col nome del campo: un altro campo che si chiama
    // come il plurale (es. "edition" ed "editions") non va scambiato per lui.
    const plural = first(fname + 's');
    const wrapper = plural && (f.multiple || type === TYPE_TABLE || childrenByName(plural, fname).length)
      ? plural : null;

    // Tabelle (diverse da cast): righe di colonne, string[][].
    if (type === TYPE_TABLE) {
      const rowEls = wrapper ? childrenByName(wrapper, fname) : (byName.get(fname) ?? []);
      const rows = rowEls.map(readRow).filter((r): r is string[] => r !== null);
      if (rows.length) data[fname] = rows;
      continue;
    }

    // Multivalore se lo dice il flag; ma se nel file c'è comunque il contenitore
    // al plurale lo leggiamo come lista (schema e dati non sempre combaciano).
    if (f.multiple || wrapper) {
      const inWrapper = wrapper ? childrenByName(wrapper, fname) : [];
      // Senza contenitore (file scritti a mano, campo diventato multiplo dopo):
      // valori come elementi singolari fratelli.
      const els = inWrapper.length ? inWrapper : (byName.get(fname) ?? []);
      let vals = els.map(el => readValue(el, type)).filter(v => v !== '');
      if (fname === 'nationality') vals = vals.map(v => COUNTRY_NORMALIZE[v] ?? v);
      if (fname === 'language') vals = vals.map(v => LANG_NORMALIZE[v] ?? v);
      const seen = new Set<string | number>();
      vals = vals.filter(v => !seen.has(v) && seen.add(v));
      if (vals.length) data[fname] = vals;
      continue;
    }

    const el = first(fname);
    if (!el) continue;
    const val = readValue(el, type);
    if (val !== '') data[fname] = val;
  }

  return data as Movie;
}

/** Legge `<fields>`: tipo, flag, valori ammessi; `multiple`/`groupable` dai bit
 *  di `flags`, con ripiego su MULTIVALUE_FIELDS per i file senza `flags`. */
function parseFields(fieldsEl: Element | null): TellicoField[] {
  if (!fieldsEl) return [];
  const out: TellicoField[] = [];
  const seen = new Set<string>();
  for (const el of childrenByName(fieldsEl, 'field')) {
    const name = el.getAttribute('name');
    // `_default` (segnaposto "campi standard del tipo" dei modelli Tellico) non è un campo.
    if (!name || name === '_default' || seen.has(name)) continue;
    seen.add(name);
    const flagsNum = parseInt(el.getAttribute('flags') ?? '', 10);
    const hasFlags = Number.isFinite(flagsNum);
    const flags = hasFlags ? flagsNum : 0;
    const allowed = (el.getAttribute('allowed') ?? '').split(';').map(v => v.trim()).filter(Boolean);
    out.push({
      name,
      title: el.getAttribute('title') || name,
      type: el.getAttribute('type') || '1',
      flags,
      multiple: hasFlags ? (flags & FLAG_ALLOW_MULTIPLE) !== 0 : MULTIVALUE_FIELDS.has(name),
      groupable: (flags & FLAG_ALLOW_GROUPED) !== 0,
      allowed: allowed.length ? allowed : null,
    });
  }
  return out;
}

export function parseTellicoXml(xmlString: string): ParseResult {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) throw new Error('XML non valido: ' + (parseErr.textContent ?? '').slice(0, 200));

  const collection = findChild(doc.documentElement, 'collection');
  if (!collection) throw new Error('Nessuna <collection> trovata');

  const fields = parseFields(findChild(collection, 'fields'));
  const movies = childrenByName(collection, 'entry').map(e => parseEntry(e, fields));

  // Garantisce un id numerico valido per ogni film: quelli senza id (mancante o
  // NaN da parseInt) ricevono un id sintetico partendo da max(id esistenti)+1,
  // così non collide con gli id reali del .tc. I consumatori possono assumere
  // `Movie.id` sempre valido (niente cast a valle).
  let maxId = 0;
  for (const m of movies) if (Number.isFinite(m.id)) maxId = Math.max(maxId, m.id);
  let nextId = maxId + 1;
  for (const m of movies) if (!Number.isFinite(m.id)) m.id = nextId++;

  const imagesEl = findChild(collection, 'images');
  const embeddedImages = new Map<string, string>();
  if (imagesEl) {
    for (const img of childrenByName(imagesEl, 'image')) {
      const id = img.getAttribute('id');
      const data = (img.textContent || '').trim();
      if (id && data) {
        const fmt = img.getAttribute('format') || 'jpeg';
        embeddedImages.set(id, 'data:image/' + fmt + ';base64,' + data);
      }
    }
  }

  return { movies, embeddedImages, fields };
}
