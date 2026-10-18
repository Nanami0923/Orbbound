import type { PlayerMatchState } from '../lan/protocol';
import { escapeText } from './progress-feedback';
import { nextOrbPreviewMarkup } from './next-orb-preview';

export function lanNetworkLabel(rtt: number): string {
  return Number.isFinite(rtt) && rtt > 0 ? `延迟 ${Math.round(rtt)} ms` : '延迟待测';
}

export function lanStatusSummary(player: PlayerMatchState, playerCount: number, logicalTime: number) {
  const battle = player.battle, next = battle?.pendingAttacks[0];
  return {
    progress: battle ? `来袭 ${battle.incomingBalls}/${battle.threshold}` : `压力 ${player.state.danger}%`,
    defense: battle ? `防御 ${battle.defenseRemainder}/12` : '',
    queue: battle ? `排队 ${battle.pendingAttacks.length} 行` : `${playerCount} 人竞分`,
    warning: next ? `攻击预告 · ${Math.max(0, Math.ceil((next.notBeforeAtMs - logicalTime) / 1000))} 秒后下压` : '',
  };
}

export function lanMatchLayoutMarkup(opponents: ReadonlyArray<{ id: string; name: string }>): string {
  const escape = (value: string) => escapeText(value);
  return `<div class="lan-match-hud">
    <div class="lan-self-summary"><span id="lan-self-name"></span><strong id="lan-self-score">0</strong><small id="lan-self-wave"></small></div>
    <div class="lan-time"><small>剩余时间</small><strong id="lan-clock">3:00</strong></div>
    <span id="lan-network" class="lan-network">延迟待测</span>
    <div class="lan-hud-actions"><button id="lan-pause" class="quiet-button" type="button">暂停</button><button id="lan-settings" class="quiet-button" type="button">设置</button></div>
  </div>
  <div class="lan-play-space"><div class="lan-status-slot"><div id="lan-attack-bar" class="lan-attack-bar"><span id="lan-status-progress"></span><span id="lan-status-defense" hidden></span><span id="lan-status-queue"></span><span id="lan-attack-warning" class="lan-attack-warning" role="status" hidden></span></div><div id="lan-pause-request" hidden></div></div>
  <div class="lan-game-layout"><div class="lan-own-column"><div class="lan-board-wrap"><canvas id="lan-self-board" width="640" height="760" aria-label="自己的联机棋盘"></canvas><div id="lan-game-overlay" class="lan-game-overlay" hidden></div></div></div>
    <aside class="lan-side" aria-label="下一球与其他选手"><div class="lan-preview-slot"><button id="lan-watch-self" class="quiet-button" type="button" hidden>返回自己</button>${nextOrbPreviewMarkup('lan-next-orb-preview')}</div>
      <div class="lan-opponents" style="--lan-opponent-count:${Math.max(1, Math.min(3, opponents.length))}" aria-label="其他选手">${opponents.map(({ id, name }, index) => `<button class="lan-opponent" type="button" data-watch="${escape(id)}" aria-pressed="false" aria-label="查看${escape(name)}的棋盘"><canvas ${index === 0 ? 'id="lan-other-board"' : ''} data-lan-player-board="${escape(id)}" width="128" height="152" aria-label="对方棋盘缩略图"></canvas><span class="lan-opponent-info"><strong data-player-name="${escape(id)}"></strong><span class="lan-opponent-meta"><small data-player-score="${escape(id)}"></small><small data-player-state="${escape(id)}"></small></span></span></button>`).join('')}</div>
    </aside>
  </div>
  <div class="lan-controls"><button id="lan-turn-left" class="quiet-button" aria-label="向左快转30度">↶ 30°</button><div class="lan-sliders"><label>瞄准 <output id="lan-angle-value">0.0°</output><input id="lan-angle" type="range" min="-78" max="78" step="0.1" value="0" aria-label="瞄准角度"></label><label>微调<input id="lan-fine" type="range" min="-100" max="100" step="1" value="0" aria-label="按住微调，松开停止"></label></div><button id="lan-turn-right" class="quiet-button" aria-label="向右快转30度">30° ↷</button><button id="lan-fire" class="primary-button">发射 ↑</button></div>
  </div><p id="lan-notice" class="lan-game-notice" role="status"></p>`;
}
