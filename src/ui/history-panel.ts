import { getDifficulty, RULES_VERSION } from '../core/engine';
import { pageCapacity, viewportHeight } from './viewport-shell';
import { formatDuration, historyRecords, leaderboard, rulesLabel, type HistoryData, type RoundRecord, type HistoryDifficulty, type HistoryRules } from '../storage/history';

const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const results: Record<RoundRecord['result'], string> = { WON: '清盘', LOST: '触底', ABANDONED: '重开', TIMEOUT: '时间到', SETTLED: '主动结算' };
export function historyTrend(data: HistoryData, board: string, difficulty: HistoryDifficulty = 'all', rules: HistoryRules = RULES_VERSION): string {
  const completed = historyRecords(data, board, difficulty, rules).filter(record => record.result !== 'ABANDONED')
    .sort((a, b) => b.endedAt - a.endedAt);
  const comparisonDifficulty = difficulty === 'all' ? completed[0]?.difficulty : difficulty;
  if (!comparisonDifficulty) return '';
  const same = completed.filter(record => record.difficulty === comparisonDifficulty);
  const label = `${rulesLabel(rules)} / ${getDifficulty(comparisonDifficulty).label.split(' · ')[0]}`;
  if (same.length < 10) return `<p class="history-trend mode-note">近期对比 · ${label}：已有 ${same.length} 局，累计 10 局后比较最近 5 局与前 5 局均分。重开不计入。</p>`;
  const average = (records: RoundRecord[]) => records.reduce((sum, record) => sum + record.score, 0) / records.length;
  const recent = average(same.slice(0, 5)), previous = average(same.slice(5, 10)), difference = Math.round(recent - previous);
  const change = difference > 0 ? `提高约 ${difference.toLocaleString('zh-CN')} 分` : difference < 0 ? `下降约 ${Math.abs(difference).toLocaleString('zh-CN')} 分` : '基本持平';
  return `<p class="history-trend mode-note">近期对比 · ${label}：最近 5 局平均结算分 ${Math.round(recent).toLocaleString('zh-CN')}，前 5 局 ${Math.round(previous).toLocaleString('zh-CN')}，${change}。${difficulty === 'all' ? '按最近游玩的难度比较；' : ''}仅比较同规则、同难度，重开不计入。</p>`;
}
export function historyPageSize(mobile: boolean): number { return pageCapacity(viewportHeight(), 260, mobile ? 62 : 52, mobile ? 5 : 8); }
export function historyMarkup(data: HistoryData, top: boolean, board: string, page: number, mobile: boolean, difficulty: HistoryDifficulty = 'all', rules: HistoryRules = RULES_VERSION): string {
  const recent = historyRecords(data, board, difficulty, rules), all = top ? leaderboard(data, board, difficulty, rules) : recent;
  const pageSize = historyPageSize(mobile), currentPage = Math.max(0, Math.min(page, Math.max(0, Math.ceil(all.length / pageSize) - 1)));
  const rows = all.slice(currentPage * pageSize, (currentPage + 1) * pageSize), latest = recent.find(r => r.result !== 'ABANDONED')?.id;
  const select = (id: string, label: string, options: string[][], value: string) => `<label>${label}<select id="${id}" aria-label="${label}">${options.map(([key,text]) => `<option value="${key}" ${key === value ? 'selected' : ''}>${text}</option>`).join('')}</select></label>`;
  return `<button class="history-close" data-close-modal aria-label="关闭记录">×</button><div class="history-title"><h2>${top ? '排行榜' : '历史记录'}</h2><button id="history-toggle" class="text-button">${top ? '历史' : '排行'}</button></div>
    <div class="history-filters">${select('history-board','玩法',[['endless','无尽'],['timed-300000','5 分钟'],['timed-600000','10 分钟']],board)}${select('history-difficulty','难度',[['all','综合'],['easy','简单'],['normal','普通'],['hard','困难']],difficulty)}${select('history-rules','规则',[['classic-v3','新规则'],['classic-v2','旧规则']],rules)}</div>
    <button id="history-explain" class="text-button">排名规则与近期趋势 ›</button>
    <ol class="ranking-list">${rows.map((r,i) => `<li class="ranking-row${r.id === latest ? ' recent-best' : ''}"><span class="rank-number">${currentPage * pageSize + i + 1}</span><div class="rank-score"><strong${r.id === latest ? ' class="recent-best"' : ''}>${r.score.toLocaleString('zh-CN')}</strong><small>${dateFormat.format(r.startedAt)} · ${formatDuration(r.elapsedMs)}</small></div><div class="rank-status"><span>${getDifficulty(r.difficulty).label.split(' · ')[0]}</span><small>${results[r.result]} · ${r.shots} 球</small></div></li>`).join('') || '<li class="history-empty">此筛选暂无记录，可切换规则查看旧成绩。</li>'}</ol>
    <nav class="history-pagination page-navigation"><button id="history-prev" class="quiet-button" aria-label="上一页" ${currentPage === 0 ? 'disabled' : ''}>‹</button><span>${currentPage + 1} / ${Math.max(1,Math.ceil(all.length / pageSize))}</span><button id="history-next" class="quiet-button" aria-label="下一页" ${(currentPage + 1) * pageSize >= all.length ? 'disabled' : ''}>›</button></nav>`;
}
