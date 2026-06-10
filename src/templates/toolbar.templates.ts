import { html } from 'lit';
import type { TemplateResult } from 'lit';

export function filterButtonTemplate(count: number): TemplateResult {
  return html`⊞ FILTRI <span class="filter-badge" style="display:${count > 0 ? '' : 'none'}">${count}</span>`;
}
