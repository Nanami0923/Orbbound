import { expect, it } from 'vitest';
import { availablePauseShortcut, v5CountdownParts } from '../src/ui/v5-hud';

it.each([
  ['再发射 10 次', ['10', '次']], ['剩余 2 发', ['2', '发']],
  ['1 次', ['1', '次']], ['本局结束', null], ['限时清空', null], ['下一发后下降', null],
])('splits numeric resource labels without inventing numbers for %s', (label, expected) => {
  expect(v5CountdownParts(String(label))).toEqual(expected);
});

it('leaves user-assigned P bindings intact instead of claiming a conflicting pause key', () => {
  const shortcuts = { fire: 'KeyP', save: 'Escape' };
  expect(availablePauseShortcut(shortcuts)).toBeUndefined();
  expect(shortcuts).toEqual({ fire: 'KeyP', save: 'Escape' });
  expect(availablePauseShortcut({ fire: 'Space', save: 'Escape' })).toBe('KeyP');
});
