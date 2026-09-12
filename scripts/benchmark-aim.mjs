import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import ts from 'typescript';
const cache = new Map();
function load(file, override) {
  file = path.resolve(file);
  if (!override && cache.has(file)) return cache.get(file);
  const source = override ?? fs.readFileSync(file, 'utf8');
  const code = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  new Function('require','module','exports',code)(id=>load(path.resolve(path.dirname(file),id+'.ts')),module,module.exports);
  if(!override) cache.set(file,module.exports);
  return module.exports;
}
const current=load('src/core/physics.ts');
const old=load('src/core/physics.ts',execFileSync('git',['show','v1.4.0:src/core/physics.ts'],{encoding:'utf8'}));
const {createGameState}=load('src/core/engine.ts');
const {BOARD_GEOMETRY}=load('src/content/game-config.ts');
const inputs=Array.from({length:500},(_,i)=>[createGameState(['easy','normal','hard'][i%3],i+1).board,(-78+(i*17)%157)*Math.PI/180,BOARD_GEOMETRY]);
for(const input of inputs) if(JSON.stringify(current.traceShot(...input))!==JSON.stringify(old.traceShot(...input))) throw Error('Trace mismatch');
function bench(fn){ const start=performance.now();for(const input of inputs) fn(...input);return performance.now()-start; }
bench(current.traceShot);bench(old.traceShot);
console.log(JSON.stringify({identicalTraces:inputs.length,baselineMs:bench(old.traceShot),optimizedMs:bench(current.traceShot)}));
