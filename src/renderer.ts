import type { Movie } from './parser';
import type { Grouper, Group } from './groupers';
import { matchesSearch } from './groupers';
import { escapeHtml, coverUrl } from './utils';
import type { StoreAdapter } from './store';

type OpenModalFn = (id: number, movies: Movie[], embeddedImages: Map<string, string>, imgDir: string) => void;

function cardHTML(m: Movie, embeddedImages: Map<string, string>, imgDir: string, store: StoreAdapter): string {
  const url = coverUrl(m, embeddedImages, imgDir);
  const yr = m.year ? String(m.year) : '';
  const safeTitle = escapeHtml(m.title);
  const placeholder = `<div class="placeholder"><div class="pl-title">${safeTitle}</div>${yr ? `<div class="pl-year">${yr}</div>` : ''}</div>`;
  const cover = url ? `<img src="${escapeHtml(url)}" alt="${safeTitle}" loading="lazy">` : placeholder;
  const director = Array.isArray(m.director) ? m.director[0] : (m.director ?? '');
  const status = store.getStatus(m.id);
  const badge = status
    ? `<div class="card-status-badge ${status === 'seen' ? 'badge-seen' : 'badge-watchlist'}">${status === 'seen' ? 'SEEN' : '◎'}</div>`
    : '';
  return `<div class="card" data-id="${m.id}">
    <div class="card-inner">
      <div class="img-wrap">${cover}</div>
      <div class="card-overlay">
        <div class="co-title">${safeTitle}</div>
        ${director ? `<div class="co-meta">${escapeHtml(director)}</div>` : ''}
      </div>
    </div>
    <div class="card-bar">${escapeHtml(m.title)}</div>
    ${yr ? `<div class="card-tag">${yr}</div>` : ''}
    ${badge}
  </div>`;
}

function rowHTML(
  g: Group,
  idx: number,
  searchTerm: string,
  embeddedImages: Map<string, string>,
  imgDir: string,
  store: StoreAdapter
): string {
  const filtered = g.movies.filter(m => matchesSearch(m, searchTerm));
  if (!filtered.length) return '';
  const num = String(idx + 1).padStart(2, '0');
  return `<section class="row" style="animation-delay:${Math.min(idx * 0.05, 0.4)}s">
    <div class="row-header">
      <div class="row-num-block">${num}</div>
      <div class="row-text">
        <div class="row-eyebrow">Mission ${num}</div>
        <h2 class="row-title">${escapeHtml(g.label)}</h2>
      </div>
      <div class="row-meta">
        <span class="big">${filtered.length}</span>
        <span class="small">${filtered.length !== g.movies.length ? '/ ' + g.movies.length + ' films' : 'films'}</span>
      </div>
    </div>
    <div class="carousel-wrap">
      <button class="carousel-btn prev" aria-label="Indietro"><span>◀</span></button>
      <div class="carousel">${filtered.map(m => cardHTML(m, embeddedImages, imgDir, store)).join('')}</div>
      <button class="carousel-btn next" aria-label="Avanti"><span>▶</span></button>
    </div>
  </section>`;
}

export function renderMain(
  grouper: Grouper,
  searchTerm: string,
  embeddedImages: Map<string, string>,
  imgDir: string,
  store: StoreAdapter
): void {
  const main = document.getElementById('main')!;
  const html = grouper.groups
    .map((g, i) => rowHTML(g, i, searchTerm, embeddedImages, imgDir, store))
    .filter(Boolean)
    .join('');
  main.innerHTML = html || '<div class="empty">No targets found</div>';
}

export function attachHandlers(
  movies: Movie[],
  embeddedImages: Map<string, string>,
  imgDir: string,
  onOpenModal: OpenModalFn
): void {
  const mainEl = document.getElementById('main')!;
  mainEl.querySelectorAll<HTMLElement>('.carousel-wrap').forEach(wrap => {
    const car = wrap.querySelector('.carousel') as HTMLElement;
    wrap.querySelector<HTMLElement>('.prev')!.onclick = () =>
      car.scrollBy({ left: -car.clientWidth * 0.7, behavior: 'smooth' });
    wrap.querySelector<HTMLElement>('.next')!.onclick = () =>
      car.scrollBy({ left: car.clientWidth * 0.7, behavior: 'smooth' });
  });

  mainEl.querySelectorAll<HTMLElement>('.card').forEach(card => {
    card.onclick = () => onOpenModal(parseInt(card.dataset.id!, 10), movies, embeddedImages, imgDir);
    const img = card.querySelector('img');
    if (img) {
      img.addEventListener('error', () => {
        const m = movies.find(x => x.id === parseInt(card.dataset.id!, 10));
        if (!m) return;
        const ph = document.createElement('div');
        ph.className = 'placeholder';
        ph.innerHTML = `<div class="pl-title">${escapeHtml(m.title)}</div>${m.year ? `<div class="pl-year">${m.year}</div>` : ''}`;
        img.replaceWith(ph);
      }, { once: true });
    }
  });
}
