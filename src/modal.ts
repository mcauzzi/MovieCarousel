import type { Movie } from './parser';
import { escapeHtml, coverUrl } from './utils';

const modalEl = document.getElementById('modal')!;
const modalContent = document.getElementById('modalContent')!;

export function openModal(
  id: number,
  movies: Movie[],
  embeddedImages: Map<string, string>,
  imgDir: string
): void {
  const m = movies.find(x => x.id === id);
  if (!m) return;

  const url = coverUrl(m, embeddedImages, imgDir);
  const cover = url
    ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(m.title)}">`
    : `<div class="placeholder">${escapeHtml(m.title)}</div>`;

  const meta: string[] = [];
  if (m.year) meta.push(String(m.year));
  if (m['running-time']) meta.push(m['running-time'] + ' min');
  if (m.nationality?.length) {
    meta.push(m.nationality.join(', '));
  }

  const dl: string[] = [];
  function addField(label: string, val: unknown, asPills = false) {
    if (!val) return;
    const arr = Array.isArray(val) ? (val as string[]) : [String(val)];
    if (!arr.length) return;
    const content = asPills
      ? arr.map(v => `<span class="pill">${escapeHtml(v)}</span>`).join('')
      : escapeHtml(arr.join(', '));
    dl.push(`<dt>${label}</dt><dd>${content}</dd>`);
  }

  addField('Regista', m.director);
  addField('Genere', m.genre, true);
  addField('Studio', m.studio);
  addField('Sceneggiatura', m.writer);
  addField('Musiche', m.composer);
  addField('Produttore', m.producer);
  addField('Lingue', m.language, true);

  const castHTML = m.cast?.length
    ? `<div class="cast-section"><h3>Cast</h3><div class="cast-list">${
        m.cast.slice(0, 16).map(c =>
          `<div><span class="actor">${escapeHtml(c.actor)}</span>${
            c.role ? `<span class="role">${escapeHtml(c.role)}</span>` : ''
          }</div>`
        ).join('')
      }</div></div>`
    : '';

  modalContent.innerHTML = `
    <div class="modal-cover">${cover}</div>
    <div class="modal-body">
      <button class="modal-close" aria-label="Chiudi">✕</button>
      <div class="m-eyebrow">▰ TARGET FILE ▰</div>
      <h2>${escapeHtml(m.title)}</h2>
      <div class="m-subtitle">${escapeHtml(meta.join(' · '))}</div>
      ${m.plot ? `<p class="m-plot">${escapeHtml(m.plot)}</p>` : ''}
      <dl class="modal-meta">${dl.join('')}</dl>
      ${castHTML}
    </div>`;

  modalContent.querySelector('.modal-close')!.addEventListener('click', closeModal);
  modalEl.classList.add('show');
  document.body.style.overflow = 'hidden';
}

export function closeModal(): void {
  modalEl.classList.remove('show');
  document.body.style.overflow = '';
}

modalEl.addEventListener('click', e => { if (e.target === modalEl) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
