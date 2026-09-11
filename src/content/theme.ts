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

export function getOrbTheme(id: ColorId): OrbTheme {
  return ORB_THEMES[id] ?? ORB_THEMES[0];
}

