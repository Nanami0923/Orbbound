import type { ColorId } from '../core/types';

export interface OrbTheme {
  id: ColorId;
  name: string;
  symbol: string;
  color: number;
  cssColor: string;
  ink: string;
  glow: number;
}

export const ORB_THEMES: OrbTheme[] = [
  { id: 0, name: '珊瑚', symbol: '●', color: 0xff6f72, cssColor: '#ff777b', ink: '#3b2036', glow: 0xffa5a6 },
  { id: 1, name: '青柠', symbol: '◆', color: 0x63d7bd, cssColor: '#63d7bd', ink: '#123c44', glow: 0xa8f0d7 },
  { id: 2, name: '金星', symbol: '✦', color: 0xf6c85f, cssColor: '#f6c85f', ink: '#493521', glow: 0xffe1a1 },
  { id: 3, name: '紫晶', symbol: '▲', color: 0x9c83ff, cssColor: '#9c83ff', ink: '#2d2856', glow: 0xc3b5ff },
  { id: 4, name: '晴蓝', symbol: '✚', color: 0x67a9f7, cssColor: '#67a9f7', ink: '#153355', glow: 0xa9ceff },
  { id: 5, name: '玫红', symbol: '✿', color: 0xe985ba, cssColor: '#e985ba', ink: '#4b2641', glow: 0xffb8df },
];

export const ORB_THEMES_V5: OrbTheme[] = [
  { id: 0, name: '珊瑚', symbol: '●', color: 0xdf827e, cssColor: '#df827e', ink: '#392936', glow: 0xe7a29b },
  { id: 1, name: '薄荷', symbol: '◆', color: 0x76bdab, cssColor: '#76bdab', ink: '#173a3a', glow: 0x9bd0bf },
  { id: 2, name: '金色', symbol: '✦', color: 0xd7b86c, cssColor: '#d7b86c', ink: '#463a25', glow: 0xddc88c },
  { id: 3, name: '紫晶', symbol: '▲', color: 0xa18bd3, cssColor: '#a18bd3', ink: '#302844', glow: 0xbaa9de },
  { id: 4, name: '晴蓝', symbol: '✚', color: 0x77a5cf, cssColor: '#77a5cf', ink: '#1e3550', glow: 0x9bbbe0 },
  { id: 5, name: '玫红', symbol: '✿', color: 0xca8da9, cssColor: '#ca8da9', ink: '#482d3d', glow: 0xddadc1 },
];

export type OrbThemeVariant = 'legacy' | 'v5';

/** V5 is activated only by the platform root classes set by the app bootstrap. */
export function getOrbThemeVariant(): OrbThemeVariant {
  const root = typeof document !== 'undefined' ? document.documentElement : undefined;
  return root?.classList?.contains('windows-v5') || root?.classList?.contains('android-v5') ? 'v5' : 'legacy';
}

export function getOrbTheme(id: ColorId, variant: OrbThemeVariant = getOrbThemeVariant()): OrbTheme {
  const themes = variant === 'v5' ? ORB_THEMES_V5 : ORB_THEMES;
  return themes[id] ?? themes[0];
}

