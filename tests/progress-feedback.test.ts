import {expect,it} from 'vitest';
import {getLevel} from '../src/content/campaign';
import {escapeText,failureAdvice,starBudget} from '../src/ui/progress-feedback';
it('preserves inclusive star boundaries and switches to the next budget',()=>{
  const level=getLevel(1);
  expect(starBudget(level,level.gold,0)).toBe('三星预算 · 还可用 0 发');
  expect(starBudget(level,level.gold+1,0)).toContain('二星预算');
  expect(starBudget(level,level.silver+1,0)).toContain('通关预算');
});
it('reports failure-specific advice and escapes imported text',()=>{
  expect(failureAdvice({endReason:'timeout'})).toContain('时间用尽');
  expect(failureAdvice({endReason:'shots'})).toContain('发数用尽');
  expect(escapeText('<script>"&')).toBe('&lt;script&gt;&quot;&amp;');
});
