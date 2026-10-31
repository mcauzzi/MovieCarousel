import type { Movie, CollectionField } from './parser';
import { DEFAULT_GROUP_MIN_SIZE } from './parser';
import type { StoreAdapter } from './store';
import { fieldValues, decadeKey, isTrueValue } from './utils';

export interface Group {
  key: string;
  label: string;
  movies: Movie[];
  sortKey?: number;
}

export interface Grouper {
  name: string;
  label: string;
  groups: Group[];
  /** Nome del campo Movie da cui deriva il grouper. Usato per "Nessun X" nel picker. */
  field?: string;
}

export function matchesSearch(m: Movie, searchTerm: string): boolean {
  if (!searchTerm) return true;
  const haystack = [
    m.title ?? '',
    Array.isArray(m.director) ? m.director.join(' ') : (m.director ?? ''),
    m.cast ? m.cast.map(c => c.actor).join(' ') : '',
    Array.isArray(m.genre) ? m.genre.join(' ') : (m.genre ?? ''),
  ].join(' ').toLowerCase();
  return haystack.includes(searchTerm.toLowerCase());
}

/** Nomi dei raggruppamenti fissi: la chiave è condivisa con `filterSelections`,
 *  quindi un campo con lo stesso nome non può diventare un raggruppamento. */
const FIXED_GROUPERS = new Set([
  'genre', 'director', 'nationality', 'language', 'studio',
  'rating', 'decade', 'duration', 'alpha', 'recent',
]);
/** Campi strutturali già usati altrove (titolo, copertina, anno → decennio,
 *  durata, cast, date di sistema; `visto` è solo il seed dello stato di visione,
 *  che ha già il filtro VISIONE): mai raggruppamenti personalizzati. */
const STRUCTURAL_FIELDS = new Set([
  'id', 'title', 'cover', 'plot', 'cast', 'year', 'running-time', 'cdate', 'mdate', 'visto',
]);
/** Tipi che non hanno senso come raggruppamento. */
const UNGROUPABLE_TYPES = new Set(['image', 'table', 'para', 'url', 'dependent']);

export function buildGroupers(movies: Movie[], store: StoreAdapter, fields?: CollectionField[]): Grouper[] {
  const groupers: Grouper[] = [];

  /** Soglia di un raggruppamento basato su un campo: da `fields` se presente,
   *  altrimenti quella fissa di sempre. */
  const minSizeOf = (name: string): number =>
    fields?.find(f => f.name === name)?.groupMinSize ?? DEFAULT_GROUP_MIN_SIZE[name] ?? 3;

  function add(name: string, label: string, fn: () => Group[], field?: string) {
    const groups = fn();
    if (groups.length >= 2) groupers.push({ name, label, groups, field });
  }

  function groupByField(field: string, minSize: number): Group[] {
    const map = new Map<string, Movie[]>();
    for (const m of movies) {
      for (const val of fieldValues(m, field)) {
        if (val === '' || val === null || val === undefined) continue;
        const key = String(val);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(m);
      }
    }
    return Array.from(map.entries())
      .filter(([, v]) => v.length >= minSize)
      .map(([k, v]) => ({ key: k, label: k, movies: v }))
      .sort((a, b) => b.movies.length - a.movies.length);
  }

  add('genre',       'Genere',  () => groupByField('genre', minSizeOf('genre')),             'genre');
  add('director',    'Regista', () => groupByField('director', minSizeOf('director')),       'director');
  add('nationality', 'Paese',   () => groupByField('nationality', minSizeOf('nationality')), 'nationality');
  add('language',    'Lingua',  () => groupByField('language', minSizeOf('language')),       'language');
  add('studio',      'Studio',  () => groupByField('studio', minSizeOf('studio')),           'studio');

  add('rating', 'Voto', () => {
    const map = new Map<number, Movie[]>();
    for (const m of movies) {
      const r = store.getRating(m.id);
      if (r === null) continue;
      if (!map.has(r)) map.set(r, []);
      map.get(r)!.push(m);
    }
    return Array.from(map.entries())
      .map(([r, v]) => ({ key: String(r), label: '★'.repeat(r) + ' (' + r + ')', movies: v, sortKey: r }))
      .sort((a, b) => (b.sortKey ?? 0) - (a.sortKey ?? 0));
  });

  add('decade', 'Decennio', () => {
    const map = new Map<string, Movie[]>();
    for (const m of movies) {
      if (!m.year) continue;
      const key = decadeKey(m.year);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    return Array.from(map.entries())
      .map(([k, v]) => ({ key: k, label: 'Anni ' + k.replace('s', ''), movies: v, sortKey: parseInt(k, 10) }))
      .sort((a, b) => (b.sortKey ?? 0) - (a.sortKey ?? 0));
  });

  add('duration', 'Durata', () => {
    const buckets: { key: string; label: string; test: (rt: number) => boolean }[] = [
      { key: 'short',    label: 'Corti & medi (< 80 min)',  test: rt => rt < 80 },
      { key: 'standard', label: 'Standard (80-110 min)',     test: rt => rt >= 80 && rt < 110 },
      { key: 'long',     label: 'Lunghi (110-150 min)',      test: rt => rt >= 110 && rt < 150 },
      { key: 'epic',     label: 'Kolossal (> 150 min)',      test: rt => rt >= 150 },
    ];
    const result: Group[] = buckets.map(b => ({ key: b.key, label: b.label, movies: [] }));
    for (const m of movies) {
      const rt = m['running-time'];
      if (!rt) continue;
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i].test(rt)) { result[i].movies.push(m); break; }
      }
    }
    return result.filter(g => g.movies.length > 0);
  });

  add('alpha', 'A-Z', () => {
    const stripArt = (s: string) =>
      s.replace(/^(Il |Lo |La |I |Gli |Le |L'|The |A |An )/i, '');
    const map = new Map<string, Movie[]>();
    for (const m of movies) {
      if (!m.title) continue;
      let letter = stripArt(m.title).charAt(0).toUpperCase();
      if (!/[A-Z]/.test(letter)) letter = '#';
      if (!map.has(letter)) map.set(letter, []);
      map.get(letter)!.push(m);
    }
    return Array.from(map.entries())
      .map(([k, v]) => ({
        key: k,
        label: k,
        movies: v.sort((a, b) =>
          stripArt(a.title ?? '').localeCompare(stripArt(b.title ?? ''), 'it')),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  });

  const withDate = movies.filter(m => m.cdate).slice();
  if (withDate.length >= 5) {
    withDate.sort((a, b) => (b.cdate ?? '').localeCompare(a.cdate ?? ''));
    groupers.push({ name: 'recent', label: 'New', groups: [{ key: 'recent', label: 'New additions', movies: withDate.slice(0, 40) }] });
  }

  // Campi personalizzati raggruppabili (flag di Tellico in modalità .tc,
  // collection_fields in modalità DB), dopo quelli fissi, nell'ordine dei campi.
  for (const f of fields ?? []) {
    if (!f.groupable || FIXED_GROUPERS.has(f.name) || STRUCTURAL_FIELDS.has(f.name)) continue;
    if (UNGROUPABLE_TYPES.has(f.type) || groupers.some(g => g.name === f.name)) continue;
    const min = f.groupMinSize ?? 3;
    const label = f.title || f.name;

    if (f.type === 'bool') {
      // "Sì" / "No": Tellico non scrive i bool falsi, quindi "No" = nessun valore.
      // Senza `field` FILTRI usa i gruppi (etichette Sì/No invece di "true"):
      // entrambi i gruppi coprono tutti i film, "— Nessun" non compare.
      add(f.name, label, () => {
        const yes = movies.filter(m => isTrueValue(m[f.name]));
        const no = movies.filter(m => !isTrueValue(m[f.name]));
        return [
          { key: 'true', label: 'Sì', movies: yes },
          { key: 'false', label: 'No', movies: no },
        ].filter(g => g.movies.length >= min);
      });
    } else if (f.type === 'date') {
      // Per anno (AAAA-MM-GG → AAAA), più recente prima. Senza `field`: le chiavi
      // sono anni, non i valori del campo; "— Nessun" in FILTRI comprende anche
      // i film degli anni sotto soglia.
      add(f.name, label, () => {
        const map = new Map<string, Movie[]>();
        for (const m of movies) {
          for (const v of fieldValues(m, f.name)) {
            const y = /^\d{4}/.exec(String(v))?.[0];
            if (!y) continue;
            if (!map.has(y)) map.set(y, []);
            if (!map.get(y)!.includes(m)) map.get(y)!.push(m);
          }
        }
        return Array.from(map.entries())
          .filter(([, v]) => v.length >= min)
          .map(([k, v]) => ({ key: k, label: k, movies: v, sortKey: parseInt(k, 10) }))
          .sort((a, b) => (b.sortKey ?? 0) - (a.sortKey ?? 0));
      });
    } else if (f.type === 'number' || f.type === 'rating') {
      // Per valore, in ordine numerico (rating dal più alto, number dal più basso).
      const dir = f.type === 'rating' ? -1 : 1;
      add(f.name, label, () => groupByField(f.name, min)
        .map(g => ({ ...g, sortKey: Number(g.key) }))
        .sort((a, b) => dir * ((a.sortKey || 0) - (b.sortKey || 0))), f.name);
    } else {
      // line, choice (e tipi sconosciuti): per valore, i più numerosi prima.
      // `field = name`: FILTRI elenca tutti i valori e "__none__" funziona per campo.
      add(f.name, label, () => groupByField(f.name, min), f.name);
    }
  }

  return groupers;
}
