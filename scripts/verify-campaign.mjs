import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

mkdirSync('.build', { recursive: true });
await build({ stdin: { contents: `export * from './src/core/campaign'; export * from './src/core/engine'; export * from './src/core/physics'; export * from './src/core/grid'; export * from './src/content/campaign'; export * from './src/content/game-config';`, resolveDir: process.cwd() }, outfile: '.build/campaign-check.mjs', bundle: true, platform: 'node', format: 'esm' });
const { CAMPAIGN_LEVELS, createCampaign, resolveShot, traceShot, occupiedCells, BOARD_GEOMETRY } = await import(pathToFileURL(resolve('.build/campaign-check.mjs')));
const routes = [];
for (const level of CAMPAIGN_LEVELS) {
  let beam = [{ state: createCampaign(level.id), angles: [], quality: 0 }], solution;
  const visited = new Set();
  for (let depth = 0; depth < Math.min(level.maxShots, 65) && !solution; depth++) {
    const candidates = [];
    for (const node of beam) {
      const { state } = node;
      const geometry = { ...BOARD_GEOMETRY, rowOffset: state.rowOffset, ceilingRow: state.ceilingRow ?? 0, top: BOARD_GEOMETRY.top + (state.ceilingRow ?? 0) * BOARD_GEOMETRY.rowStep };
      const landings = new Set();
      for (let angle = -78; angle <= 78; angle += 2) {
        const trace = traceShot(state.board, angle * Math.PI / 180, geometry);
        if (!trace.landing) continue;
        const key = `${trace.landing.row}:${trace.landing.col}`;
        if (landings.has(key)) continue;
        landings.add(key);
        const next = resolveShot(state, trace.landing).state;
        const angles = [...node.angles, angle];
        if (next.status === 'WON') { solution = { id: level.id, angles }; break; }
        if (next.status === 'LOST') continue;
        const hash = JSON.stringify([next.board,next.currentColor,next.nextColor,next.rngState,next.ceilingRow,next.targets]);
        if (visited.has(hash)) continue;
        visited.add(hash);
        const cells = occupiedCells(next.board);
        const quality = cells.length + (next.targets?.length ?? 0) * 8 + Math.max(...cells.map(c => c.row), 0) * 0.2;
        candidates.push({ state: next, angles, quality });
      }
      if (solution) break;
    }
    beam = candidates.sort((a,b) => a.quality - b.quality).slice(0, 14);
    if (!beam.length && !solution) break;
  }
  if (!solution) throw new Error(`No solution found for level ${level.id}`);
  routes.push(solution);
  console.log(`Level ${level.id}: ${solution.angles.length} shots, verified through real trajectory and rules`);
}
mkdirSync('tests/fixtures', { recursive: true });
writeFileSync('tests/fixtures/campaign-solutions.json', JSON.stringify(routes, null, 2) + '\n');
