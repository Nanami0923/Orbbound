export const DEFAULT_SHORTCUTS = {
  fire: 'Space', left: 'ArrowLeft', right: 'ArrowRight', quickLeft: 'KeyQ', quickRight: 'KeyE',
  save: 'Escape', settle: 'KeyF', restart: 'KeyR', settings: 'KeyS', history: 'KeyH', help: 'KeyI',
};
export type ShortcutAction = keyof typeof DEFAULT_SHORTCUTS;
export type Shortcuts = Record<ShortcutAction, string>;
export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  fire: '发射', left: '向左转', right: '向右转', quickLeft: '向左快转 30°', quickRight: '向右快转 30°',
  save: '存档并返回首页', settle: '结算本局', restart: '重新开始', settings: '游戏设置', history: '历史与排行', help: '玩法提示',
};
export const validShortcutCode = (code: unknown): code is string => typeof code === 'string' && /^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|Space|Escape|Enter)$/.test(code);
export function validShortcuts(value: unknown): value is Shortcuts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === Object.keys(DEFAULT_SHORTCUTS).length && entries.every(([key, code]) => Object.hasOwn(DEFAULT_SHORTCUTS, key) && validShortcutCode(code)) && new Set(entries.map(([,code]) => code)).size === entries.length;
}
export const loadShortcuts = (value: unknown): Shortcuts => ({ ...(validShortcuts(value) ? value : DEFAULT_SHORTCUTS) });
export function shortcutLabel(code: string): string {
  return ({ Space: '空格', Escape: 'Esc', Enter: 'Enter', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' } as Record<string,string>)[code] ?? code.replace(/^(Key|Digit)/, '');
}
export function shortcutAction(event: KeyboardEvent, shortcuts: Shortcuts): ShortcutAction | undefined {
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing) return;
  return (Object.keys(shortcuts) as ShortcutAction[]).find(action => shortcuts[action] === event.code);
}
