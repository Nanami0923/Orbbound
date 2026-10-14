import type { CampaignLevel } from '../content/campaign';
import type { GameState } from '../core/types';
import { formatDuration } from '../storage/history';

export function starBudget(level:CampaignLevel, step:number, elapsedMs:number):string {
  const used = level.timeLimitMs ? elapsedMs : step;
  const tier = used <= level.gold ? '三星' : used <= level.silver ? '二星' : '通关';
  const threshold = tier === '三星' ? level.gold : tier === '二星' ? level.silver : level.timeLimitMs ?? level.maxShots;
  const remaining = Math.max(0,threshold-used);
  return `${tier}预算 · ${level.timeLimitMs ? `还可用 ${formatDuration(remaining + 999)}` : `还可用 ${remaining} 发`}`;
}
export function failureAdvice(state:Pick<GameState,'endReason'|'targets'>, level?:CampaignLevel):string {
  if(state.endReason === 'shots') return '发数用尽：先寻找能切断整片支撑的落点，减少零散补球。';
  if(state.endReason === 'timeout') return '时间用尽：先处理大块支撑；掉落期间可以提前调整下一发方向。';
  if(state.targets?.length) return `还剩 ${state.targets.length} 个目标：消除目标上方支撑，也能让白圈目标掉落。`;
  return level?.hint ?? '棋盘触底：留意下一次下压，优先消掉上方支撑，为底部留出空间。';
}
export function escapeText(text:string):string { return text.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!)); }
