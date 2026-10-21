import { expect, it, vi } from 'vitest';
import { createMatch } from '../src/lan/authority';
import { LAN_RULES_HASH } from '../src/lan/protocol';
import { formatLanScore, lanMatchLayoutMarkup, lanModeName, lanNetworkLabel, lanStatusSummary } from '../src/ui/lan-match-layout';

it('puts the single Android next-ball preview beside the portrait HUD and keeps opponents in their own group', () => {
  vi.stubGlobal('document', { documentElement: { classList: { contains: (value: string) => value === 'android-v5' } } });
  try {
    const markup = lanMatchLayoutMarkup([{ id: 'guest', name: '朋友' }]);
    expect(markup.match(/id="lan-next-orb-preview"/g)).toHaveLength(1);
    expect(markup.slice(0, markup.indexOf('class="lan-play-space"'))).toContain('id="lan-next-orb-preview"');
    const status = markup.slice(markup.indexOf('class="lan-android-status-line"'), markup.indexOf('<div class="lan-game-layout"'));
    expect(status).toContain('class="lan-watch-slot"><button id="lan-watch-self"');
    expect(status).toContain('id="lan-pause"'); expect(status).toContain('id="lan-settings"');
    expect(status).toContain('id="lan-network" class="lan-network"');
    expect(markup.match(/id="lan-watch-self"/g)).toHaveLength(1);
    expect(markup.slice(markup.indexOf('<aside'))).not.toContain('id="lan-next-orb-preview"');
    expect(markup).toContain('class="lan-side game-sidebar" aria-label="其他选手"');
  } finally { vi.unstubAllGlobals(); }
});

it.each([2, 3, 4])('gives a %i-player match exactly one accessible card per opponent and one shared preview', count => {
  const opponents = Array.from({ length: count - 1 }, (_, index) => ({ id: `guest${index}`, name: `朋友 ${index} <&>` }));
  const markup = lanMatchLayoutMarkup(opponents);
  expect(markup.match(/class="lan-opponent sidebar-card"/g)).toHaveLength(count - 1);
  expect(markup.match(/data-lan-player-board=/g)).toHaveLength(count - 1);
  expect(markup).toContain(`--lan-opponent-count:${count - 1}`);
  expect(markup.match(/id="lan-other-board"/g)).toHaveLength(1);
  expect(markup.match(/id="lan-next-orb-preview"/g)).toHaveLength(1);
  expect(markup).toContain('next-card orb-preview-card');
  expect(markup).toContain('aria-label="查看朋友 0 &lt;&amp;&gt;的棋盘"');
  expect(markup.match(/aria-pressed="false"/g)).toHaveLength(count - 1);
  expect(markup).toContain('id="lan-watch-self"');
});

it('gives the time label and digits a separate group from the network sample and controls', () => {
  const markup = lanMatchLayoutMarkup([{ id: 'guest', name: '朋友' }]);
  const time = markup.match(/<div class="lan-time header-stat danger-stat">(.*?)<\/div>/)?.[1];
  expect(time).toContain('剩余时间'); expect(time).toContain('id="lan-clock"'); expect(time).not.toContain('lan-network');
  expect(markup).toContain('id="lan-network" class="lan-network">延迟待测');
  expect(markup).toContain('class="lan-play-space"');
  expect(markup).toContain('id="lan-pause-request" hidden');
});

it('reports only valid RTT samples and keeps unknown delay distinct from zero', () => {
  for (const value of [0, -1, NaN, Infinity]) expect(lanNetworkLabel(value)).toBe('延迟待测');
  expect(lanNetworkLabel(1)).toBe('延迟 1 ms'); expect(lanNetworkLabel(65.4)).toBe('延迟 65 ms'); expect(lanNetworkLabel(1250)).toBe('延迟 1250 ms');
});

it('formats the LAN primary score like the solo HUD without truncating high scores', () => {
  expect(formatLanScore(0)).toBe('00000');
  expect(formatLanScore(42.9)).toBe('00042');
  expect(formatLanScore(123456)).toBe('123456');
});

it('keeps score pressure compact while preserving the actual match size', () => {
  const match = createMatch({ matchId: 'hud', seed: 42, durationMs: 180000, difficultyId: 'normal', playerIds: ['host', 'guest'] });
  match.players.host.state.danger = 30;
  expect(lanStatusSummary(match.players.host, 2, 1000)).toEqual({ progress: '压力 30%', defense: '', queue: '2 人随机竞分', warning: '' });
});

it('distinguishes the current random score rules from historical same-board rules', () => {
  expect(lanModeName('score', LAN_RULES_HASH)).toBe('随机竞分');
  expect(lanModeName('score', '4e2a4139')).toBe('同图竞分（旧规则）');
  expect(lanModeName('score', 'older-4.3-hash')).toBe('同图竞分（旧规则）');
  expect(lanModeName('score')).toBe('竞分');
  expect(lanModeName('battle', 'older-hash')).toBe('连锁对战');
});

it('reuses the platform game components and preserves every bound LAN control id once', () => {
  const markup = lanMatchLayoutMarkup([{ id: 'guest', name: '朋友' }]);
  for (const className of ['game-header', 'header-stat score-stat', 'header-stat danger-stat', 'sidebar-card next-card orb-preview-card', 'game-sidebar', 'board-wrap game-container', 'mobile-controls', 'steering-sliders', 'steering-control']) {
    expect(markup).toContain(className);
  }
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ['lan-self-score', 'lan-clock', 'lan-next-orb-preview', 'lan-network', 'lan-pause', 'lan-settings', 'lan-watch-self', 'lan-self-board', 'lan-other-board', 'lan-angle', 'lan-fine', 'lan-fire', 'lan-notice']) {
    expect(ids).toContain(id);
  }
});

it('keeps incoming progress, defense, queue count and the active attack countdown independent without changing state', () => {
  const match = createMatch({ matchId: 'hud', mode: 'battle', seed: 42, durationMs: 180000, difficultyId: 'normal', playerIds: ['host', 'guest', 'guest2', 'guest3'] });
  const player = match.players.host, battle = player.battle!;
  battle.incomingBalls = 7; battle.defenseRemainder = 5;
  battle.pendingAttacks.push({ attackId: 'attack', sourcePlayerId: 'guest', sourcePlayerIds: ['guest'], targetPlayerId: 'host', createdAtMs: 1000, notBeforeAtMs: 3000, sourceEventSeq: 1 });
  const before = structuredClone(player);
  expect(lanStatusSummary(player, 4, 2001)).toEqual({ progress: '来袭 7/36', defense: '防御 5/12', queue: '排队 1 行', warning: '攻击预告 · 1 秒后下压' });
  expect(lanStatusSummary(player, 4, 3001).warning).toBe('攻击预告 · 0 秒后下压');
  expect(player).toEqual(before);
  battle.pendingAttacks = []; expect(lanStatusSummary(player, 4, 4000).warning).toBe('');
});
