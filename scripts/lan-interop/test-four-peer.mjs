import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

// Actual production Java/C# TCP transports in four desktop processes; NOT four physical devices.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, '.build', 'lan-interop');
fs.mkdirSync(output, { recursive: true });
const logPath = path.join(output, 'four-peer-4.4.0.log');
const resultPath = path.join(output, 'four-peer-4.4.0.json');
let log = '';
function report(line) { log += `${line}\n`; fs.writeFileSync(logPath, log); console.log(line); }
const javaHome = process.env.JAVA_HOME || 'C:/Program Files/Java/jdk-21';
const java = path.join(javaHome, 'bin/java.exe');
const javac = path.join(javaHome, 'bin/javac.exe');
const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const executable = path.join(output, 'LanFourPeerHarness.exe');
function compile(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Compilation failed: ${result.error || result.stdout + result.stderr}`);
}
report(`Desktop loopback four-process native transport verification started ${new Date().toISOString()}`);
compile(javac, ['-encoding', 'UTF-8', '-d', output,
  path.join(root, 'android/app/src/main/java/com/orbbound/game/LanFrameCodec.java'),
  path.join(root, 'android/app/src/main/java/com/orbbound/game/LanTcpService.java'),
  path.join(root, 'scripts/lan-interop/LanFourPeerHarness.java')]);
compile(compiler, ['/nologo', '/target:exe', '/platform:x64', '/codepage:65001', `/out:${executable}`,
  '/reference:System.Web.Extensions.dll', path.join(root, 'windows/LanService.cs'), path.join(root, 'scripts/lan-interop/LanFourPeerHarness.cs')]);
function launch(runtime, args, label) {
  const command = runtime === 'Java' ? java : executable;
  const fullArgs = runtime === 'Java' ? ['-cp', output, 'com.orbbound.game.LanFourPeerHarness', ...args] : args;
  const child = spawn(command, fullArgs, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '', result, passed = false, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }); ready.catch(() => {});
  readline.createInterface({ input: child.stdout }).on('line', line => {
    diagnostics += `${line}\n`;
    if (line.startsWith('READY ')) readyResolve(Number(line.slice(6)));
    else {
      report(`[${label}] ${line}`);
      if (line.startsWith('RESULT ')) { try { result = JSON.parse(line.slice(7)); } catch (error) { diagnostics += error; } }
      if (line.startsWith('PASS ')) passed = true;
    }
  });
  child.stderr.on('data', bytes => { const line = bytes.toString('utf8'); diagnostics += line; report(`[${label}] ${line.trimEnd()}`); });
  const timer = setTimeout(() => { diagnostics += 'Process timeout after 25 seconds'; child.kill(); }, 25000);
  const done = new Promise((resolve, reject) => {
    child.on('error', error => { clearTimeout(timer); readyReject(error); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0 && passed && result) resolve(result);
      else { const error = new Error(`${label} exited ${code}: ${diagnostics}`); readyReject(error); reject(error); }
    });
  }); done.catch(() => {});
  return { child, ready, done };
}
async function star(hostRuntime) {
  const guestRuntime = hostRuntime === 'Java' ? 'CSharp' : 'Java';
  const host = launch(hostRuntime, ['host'], `${hostRuntime} host`), guests = [];
  try {
    const port = await host.ready;
    // Launch all three without waiting: host will require a simultaneous three-peer barrier.
    for (let seat = 0; seat < 3; seat++) guests.push(launch(guestRuntime, ['guest', String(port), String(seat)], `${guestRuntime} seat ${seat}`));
    const [hostStats, ...guestStats] = await Promise.all([host.done, ...guests.map(guest => guest.done)]);
    const sum = key => guestStats.reduce((total, stats) => total + stats[key], 0);
    for (const [sent, received] of [['dataSent', 'dataReceived'], ['controlsSent', 'controlsReceived'], ['bytesSent', 'bytesReceived']]) {
      if (hostStats[sent] !== sum(received) || hostStats[received] !== sum(sent)) throw new Error(`Cross-process ${sent}/${received} totals disagree`);
    }
    const dataDeliveries = hostStats.dataSent + hostStats.dataReceived;
    const controlDeliveries = hostStats.controlsSent + hostStats.controlsReceived;
    const dataBytes = hostStats.bytesSent + hostStats.bytesReceived;
    const result = { hostRuntime, guestRuntime, processes: 4, concurrentGuests: 3, afterDisconnectGuests: 2, dataDeliveries, controlDeliveries,
      totalMessageDeliveries: dataDeliveries + controlDeliveries, dataBytes, maxFrameBytes: 65536, host: hostStats, guests: guestStats };
    report(`PASS ${hostRuntime} host + 3 ${guestRuntime} guests: data=${dataDeliveries}, controls=${controlDeliveries}, dataBytes=${dataBytes}, initialThreePeers=3, continuedAfterOneDisconnect=2`);
    return result;
  } finally { for (const process of [host, ...guests]) if (process.child.exitCode === null) process.child.kill(); }
}
try {
  const directions = [await star('Java'), await star('CSharp')];
  const result = { scope: 'desktop-loopback-production-native-transports-not-physical-devices', directions,
    dataDeliveries: directions.reduce((n, direction) => n + direction.dataDeliveries, 0),
    controlDeliveries: directions.reduce((n, direction) => n + direction.controlDeliveries, 0),
    dataBytes: directions.reduce((n, direction) => n + direction.dataBytes, 0) };
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  report(`PASS TOTAL: ${result.dataDeliveries} data deliveries + ${result.controlDeliveries} control deliveries = ${result.dataDeliveries + result.controlDeliveries} native TCP message deliveries; ${result.dataBytes} data bytes. Desktop loopback only; no Android package installed or device test performed.`);
} catch (error) { report(`FAIL ${error.stack || error}`); process.exitCode = 1; }
