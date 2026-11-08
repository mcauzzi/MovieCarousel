import { html } from 'lit';
import type { TemplateResult } from 'lit';
import { seededRandom } from '../utils';

/* Tipografia "a lettera anonima" (ransom note) alla Persona 5: ogni lettera è
   un ritaglio con sfondo, font e rotazione propri. La composizione è
   deterministica (seed = testo), quindi stabile tra i re-render.
   Le lettere sono aria-hidden: il chiamante mette il testo completo in
   aria-label sul contenitore (o lo affianca in un elemento visually-hidden). */

export function ransomTemplate(text: string): TemplateResult {
  const rnd = seededRandom(text);
  // Lettere raggruppate per parola (.ransom-w non va a capo): i titoli lunghi
  // si spezzano solo tra le parole, mai a metà ("SH / ELL").
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  return html`<span class="ransom" aria-hidden="true">${words.map(w =>
    html`<span class="ransom-w">${[...w].map(ch => {
      const kind = 1 + Math.floor(rnd() * 5);
      const rot = (rnd() * 16 - 8).toFixed(1);
      const y = (rnd() * 6 - 3).toFixed(1);
      const s = (0.88 + rnd() * 0.26).toFixed(2);
      return html`<span class="ransom-l rk${kind}" style="--r:${rot}deg;--y:${y}px;--s:${s}">${ch}</span>`;
    })}</span>`)}</span>`;
}

/** Versione leggera per i titoli lunghi/ripetuti: solo l'iniziale nel riquadro. */
export function capTitleTemplate(text: string): TemplateResult {
  const chars = [...text];
  return html`<span class="cap-initial">${chars[0] ?? ''}</span>${chars.slice(1).join('')}`;
}
