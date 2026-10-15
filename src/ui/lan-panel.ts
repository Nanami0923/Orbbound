import { LanSession, type RoomConfig } from '../lan/session';
import { LAN_RULES_HASH } from '../lan/protocol';
import { NativeLanTransport, parseAddress } from '../lan/transport';
import { MockLanTransport } from '../lan/mock-transport';
import { loadLanHistory, saveLanRecord } from '../storage/lan-history';
import { readStorage, writeStorage } from '../storage/safe-storage';
import { escapeText } from './progress-feedback';
import { bindModalFocus } from './modal-focus';
import { bindLanBoard } from './lan-board';
import { gameAudio } from '../game/audio';
import { usesButtonControls } from '../game/input-mode';
import { loadSettings } from '../storage/storage';
import './lan.css';

const escape = (value: unknown) => escapeText(String(value ?? ''));
export function formatLanDuration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
const difficultyNames = { easy: '简单', normal: '普通', hard: '困难' };
export function installLan(openHome: () => void): { isActive: () => boolean; back: () => void; foreground: (active: boolean) => void } {
  const entry = document.createElement('div'); entry.className = 'mode-card lan-mode';
  entry.innerHTML = '<button id="lan-button" class="mode-main" type="button"><b class="mode-symbol">⇄</b><span><strong>局域网联机</strong><small>双人同图 · 手机电脑互联</small></span><b class="mode-action">联机 →</b></button>';
  document.querySelector('.home-actions')?.append(entry);
  const root = document.createElement('section'); root.id = 'lan-screen'; root.className = 'lan-screen'; root.hidden = true;
  document.querySelector('#app')!.append(root);
  let session: LanSession | undefined, key = '', page: 'choose' | 'create' | 'history' = 'choose', boardDispose: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined, busy = false, error = '', focusRelease: (() => void) | undefined;
  let viewGeneration = 0;
  let closing: Promise<void> | undefined;
  const entryButton = entry.querySelector<HTMLButtonElement>('button')!;
  const simulated = import.meta.env.DEV && new URLSearchParams(location.search).has('lan-test');
  const nickname = () => readStorage('orbbound-lan-name') ?? '玩家';
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const run = (action: () => void | Promise<void>) => {
    if (busy) return; const generation = viewGeneration; busy = true; error = '';
    void Promise.resolve().then(() => { if (generation === viewGeneration) return action(); }).catch(reason => {
      if (generation === viewGeneration) error = reason instanceof Error ? reason.message : String(reason);
    }).finally(() => { if (generation === viewGeneration) { busy = false; render(); } });
  };
  const startSession = () => {
    const transport = simulated ? new MockLanTransport() : new NativeLanTransport(); session = new LanSession(transport);
    unsubscribe = session.subscribe(render);
  };
  const open = () => {
    if (!root.hidden || closing) return; viewGeneration++; busy = false;
    openHome(); document.querySelector<HTMLElement>('#home-screen')!.hidden = true;
    root.hidden = false; document.documentElement.classList.add('lan-active'); startSession(); page = 'choose'; key = ''; error = ''; render(); q('h1')?.focus();
  };
  const exit = async () => {
    viewGeneration++; busy = false;
    focusRelease?.(); focusRelease = undefined; boardDispose?.(); boardDispose = undefined; unsubscribe?.(); unsubscribe = undefined;
    const previous = session; session = undefined; root.hidden = true; document.documentElement.classList.remove('lan-active');
    entryButton.disabled = true; entryButton.setAttribute('aria-busy', 'true');
    const cleanup = Promise.resolve().then(() => previous?.close()); closing = cleanup;
    gameAudio.setScene('menu'); openHome(); document.querySelector<HTMLElement>('#lan-button')?.focus();
    try { await cleanup; } finally {
      if (closing === cleanup) { closing = undefined; entryButton.disabled = false; entryButton.removeAttribute('aria-busy'); }
    }
  };
  const leave = () => { void exit().catch(() => { /* The old session owns cleanup; this screen has already closed. */ }); };
  const confirmLeave = () => {
    if (root.hidden || root.querySelector('.lan-confirm')) return;
    if (!session?.view.snapshot || session.view.phase === 'finished' || session.view.phase === 'closed') { leave(); return; }
    const overlay = document.createElement('div'); overlay.className = 'lan-confirm'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = '<div class="lan-card"><h2>离开本局？</h2><p>主动离开会判为认输。房主离开也会关闭房间。</p><div class="lan-actions"><button class="primary-button" data-autofocus id="lan-stay">继续游戏</button><button class="quiet-button" id="lan-confirm-exit">确认离开</button></div></div>';
    root.append(overlay); focusRelease = bindModalFocus(overlay, [q('.lan-body'), q('.lan-top')]);
    const dismiss = () => { focusRelease?.(); focusRelease = undefined; overlay.remove(); q<HTMLButtonElement>('#lan-exit')?.focus(); };
    q('#lan-stay').onclick = dismiss; q('#lan-confirm-exit').onclick = () => { dismiss(); leave(); };
    overlay.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(); } };
  };
  const base = (title: string, body: string, wide = false) => {
    focusRelease?.(); focusRelease = undefined;
    boardDispose?.(); boardDispose = undefined;
    root.classList.toggle('lan-in-game', wide);
    root.innerHTML = `<header class="lan-top"><span class="brand-name">ORBBOUND <span class="lan-label">局域网</span></span><button id="lan-exit" class="quiet-button" type="button">${session?.view.snapshot ? '离开房间' : '返回首页'}</button></header><main class="lan-body ${wide ? 'lan-wide' : ''}"><h1 tabindex="-1">${title}</h1>${body}<p id="lan-error" role="alert" class="lan-error"></p></main>`;
    q('#lan-exit').onclick = confirmLeave;
  };
  const nameField = () => `<label class="lan-field">你的昵称<input id="lan-name" maxlength="16" value="${escape(nickname())}" autocomplete="nickname"></label>`;
  const configFields = (config: RoomConfig) => `<div class="lan-form-row"><label class="lan-field">难度<select id="lan-difficulty">${Object.entries(difficultyNames).map(([id, label]) => `<option value="${id}" ${config.difficultyId === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="lan-field">时长<select id="lan-duration"><option value="180000" ${config.durationMs === 180000 ? 'selected' : ''}>3 分钟</option><option value="300000" ${config.durationMs === 300000 ? 'selected' : ''}>5 分钟</option></select></label></div>`;
  const readConfig = (): RoomConfig => ({ difficultyId: q<HTMLSelectElement>('#lan-difficulty').value as RoomConfig['difficultyId'], durationMs: Number(q<HTMLSelectElement>('#lan-duration').value) as RoomConfig['durationMs'] });
  const saveName = () => { const name = q<HTMLInputElement>('#lan-name').value.trim() || '玩家'; writeStorage('orbbound-lan-name', name); return name; };
  function render(): void {
    if (!session || root.hidden) return;
    const view = session.view;
    const gamePhases = ['preparing', 'countdown', 'playing', 'paused', 'reconnecting'];
    const nextKey = view.phase === 'idle' ? page : gamePhases.includes(view.phase) && view.snapshot ? `game:${view.snapshot.matchId}` : view.phase;
    if (nextKey !== key) {
      key = nextKey;
      if (nextKey === 'choose') {
        base('一起，打出下一次连锁。', `<p class="lan-intro">连接同一路由器或热点，一人创建房间，另一人加入。无需互联网。</p>${simulated ? '<p class="lan-notice">开发模拟 · 当前连接仅用于同一浏览器中的界面测试，不是真实局域网连接。</p>' : ''}<div class="lan-choice"><button id="lan-create" class="lan-choice-card"><span>01 / HOST</span><strong>创建房间</strong><small>选择规则，邀请身边的朋友 →</small></button><button id="lan-browse" class="lan-choice-card"><span>02 / JOIN</span><strong>加入房间</strong><small>发现附近房间，或输入地址 →</small></button></div><div class="lan-card lan-rules"><h2>同图竞分</h2><p>相同开局，各自拆解。三连消除、切断支撑，清空后进入下一波。到时分数高者胜，同分比较完成波次。触底后保留分数，观看对手继续。</p><small>支持 Windows 与 Android 双向建房。网络隔离或防火墙可能影响连接。</small></div><button class="text-button" id="lan-history">查看联机记录 →</button>${!session.transport.available ? '<p class="lan-notice">当前是网页预览。请使用 Windows 或 Android 4.3.0 安装版进行局域网联机。</p>' : ''}`);
        q('#lan-create').onclick = () => { page = 'create'; key = ''; render(); };
        q('#lan-browse').onclick = () => run(() => session!.browse());
        q('#lan-history').onclick = () => { page = 'history'; key = ''; render(); };
      } else if (nextKey === 'create') {
        base('创建房间', `<div class="lan-card">${nameField()}<label class="lan-field">房间名<input id="lan-room-name" maxlength="24" placeholder="朋友的小房间"></label>${configFields(view.config)}<p class="lan-muted">两人同时开始。相同波次的开局一致，后续供球随各自棋盘变化。</p><div class="lan-actions"><button id="lan-host" class="primary-button">创建房间</button><button id="lan-back" class="quiet-button">返回</button></div></div>`);
        q('#lan-host').onclick = () => run(async () => { const config = readConfig(), name = saveName(), room = q<HTMLInputElement>('#lan-room-name').value; await session!.host(name, room, config); });
        q('#lan-back').onclick = () => { page = 'choose'; key = ''; render(); };
      } else if (nextKey === 'browsing') {
        base('加入房间', `<div class="lan-card">${nameField()}<div class="lan-section-title"><h2>附近的房间</h2><button id="lan-refresh" class="text-button">刷新</button></div><div id="lan-room-list" class="lan-room-list"></div><label class="lan-field">或输入房主地址<input id="lan-address" inputmode="text" placeholder="例如 192.168.1.8:42171" value="${escape(readStorage('orbbound-lan-address') ?? '')}"></label><button id="lan-connect" class="primary-button">通过地址加入</button><details class="lan-help"><summary>找不到房间？</summary><p>先确认两台设备在同一网络。可输入房主页面显示的地址；如仍超时，检查访客网络隔离、Windows 专用网络防火墙和 VPN。手动地址无法绕过网络隔离。</p></details></div>`);
        q('#lan-refresh').onclick = () => run(() => session!.transport.request<void>('discover'));
        q('#lan-connect').onclick = () => run(async () => { const value = q<HTMLInputElement>('#lan-address').value; const address = parseAddress(value); if (!address) throw new Error('请输入有效 IPv4 地址和端口，例如 192.168.1.8:42171'); const name = saveName(); writeStorage('orbbound-lan-address', value.trim()); await session!.join(name, address.address, address.port); });
      } else if (nextKey === 'lobby') {
        base('房间已就绪。', `<div class="lan-card"><h2>${escape(view.roomName)}</h2><div id="lan-players" class="lan-players"></div><div id="lan-lobby-config">${view.isHost ? configFields(view.config) : ''}</div><p id="lan-settings-summary" class="lan-muted"></p>${view.isHost ? `<div class="lan-addresses"><small>朋友也可以通过这些地址加入</small>${(view.hostInfo?.addresses ?? []).map(address => `<code>${escape(address)}:${view.hostInfo?.port}</code>`).join('')}${view.hostInfo?.discoveryAvailable === false ? '<p>自动发现暂不可用，请手动输入上方地址。</p>' : ''}</div>` : ''}<div class="lan-actions"><button id="lan-ready" class="primary-button">准备</button>${view.isHost ? '<button id="lan-start" class="primary-button">开始对局</button><button id="lan-kick" class="text-button">移除客人</button>' : ''}</div><p class="lan-muted">双方准备后由房主开始；修改规则需要重新准备。</p></div>`);
        q('#lan-ready').onclick = () => session!.ready();
        if (view.isHost) { q('#lan-start').onclick = () => session!.start(); q('#lan-kick').onclick = () => session!.kick(); q('#lan-difficulty').onchange = q('#lan-duration').onchange = () => session!.setConfig(readConfig()); }
      } else if (nextKey.startsWith('game:')) {
        base('同图竞分', `<div class="lan-scoreboard"><div><span id="lan-self-name"></span><strong id="lan-self-score">0</strong><small id="lan-self-wave"></small></div><div class="lan-clock"><small>剩余时间</small><strong id="lan-clock">3:00</strong><span id="lan-network"></span></div><div><span id="lan-peer-name"></span><strong id="lan-peer-score">0</strong><small id="lan-peer-wave"></small></div></div><div class="lan-game-layout"><div class="lan-board-wrap"><canvas id="lan-self-board" width="640" height="760" aria-label="自己的联机棋盘"></canvas><div id="lan-game-overlay" class="lan-game-overlay" hidden></div></div><aside class="lan-opponent"><h2>对方棋盘</h2><canvas id="lan-other-board" width="256" height="304" aria-label="对方棋盘缩略图"></canvas><p class="lan-muted">相同开局，各自寻找连锁。</p><p id="lan-pressure"></p></aside></div><div class="lan-controls"><button id="lan-turn-left" class="quiet-button" aria-label="向左快转30度">↶ 30°</button><div class="lan-sliders"><label>瞄准 <output id="lan-angle-value">0.0°</output><input id="lan-angle" type="range" min="-78" max="78" step="0.1" value="0" aria-label="瞄准角度"></label><label>微调<input id="lan-fine" type="range" min="-100" max="100" step="1" value="0" aria-label="按住微调，松开停止"></label></div><button id="lan-turn-right" class="quiet-button" aria-label="向右快转30度">30° ↷</button><button id="lan-fire" class="primary-button">发射 ↑</button></div><div class="lan-game-footer"><p id="lan-notice" role="status"></p><button id="lan-pause" class="text-button">请求暂停</button></div><div id="lan-pause-request"></div><p class="lan-control-tip">${usesButtonControls() ? loadSettings().immersiveMode ? '按住棋盘瞄准，松手发射；也可用下方滑杆和发射按钮。' : '滑动瞄准与微调控制，点击发射；支持双指操作。' : '鼠标瞄准并单击发射；方向键转向、空格发射，沿用你的快捷键设置。'}</p>`, true);
        q('#lan-pause').onclick = () => session!.requestPause();
        boardDispose = bindLanBoard(root, session); gameAudio.setScene('play');
      } else if (nextKey === 'finished') {
        const snapshot = view.snapshot!, result = snapshot.result!;
        const title = result.reason === 'interrupted' ? '本局中断' : result.winnerId === null ? '势均力敌，平局。' : result.winnerId === view.selfId ? '这一局，你赢了。' : '下一局，再来较量。';
        base(title, `<p class="lan-intro">${result.reason === 'interrupted' ? '未完成的对局不计胜负。' : result.reason === 'forfeit' ? '一方主动退出，按认输结算。' : result.reason === 'all-sealed' ? '双方均已触底，按累计分数结算。' : '时间到，按累计分数与完成波次结算。'}</p><div class="lan-results">${snapshot.playerIds.map(playerId => { const p = result.players[playerId]; return `<div class="lan-card ${result.winnerId === playerId ? 'lan-winner' : ''}"><small>${escape(view.players.find(x => x.id === playerId)?.name ?? playerId)}${playerId === view.selfId ? ' · 你' : ''}</small><strong>${p.score.toLocaleString('zh-CN')}</strong><p>完成 ${p.completedWaves} 波 · 发射 ${p.totalShots} 次</p></div>`; }).join('')}</div><div class="lan-actions"><button id="lan-rematch" class="primary-button">回等待室，再来一局</button><button id="lan-result-home" class="quiet-button">返回首页</button></div><p id="lan-finished-notice" class="lan-muted"></p>`);
        saveLanRecord({ resultId: result.resultId, matchId: result.matchId, endedAt: Date.now(), difficultyId: snapshot.difficultyId, durationMs: snapshot.durationMs, rulesHash: snapshot.rulesHash, selfId: view.selfId, names: Object.fromEntries(view.players.map(p => [p.id, p.name])), result });
        q('#lan-rematch').onclick = () => session!.rematch(); q('#lan-result-home').onclick = leave; gameAudio.setScene('menu');
        if (result.reason !== 'interrupted') gameAudio.blip(result.winnerId === view.selfId ? 'win' : 'lose');
      } else if (nextKey === 'history') {
        const records = loadLanHistory();
        base('联机记录', `<p class="lan-intro">仅保存在本机，与单机排行分开。</p><div class="lan-history-list">${records.length ? records.map(r => `<article class="lan-card"><div class="lan-section-title"><strong>${r.result.reason === 'interrupted' ? '中断' : r.result.winnerId === null ? '平局' : r.result.winnerId === r.selfId ? '胜利' : '失利'}</strong><small>${escape(new Date(r.endedAt).toLocaleString('zh-CN'))}</small></div><p>${escape(r.names?.[r.selfId] ?? '你')} · ${r.result.players[r.selfId].score} 分 · ${Math.round(r.durationMs / 60000)} 分钟局</p></article>`).join('') : '<p class="lan-card">完成第一场对局后，记录会出现在这里。</p>'}</div><button id="lan-back" class="quiet-button">返回联机</button>`);
        q('#lan-back').onclick = () => { page = 'choose'; key = ''; render(); };
      } else if (nextKey === 'closed') {
        base('连接已结束', '<div class="lan-card"><p id="lan-closed-reason"></p><button id="lan-retry" class="primary-button">重新加入</button></div>');
        q('#lan-retry').onclick = () => run(() => session!.browse());
      } else base('正在连接…', '<div class="lan-card"><p>正在连接局域网，请稍候。可以返回取消。</p></div>');
    }
    q('#lan-error').textContent = error || view.error;
    if (view.phase === 'browsing') {
      const list = q('#lan-room-list');
      const markup = view.rooms.map((room, index) => `<button class="lan-room" data-room="${index}" ${room.metadata.rulesHash !== LAN_RULES_HASH ? 'disabled' : ''}><strong>${escape(room.name)}</strong><span>${escape(room.address)}:${room.port}</span><small>${room.metadata.rulesHash === LAN_RULES_HASH ? '加入 →' : '版本不兼容'}</small></button>`).join('') || '<p class="lan-muted">正在查找附近房间…也可以直接输入地址。</p>';
      if (list.innerHTML !== markup) { list.innerHTML = markup; list.querySelectorAll<HTMLButtonElement>('[data-room]').forEach(button => { button.onclick = () => run(async () => { const room = view.rooms[Number(button.dataset.room)]; if (!room) return; const name = saveName(); writeStorage('orbbound-lan-address', `${room.address}:${room.port}`); await session!.join(name, room.address, room.port); }); }); }
    }
    if (view.phase === 'lobby') {
      q('#lan-players').innerHTML = ['host', 'guest'].map(playerId => { const p = view.players.find(x => x.id === playerId); return `<div class="lan-player"><span class="lan-player-dot ${playerId}"></span><strong>${p ? escape(p.name) : '等待朋友加入'}</strong><small>${p ? p.ready ? '已准备' : '未准备' : '空位'}</small></div>`; }).join('');
      q('#lan-settings-summary').textContent = `同图竞分 · ${difficultyNames[view.config.difficultyId]} · ${view.config.durationMs / 60000} 分钟`;
      q('#lan-ready').textContent = view.players.find(p => p.id === view.selfId)?.ready ? '取消准备' : '准备';
      if (view.isHost) { q<HTMLButtonElement>('#lan-start').disabled = view.players.length !== 2 || view.players.some(p => !p.ready || !p.connected); q<HTMLButtonElement>('#lan-kick').hidden = view.players.length < 2; }
    }
    if (key.startsWith('game:') && view.snapshot) {
      const self = view.snapshot.players[view.selfId], otherId = view.selfId === 'host' ? 'guest' : 'host', other = view.snapshot.players[otherId];
      q('#lan-self-name').textContent = `${view.players.find(p => p.id === view.selfId)?.name ?? '你'} · 你`;
      q('#lan-peer-name').textContent = view.players.find(p => p.id === otherId)?.name ?? '对方';
      q('#lan-self-score').textContent = self.score.toLocaleString('zh-CN'); q('#lan-peer-score').textContent = other.score.toLocaleString('zh-CN');
      q('#lan-self-wave').textContent = self.sealed ? '已触底 · 分数保留' : `第 ${self.waveIndex + 1} 波`; q('#lan-peer-wave').textContent = other.sealed ? '已触底' : `第 ${other.waveIndex + 1} 波`;
      q('#lan-clock').textContent = formatLanDuration(Math.max(0, view.snapshot.durationMs - session.displayElapsed()));
      q('#lan-network').textContent = view.rtt ? `${view.rtt} ms` : '局域网';
      q('#lan-pressure').textContent = `压力 ${self.state.danger}% · 距时间下压 ${Math.max(0, Math.ceil((self.nextDescentAtMs - session.displayElapsed()) / 1000))} 秒`;
      q('#lan-notice').textContent = view.notice || (self.sealed ? '你的棋盘已结束，等待对方完成。' : '切断支撑，创造更大的掉落。');
      q<HTMLButtonElement>('#lan-pause').disabled = view.phase !== 'playing' || !!view.pauseRequester;
      const overlay = q('#lan-game-overlay'); overlay.hidden = view.phase === 'playing';
      const overlayMarkup = view.phase === 'countdown' ? `<strong class="lan-countdown">${view.countdown || '开始'}</strong><span>双方同时开局</span>` : view.phase === 'preparing' ? '<strong>准备棋盘…</strong>' : `<strong>${view.phase === 'reconnecting' ? '等待恢复连接' : '比赛已暂停'}</strong><p>${escape(view.notice)}</p><button id="lan-resume" class="primary-button" ${view.resumeReady.includes(view.selfId) ? 'disabled' : ''}>${view.resumeReady.includes(view.selfId) ? '等待对方就绪' : '我已回来，继续'}</button>`;
      if (!overlay.hidden && overlay.innerHTML !== overlayMarkup) { overlay.innerHTML = overlayMarkup; overlay.querySelector<HTMLButtonElement>('#lan-resume')?.addEventListener('click', () => session!.resume()); }
      const request = q('#lan-pause-request'); const requestMarkup = view.pauseRequester ? view.pauseRequester === view.selfId ? '<p class="lan-notice">已请求暂停，等待对方同意。</p>' : '<div class="lan-pause-banner">对方请求暂停 <button id="lan-accept-pause" class="quiet-button">同意</button><button id="lan-reject-pause" class="text-button">继续比赛</button></div>' : '';
      if (request.innerHTML !== requestMarkup) { request.innerHTML = requestMarkup; request.querySelector('#lan-accept-pause')?.addEventListener('click', () => session!.decidePause(true)); request.querySelector('#lan-reject-pause')?.addEventListener('click', () => session!.decidePause(false)); }
    }
    if (view.phase === 'finished') { q('#lan-finished-notice').textContent = view.notice; q<HTMLButtonElement>('#lan-rematch').disabled = view.players.some(p => !p.connected); }
    if (view.phase === 'closed') q('#lan-closed-reason').textContent = view.notice || view.error || '连接已关闭。可以重新加入房间。';
  }
  entry.querySelector('button')!.addEventListener('click', open);
  window.addEventListener('keydown', event => { if (!root.hidden && event.key === 'Escape' && !root.querySelector('.lan-confirm')) { event.preventDefault(); confirmLeave(); } });
  return { isActive: () => !root.hidden, back: confirmLeave, foreground: active => session?.foregroundChanged(active) };
}
