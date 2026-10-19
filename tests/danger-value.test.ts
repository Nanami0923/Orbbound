import { expect, it } from 'vitest';
import { dangerValueParts } from '../src/ui/danger-value';

it('separates Android countdown digits from their small unit and leaves status labels intact', () => {
  expect(dangerValueParts('再发射 10 次')).toEqual({ number: '10', unit: '次' });
  expect(dangerValueParts('剩余 3 发')).toEqual({ number: '3', unit: '发' });
  expect(dangerValueParts('1 次')).toEqual({ number: '1', unit: '次' });
  expect(dangerValueParts('本局结束')).toBeNull();
  expect(dangerValueParts('限时清空')).toBeNull();
});
