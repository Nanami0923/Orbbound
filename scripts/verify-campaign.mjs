import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// Replay saved search witnesses with real physics, without changing curated boards.
mkdirSync('.build', { recursive: true });
await build({ stdin: { contents: `export * from './src/core/campaign'; export * from './src/core/engine'; export * from './src/core/physics'; export * from './src/core/grid'; export * from './src/content/campaign'; export * from './src/content/game-config';`, resolveDir: process.cwd() }, outfile: '.build/campaign-check.mjs', bundle: true, platform: 'node', format: 'esm' });
const { CAMPAIGN_LEVELS, createCampaign, resolveShot, traceShot, occupiedCells, BOARD_GEOMETRY } = await import(pathToFileURL(resolve('.build/campaign-check.mjs')));
const routes = JSON.parse(readFileSync('tests/fixtures/campaign-solutions.json', 'utf8'));
assert.equal(routes.length, CAMPAIGN_LEVELS.length);
assert.equal(new Set(routes.map(route => route.id)).size, CAMPAIGN_LEVELS.length);
for (const level of CAMPAIGN_LEVELS) {
  const route = routes.find(route => route.id === level.id);
  assert.ok(route, `Missing route for level ${level.id}`);
  let state = createCampaign(level.id);
  const initial = occupiedCells(state.board).length;
  for (const angle of route.angles) {
    assert.equal(state.status, 'READY');
    assert.ok(Number.isFinite(angle) && Math.abs(angle) <= 78);
    const geometry = { ...BOARD_GEOMETRY, rowOffset: state.rowOffset, ceilingRow: state.ceilingRow ?? 0, top: BOARD_GEOMETRY.top + (state.ceilingRow ?? 0) * BOARD_GEOMETRY.rowStep };
    const trace = traceShot(state.board, angle * Math.PI / 180, geometry);
    assert.ok(trace.landing, `Unreachable shot in level ${level.id}`);
    state = resolveShot(state, trace.landing).state;
  }
  assert.equal(state.status, 'WON', `Level ${level.id} does not finish`);
  if (!level.timeLimitMs) assert.ok(state.step <= level.gold, `Gold threshold below verified route for ${level.id}`);
  console.log(`Level ${level.id}: ${initial} balls, ${state.step} verified shots, ${level.timeLimitMs ? `${level.timeLimitMs / 1000}s` : `${level.maxShots} shots`} limit`);
}
