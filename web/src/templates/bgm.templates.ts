import { html } from 'lit';
import type { TemplateResult } from 'lit';

export interface BgmTrack {
  /** URL completo da dare a `<audio src>`. */
  url: string;
  /** Nome file — chiave stabile di selezione e persistenza. */
  file: string;
  /** Etichetta mostrata nel dropdown. */
  label: string;
}

export interface BgmState {
  tracks: BgmTrack[];
  currentFile: string | null;
  isPlaying: boolean;
  /** Volume 0..1. */
  volume: number;
}

export interface BgmHandlers {
  onSelect: (file: string) => void;
  onToggle: () => void;
  onVolume: (v: number) => void;
}

export function bgmWidgetTemplate(state: BgmState, h: BgmHandlers): TemplateResult {
  const { tracks, currentFile, isPlaying, volume } = state;
  return html`
    <span class="bgm-icon" aria-hidden="true">♪</span>
    <div class="bgm-select-wrap">
      <select
        class="bgm-select"
        aria-label="Traccia musicale"
        @change=${(e: Event) => h.onSelect((e.target as HTMLSelectElement).value)}>
        ${currentFile === null
          ? html`<option value="" disabled selected>— Traccia —</option>`
          : ''}
        ${tracks.map(t => html`<option value=${t.file}>${t.label}</option>`)}
      </select>
    </div>
    <button
      class="bgm-play"
      aria-label=${isPlaying ? 'Pausa' : 'Riproduci'}
      aria-pressed=${isPlaying}
      ?disabled=${currentFile === null}
      @click=${h.onToggle}>${isPlaying ? '⏸' : '▶'}</button>
    <input
      class="bgm-volume"
      type="range"
      min="0"
      max="1"
      step="0.01"
      aria-label="Volume"
      .value=${String(volume)}
      @input=${(e: Event) => h.onVolume(Number((e.target as HTMLInputElement).value))}>
  `;
}
