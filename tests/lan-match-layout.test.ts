import { expect, it, vi } from 'vitest';
import { createMatch } from '../src/lan/authority';
import { lanMatchLayoutMarkup, lanNetworkLabel, lanStatusSummary } from '../src/ui/lan-match-layout';

it('puts the single Android next-ball preview beside the portrait HUD and keeps opponents in their own group', () => {
  vi.stubGlobal('document', { documentElement: { classList: { contains: (value: string) => value === 'android-v5' } } });
  try {
    const markup = lanMatchLayoutMarkup([{ id: 'guest', name: '朋友' }]);
    expect(markup.match(/id="lan-next-orb-preview"/g)).toHaveLength(1);
    expect(markup.slice(0, markup.indexOf('class="lan-play-space"'))).toContain('id="lan-next-orb-preview"');
    expect(markup.slice(0, markup.indexOf('class="lan-play-space"'))).toContain('class="lan-watch-slot"><button id="lan-watch-self"');
    expect(markup.match(/id="lan-watch-self"/g)).toHaveLength(1);
    expect(markup.slice(markup.indexOf('<aside'))).not.toContain('id="lan-next-orb-preview"');
    expect(markup).toContain('class="lan-side" aria-label="其他选手"');
  } finally { vi.unstubAllGlobals(); }
});

it.each([2, 3, 4])('gives a %i-player match exactly one accessible card per opponent and one shared preview', count => {
  const opponents = Array.from({ length: count - 1 }, (_, index) => ({ id: `guest${index}`, name: `朋友 ${index} <&>` }));
  const markup = lanMatchLayoutMarkup(opponents);
  expect(markup.match(/class="lan-opponent"/g)).toHaveLength(count - 1);
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
  const time = markup.match(/<div class="lan-time">(.*?)<\/div>/)?.[1];
  expect(time).toContain('剩余时间'); expect(time).toContain('id="lan-clock"'); expect(time).not.toContain('lan-network');
  expect(markup).toContain('id="lan-network" class="lan-network">延迟待测');
  expect(markup).toContain('class="lan-play-space"');
  expect(markup).toContain('id="lan-pause-request" hidden');
});

it('reports only valid RTT samples and keeps unknown delay distinct from zero', () => {
  for (const value of [0, -1, NaN, Infinity]) expect(lanNetworkLabel(value)).toBe('延迟待测');
  expect(lanNetworkLabel(1)).toBe('延迟 1 ms'); expect(lanNetworkLabel(65.4)).toBe('延迟 65 ms'); expect(lanNetworkLabel(1250)).toBe('延迟 1250 ms');
});

it('keeps score pressure compact while preserving the actual match size', () => {
  const match = createMatch({ matchId: 'hud', seed: 42, durationMs: 180000, difficultyId: 'normal', playerIds: ['host', 'guest'] });
  match.players.host.state.danger = 30;
  expect(lanStatusSummary(match.players.host, 2, 1000)).toEqual({ progress: '压力 30%', defense: '', queue: '2 人竞分', warning: '' });
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
