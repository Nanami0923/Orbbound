import { getDifficulty, RULES_VERSION } from '../core/engine';
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
export function historyMarkup(data: HistoryData, top: boolean, board: string, page: number, mobile: boolean, difficulty: HistoryDifficulty = 'all', rules: HistoryRules = RULES_VERSION): string {
  const recent = historyRecords(data, board, difficulty, rules);
  const all = top ? leaderboard(data, board, difficulty, rules) : recent;
  const pageSize = top ? 10 : 20;
  const currentPage = Math.max(0, Math.min(page, Math.max(0, Math.ceil(all.length / pageSize) - 1)));
  const rows = all.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const latest = recent.find(r => r.result !== 'ABANDONED')?.id;
  const head = `<button class="history-close" data-close-modal aria-label="关闭记录">×</button><p class="eyebrow">PERSONAL / LOCAL</p><div class="history-title"><h2>${top ? '排行榜' : '历史记录'}</h2><button id="history-toggle" class="text-button">${top ? '查看历史' : '查看排行'}</button></div><div class="history-rules"><span>结算分 = 基础分 × 难度系数</span><details><summary>排名规则</summary><p>简单 ×1 · 普通 ×1.5 · 困难 ×2。结算后入榜，重开不入榜；同分时用时较短者在前，再同分则较早结算者在前。各难度保留前十名，综合榜显示其中最高十名。新旧规则分开排名，旧成绩保留；全部成绩均为你的本地记录。</p><p>新规则会替换已经从棋盘消失的下一球颜色；旧规则保留原有供球队列。</p></details></div><div class="history-segments" role="group" aria-label="选择榜单">${[['endless','无尽'],['timed-300000','5 分钟'],['timed-600000','10 分钟']].map(([key,label]) => `<button data-board="${key}" aria-pressed="${key === board}">${label}</button>`).join('')}</div><div class="history-segments history-rule-filter" role="group" aria-label="选择规则版本">${[['classic-v3','新规则'],['classic-v2','旧规则记录']].map(([key,label]) => `<button data-history-rules="${key}" aria-pressed="${key === rules}">${label}</button>`).join('')}</div><div class="history-segments history-difficulty-filter" role="group" aria-label="按难度筛选">${[['all','综合'],['easy','简单'],['normal','普通'],['hard','困难']].map(([key,label]) => `<button data-history-difficulty="${key}" aria-pressed="${key === difficulty}">${label}</button>`).join('')}</div>`;
  const empty = rules === 'classic-v3' ? '此筛选暂无新规则成绩。旧成绩可在“旧规则记录”查看。' : '此筛选暂无旧规则记录。';
  const body = mobile ? `<ol class="ranking-list">${rows.map((r,i) => `<li class="ranking-row${r.id === latest ? ' recent-best' : ''}"><span class="rank-number">${String(currentPage * pageSize + i + 1).padStart(2,'0')}</span><div class="rank-score"><strong>${r.score.toLocaleString('zh-CN')}</strong><small>基础 ${r.rawScore ?? r.score} × ${r.multiplier ?? 1}</small></div><div class="rank-status"><span>${getDifficulty(r.difficulty).label}</span><small>${results[r.result]}${r.id === latest ? ' · 最近' : ''}</small></div><div class="rank-meta"><time>${dateFormat.format(r.startedAt)}</time><span>${formatDuration(r.elapsedMs)} · ${r.shots} 球</span></div></li>`).join('') || `<li class="history-empty">${empty}</li>`}</ol>` : `<div class="history-scroll"><table><thead><tr><th>#</th><th>开始时间</th><th>结算分</th><th>难度 / 结果</th><th>用时 / 发射</th></tr></thead><tbody>${rows.map((r,i)=>`<tr${r.id === latest ? ' class="recent-best"' : ''}><td>${currentPage * pageSize + i + 1}</td><td>${dateFormat.format(r.startedAt)}</td><td><strong>${r.score.toLocaleString('zh-CN')}</strong><small class="score-formula">基础 ${r.rawScore ?? r.score} × ${r.multiplier ?? 1}</small></td><td>${getDifficulty(r.difficulty).label} / ${results[r.result]}${r.id === latest ? ' · 最近' : ''}</td><td>${formatDuration(r.elapsedMs)} / ${r.shots}</td></tr>`).join('') || `<tr><td colspan="5">${empty}</td></tr>`}</tbody></table></div>`;
  return head + historyTrend(data, board, difficulty, rules) + body + (!top ? `<div class="history-pagination"><button id="history-prev" aria-label="上一页" ${currentPage === 0 ? 'disabled' : ''}>‹</button><span>${currentPage + 1} / ${Math.max(1,Math.ceil(all.length / pageSize))}</span><button id="history-next" aria-label="下一页" ${(currentPage + 1) * pageSize >= all.length ? 'disabled' : ''}>›</button></div>` : '');
}
