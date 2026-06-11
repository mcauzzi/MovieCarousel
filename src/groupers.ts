import type { Movie } from './parser';
import type { StoreAdapter } from './store';
import { fieldValues, decadeKey } from './utils';

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

export function buildGroupers(movies: Movie[], store: StoreAdapter): Grouper[] {
  const groupers: Grouper[] = [];

  function add(name: string, label: string, fn: () => Group[], field?: string) {
    const groups = fn();
    if (groups.length >= 2) groupers.push({ name, label, groups, field });
  }

  function groupByField(field: string, minSize: number): Group[] {
    const map = new Map<string, Movie[]>();
    for (const m of movies) {
      for (const val of fieldValues(m, field)) {
        if (!val) continue;
        if (!map.has(val)) map.set(val, []);
        map.get(val)!.push(m);
      }
    }
    return Array.from(map.entries())
      .filter(([, v]) => v.length >= minSize)
      .map(([k, v]) => ({ key: k, label: k, movies: v }))
      .sort((a, b) => b.movies.length - a.movies.length);
  }

  add('genre',       'Genere',  () => groupByField('genre', 3),       'genre');
  add('director',    'Regista', () => groupByField('director', 3),    'director');
  add('nationality', 'Paese',   () => groupByField('nationality', 4), 'nationality');
  add('language',    'Lingua',  () => groupByField('language', 5),    'language');
  add('studio',      'Studio',  () => groupByField('studio', 5),      'studio');

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

  return groupers;
}
