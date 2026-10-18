import { getOrbTheme } from '../content/theme';
import { escapeText } from './progress-feedback';
import './next-orb-preview.css';

/** All modes mount the same preview; callers choose a slot and the state actually being presented. */
export function nextOrbPreviewMarkup(id: string): string {
  return `<div class="next-card orb-preview-card"><div class="card-kicker">下一球</div><div class="next-preview"><div id="${escapeText(id)}" class="dom-orb" aria-label="下一球"></div></div></div>`;
}

export function updateOrbPreview(element: HTMLElement | null, color: number): void {
  if (!element || element.dataset.colorId === String(color)) return;
  const theme = getOrbTheme(color);
  element.dataset.colorId = String(color); element.dataset.symbol = theme.symbol;
  element.style.backgroundColor = theme.cssColor; element.style.setProperty('--orb-ink', theme.ink);
}
