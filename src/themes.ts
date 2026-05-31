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
  localStorage.setItem(THEME_KEY, id);
  document.querySelectorAll<HTMLElement>('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === id);
  });
}

export function getSavedTheme(): string {
  return localStorage.getItem(THEME_KEY) ?? 'p5';
}
