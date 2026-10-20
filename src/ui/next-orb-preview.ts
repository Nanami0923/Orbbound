import { getOrbTheme, getOrbThemeVariant } from '../content/theme';
import { orbArtworkSvgMarkup } from '../content/orb-symbol-artwork';
import { escapeText } from './progress-feedback';
import './next-orb-preview.css';

/** All modes mount the same preview; callers choose a slot and the state actually being presented. */
export function nextOrbPreviewMarkup(id: string): string {
  return `<div class="next-card orb-preview-card"><div class="card-kicker">下一球</div><div class="next-preview"><div id="${escapeText(id)}" class="dom-orb" aria-label="下一球"></div></div></div>`;
}

export function updateOrbPreview(element: HTMLElement | null, color: number): void {
  if (!element) return;
  const variant = getOrbThemeVariant();
  if (element.dataset.colorId === String(color) && element.dataset.themeVariant === variant) return;
  const theme = getOrbTheme(color, variant);
  element.dataset.colorId = String(color); element.dataset.themeVariant = variant; element.dataset.symbol = theme.symbol;
  if (variant === 'v5') {
    element.innerHTML = orbArtworkSvgMarkup(theme.id, theme.cssColor, theme.ink);
    element.style.backgroundColor = 'transparent';
  } else {
    element.innerHTML = '';
    element.style.backgroundColor = theme.cssColor;
  }
  element.style.setProperty('--orb-ink', theme.ink);
}
