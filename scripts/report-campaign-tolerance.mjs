import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

mkdirSync('.build', { recursive: true });
await build({ stdin: { contents: `export * from './src/core/campaign'; export * from './src/core/engine'; export * from './src/core/physics'; export * from './src/core/tolerance'; export * from './src/content/campaign'; export * from './src/content/game-config';`, resolveDir: process.cwd() }, outfile: '.build/campaign-tolerance-module.mjs', bundle: true, platform: 'node', format: 'esm' });
const { createCampaign, getLevel, resolveShot, traceShot, landingTolerance, BOARD_GEOMETRY } = await import(pathToFileURL(resolve('.build/campaign-tolerance-module.mjs')));
const routes = JSON.parse(readFileSync('tests/fixtures/campaign-solutions.json', 'utf8'));
const levels = [];
for (const route of routes) {
  let state = createCampaign(route.id);
  const shots = [];
  for (const [index, angle] of route.angles.entries()) {
    assert.equal(state.status, 'READY');
    const geometry = { ...BOARD_GEOMETRY, rowOffset: state.rowOffset ?? 0, ceilingRow: state.ceilingRow ?? 0, top: BOARD_GEOMETRY.top + (state.ceilingRow ?? 0) * BOARD_GEOMETRY.rowStep };
    const trace = traceShot(state.board, angle * Math.PI / 180, geometry);
    const tolerance = landingTolerance(state.board, angle, geometry);
    assert.ok(trace.landing && tolerance, `Unreachable reference shot ${route.id}:${index + 1}`);
    shots.push({ shot: index + 1, angle, bounced: trace.bounced, ...tolerance });
    state = resolveShot(state, trace.landing).state;
  }
  assert.equal(state.status, 'WON', `Reference route ${route.id} no longer wins`);
  const level = getLevel(route.id), sorted = [...shots].sort((a, b) => a.width - b.width);
  levels.push({ id: route.id, name: level.name, chapter: level.chapter, timeLimitMs: level.timeLimitMs, shots, minimumWidth: sorted[0].width, narrowUnderHalfDegree: shots.filter(shot => shot.width < 0.5).length, critical: sorted.slice(0, 3) });
  process.stdout.write(`Level ${route.id}: ${shots.length} shots, narrowest ${sorted[0].width.toFixed(3)} degrees\n`);
}
const round = value => Number(value.toFixed(4));
const version = '4.2.0';
const all = levels.flatMap(level => level.shots);
const report = { version, method: 'Sample 0.05 degrees outward around each reference; refine the first changed-landing boundary to <= 0.005 degrees; cap at +/- 12 degrees and legal +/- 78 degrees.', humanTested: false, routeCount: levels.length, shotCount: all.length, levels };
writeFileSync(`docs/releases/${version}-campaign-angle-tolerance.json`, JSON.stringify(report, (_key, value) => typeof value === 'number' ? round(value) : value, 2) + '\n');
const lines = [
  `# ${version} 闯关参考路线角度容差报告`, '',
  '本报告由 `node scripts/report-campaign-tolerance.mjs` 使用现有 30 关参考路线、真实弹道和规则生成。未改变布局、发数或三星阈值。', '',
  '**这是参考路线周围的采样结果，不是连续数学证明，也不替代真人触控、鼠标或限时三星测试。真人验收尚未完成。**', '',
  '方法：每发保留此前参考操作后的棋盘，从参考角度向两边以 0.05° 采样，遇到首个不同落点后细化到 ≤0.005°；最多检查参考角度 ±12°，合法操作范围为 ±78°。同落点通常产生相同消除，但本报告不寻找不同落点的等价解，也不声称参考路线最优。容差宽度是两端之差，不能直接当成手指允许误差。', '',
  `共 ${levels.length} 关、${all.length} 发；参考路径全部通关。局部宽度 <0.5° 的发射有 ${all.filter(shot => shot.width < 0.5).length} 发，优先用于人工检查。限时关回放没有施加真人操作时间。`, '',
  '| 关卡 | 参考发数 | 最窄局部宽度 | <0.5° 发数 | 三个最窄参考发射（发序 / 参考角度 / 区间） |',
  '| --- | ---: | ---: | ---: | --- |',
];
for (const level of levels) {
  const critical = level.critical.map(shot => `${shot.shot} / ${shot.angle.toFixed(2)}° / [${shot.minAngle.toFixed(3)}, ${shot.maxAngle.toFixed(3)}]${shot.bounced ? ' 反弹' : ''}${shot.capped ? '（采样上限）' : ''}`).join('<br>');
  lines.push(`| ${level.id}. ${level.name} | ${level.shots.length} | ${level.minimumWidth.toFixed(3)}° | ${level.narrowUnderHalfDegree} | ${critical} |`);
}
lines.push('', '完整逐发数据见同目录的 `4.2.0-campaign-angle-tolerance.json`。下一步应在真实 Android 普通/沉浸控制与 Windows 键鼠上复核窄区间、章首、新机制及限时关，记录实际重试与操作时间，再决定是否调整预算。', '');
writeFileSync(`docs/releases/${version}-campaign-angle-tolerance.md`, lines.join('\n'));
