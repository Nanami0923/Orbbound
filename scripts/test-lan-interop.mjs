import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

// Uses the shipped Java/C# transport implementations, not a JS simulation or raw-socket stand-in.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.build', 'lan-interop');
fs.mkdirSync(output, { recursive: true });
const javaHome = process.env.JAVA_HOME || 'C:/Program Files/Java/jdk-21';
const java = path.join(javaHome, 'bin', 'java.exe');
const javac = path.join(javaHome, 'bin', 'javac.exe');
const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const csharp = path.join(output, 'LanInteropHarness.exe');
function compile(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Compilation failed: ${result.error || result.stdout + result.stderr}`);
}
compile(javac, ['-encoding', 'UTF-8', '-d', output,
  'android/app/src/main/java/com/orbbound/game/LanFrameCodec.java',
  'android/app/src/main/java/com/orbbound/game/LanTcpService.java',
  'scripts/lan-interop/LanInteropHarness.java']);
compile(compiler, ['/nologo', '/target:exe', '/platform:x64', '/codepage:65001', `/out:${csharp}`,
  '/reference:System.Web.Extensions.dll', path.join(root, 'windows', 'LanService.cs'), path.join(root, 'scripts', 'lan-interop', 'LanInteropHarness.cs')]);

function launch(command, args) {
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  readline.createInterface({ input: child.stdout }).on('line', line => {
    diagnostic += `${line}\n`;
    if (line.startsWith('READY ')) readyResolve(Number(line.slice(6)));
    else console.log(line);
  });
  child.stderr.on('data', bytes => { diagnostic += bytes.toString('utf8'); });
  const timer = setTimeout(() => child.kill(), 20000);
  const done = new Promise((resolve, reject) => {
    child.on('error', error => { clearTimeout(timer); readyReject(error); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0 && diagnostic.includes('PASS ')) resolve();
      else { const error = new Error(`${command} exited ${code}\n${diagnostic}`); readyReject(error); reject(error); }
    });
  });
  done.catch(() => {});
  return { ready, done, child };
}

async function pair(hostKind) {
  const javaArgs = ['-cp', output, 'com.orbbound.game.LanInteropHarness'];
  const host = hostKind === 'Java' ? launch(java, [...javaArgs, 'host']) : launch(csharp, ['host']);
  let guest;
  try {
    const port = await host.ready;
    guest = hostKind === 'Java' ? launch(csharp, ['guest', String(port)]) : launch(java, [...javaArgs, 'guest', String(port)]);
    await Promise.all([host.done, guest.done]);
    console.log(`PASS ${hostKind} host: real Java <-> C# TCP, UTF-8/emoji, exact 64 KiB, 60 KiB Chinese, 40 ordered frames, disconnect`);
  } finally {
    if (host.child.exitCode === null) host.child.kill();
    if (guest && guest.child.exitCode === null) guest.child.kill();
  }
}

await pair('Java');
await pair('CSharp');
console.log('LAN interop passed: 2 host directions, 176 total payload deliveries. Desktop loopback only; Android device/network testing remains separate.');
