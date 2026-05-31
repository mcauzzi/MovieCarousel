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
  cdate?: string;
  mdate?: string;
  [key: string]: unknown;
}

export interface ParseResult {
  movies: Movie[];
  embeddedImages: Map<string, string>;
}

interface FieldDef {
  title: string | null;
  type: string | null;
}

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

const NUMERIC_TYPES = new Set(['5', '6', '14']);

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

function parseEntry(entry: Element, fieldDefs: Record<string, FieldDef>): Movie {
  const data: Record<string, unknown> = {};

  const castsEl = findChild(entry, 'casts');
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

  for (const fname of Object.keys(fieldDefs)) {
    if (fname === 'cast') continue;
    const finfo = fieldDefs[fname];
    if (MULTIVALUE_FIELDS.has(fname)) {
      const wrapper = findChild(entry, fname + 's');
      if (wrapper) {
        let vals = childrenByName(wrapper, fname)
          .map(el => (el.textContent || '').trim())
          .filter(Boolean);
        if (fname === 'nationality') vals = vals.map(v => COUNTRY_NORMALIZE[v] ?? v);
        if (fname === 'language') vals = vals.map(v => LANG_NORMALIZE[v] ?? v);
        const seen = new Set<string>();
        vals = vals.filter(v => !seen.has(v) && seen.add(v));
        if (vals.length) data[fname] = vals;
      }
    } else {
      const el = findChild(entry, fname);
      if (el) {
        if (fname === 'cdate' || fname === 'mdate') {
          const y = findChild(el, 'year');
          const mo = findChild(el, 'month');
          const d = findChild(el, 'day');
          const parts: string[] = [];
          if (y?.textContent) parts.push(y.textContent);
          if (mo?.textContent) parts.push(mo.textContent.padStart(2, '0'));
          if (d?.textContent) parts.push(d.textContent.padStart(2, '0'));
          if (parts.length) data[fname] = parts.join('-');
        } else {
          let val: string | number = (el.textContent || '').trim();
          if (!val) continue;
          if (finfo.type && NUMERIC_TYPES.has(finfo.type)) {
            const n = Number(val);
            if (!isNaN(n)) val = n;
          }
          data[fname] = val;
        }
      }
    }
  }

  return data as Movie;
}

export function parseTellicoXml(xmlString: string): ParseResult {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) throw new Error('XML non valido: ' + (parseErr.textContent ?? '').slice(0, 200));

  const collection = findChild(doc.documentElement, 'collection');
  if (!collection) throw new Error('Nessuna <collection> trovata');

  const fieldsEl = findChild(collection, 'fields');
  const fieldDefs: Record<string, FieldDef> = {};
  if (fieldsEl) {
    for (const f of childrenByName(fieldsEl, 'field')) {
      const name = f.getAttribute('name');
      if (name) fieldDefs[name] = { title: f.getAttribute('title'), type: f.getAttribute('type') };
    }
  }

  const movies = childrenByName(collection, 'entry').map(e => parseEntry(e, fieldDefs));

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

  return { movies, embeddedImages };
}
