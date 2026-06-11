export interface Theme {
  id: string;
  label: string;
}

export const THEMES: Theme[] = [
  { id: 'p5', label: 'PHANTOM' },
  { id: 'p3', label: 'MEMENTO' },
  { id: 'p4', label: 'MAYONAKA' },
];

const THEME_KEY = 'cm_theme';

export function applyTheme(id: string): void {
  if (id === 'p5') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = id;
  }
  try { localStorage.setItem(THEME_KEY, id); } catch (e) { console.warn('cm: impossibile salvare il tema', e); }
  const sel = document.querySelector<HTMLSelectElement>('.theme-dropdown');
  if (sel && sel.value !== id) sel.value = id;
}

export function getSavedTheme(): string {
  return localStorage.getItem(THEME_KEY) ?? 'p5';
}
