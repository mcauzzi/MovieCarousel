import type { Movie } from './parser';
import { escapeHtml, coverUrl } from './utils';
import type { StoreAdapter, WatchStatus, Rating } from './store';
import { showToast } from './toast';

const modalEl = document.getElementById('modal')!;
const modalContent = document.getElementById('modalContent')!;

function updateCardBadge(id: number, status: WatchStatus): void {
  const card = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
  if (!card) return;
  // Il badge è figlio diretto di .card (vedi cardHTML in renderer.ts): rimuoviamo
  // tutti gli eventuali badge presenti per evitare duplicati e riallineiamo lì.
  card.querySelectorAll('.card-status-badge').forEach(b => b.remove());
  if (status) {
    const badge = document.createElement('div');
    badge.className = `card-status-badge ${status === 'seen' ? 'badge-seen' : 'badge-watchlist'}`;
    badge.textContent = status === 'seen' ? 'SEEN' : '◎';
    card.appendChild(badge);
  }
}

export function openModal(
  id: number,
  movies: Movie[],
  embeddedImages: Map<string, string>,
  imgDir: string,
  store: StoreAdapter
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
  if (m.nationality?.length) meta.push(m.nationality.join(', '));

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
      <div class="watch-status" id="watchStatus"></div>
      <div class="star-rank" id="starRank"></div>
      ${m.plot ? `<p class="m-plot">${escapeHtml(m.plot)}</p>` : ''}
      <dl class="modal-meta">${dl.join('')}</dl>
      ${castHTML}
    </div>`;

  // Watch status buttons
  const watchEl = modalContent.querySelector<HTMLElement>('#watchStatus')!;
  const statusDefs: { label: string; value: WatchStatus; toast: string }[] = [
    { label: 'SEEN',      value: 'seen',      toast: 'TARGET NEUTRALIZED' },
    { label: 'WATCHLIST', value: 'watchlist', toast: 'ADDED TO WATCHLIST' },
    { label: '—',         value: null,        toast: 'TARGET CLEARED' },
  ];
  let currentStatus = store.getStatus(id);

  function renderWatchBtns(): void {
    watchEl.innerHTML = '';
    statusDefs.forEach(s => {
      const btn = document.createElement('button');
      btn.className = 'watch-btn' + (currentStatus === s.value ? ' active' : '');
      btn.textContent = s.label;
      btn.onclick = () => {
        currentStatus = s.value;
        store.setStatus(id, s.value);
        updateCardBadge(id, s.value);
        showToast(s.toast);
        renderWatchBtns();
      };
      watchEl.appendChild(btn);
    });
  }
  renderWatchBtns();

  // Star rating
  const starEl = modalContent.querySelector<HTMLElement>('#starRank')!;
  let currentRating = store.getRating(id);

  const rankLabel = document.createElement('span');
  rankLabel.className = 'star-rank-label';
  rankLabel.textContent = 'RANK';
  starEl.appendChild(rankLabel);

  function renderStars(): void {
    starEl.querySelectorAll('.star-btn').forEach(s => s.remove());
    for (let i = 1; i <= 5; i++) {
      const btn = document.createElement('button');
      btn.className = 'star-btn' + (currentRating !== null && i <= currentRating ? ' filled' : '');
      btn.textContent = '★';
      const starIdx = i;
      btn.onclick = () => {
        const newRating = (currentRating === starIdx ? null : starIdx) as Rating;
        currentRating = newRating;
        store.setRating(id, newRating);
        showToast('INTEL UPDATED');
        renderStars();
      };
      starEl.appendChild(btn);
    }
  }
  renderStars();

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
