import { LanSession, type RoomConfig } from '../lan/session';
import { LAN_RULES_HASH, LAN_PROTOCOL_VERSION, LAN_CONTENT_HASH, type MatchResult } from '../lan/protocol';
import { NativeLanTransport, parseAddress } from '../lan/transport';
import { MockLanTransport } from '../lan/mock-transport';
import { loadLanHistory, saveLanRecord, recentLanAddresses, loadPendingLanHistory, savePendingLanRecord } from '../storage/lan-history';
import { readStorage, writeStorage } from '../storage/safe-storage';
import { escapeText } from './progress-feedback';
import { bindModalFocus } from './modal-focus';
import { bindLanBoard } from './lan-board';
import { roomEndpoints, copyRoomAddress } from './lan-address';
import { lanMatchLayoutMarkup, lanNetworkLabel, lanStatusSummary } from './lan-match-layout';
import { gameAudio } from '../game/audio';
import { usesButtonControls } from '../game/input-mode';
import { shortcutAction } from '../game/shortcuts';
import { loadSettings } from '../storage/storage';
import { subscribeSettings } from '../storage/settings-store';
import { syncGameShell } from './game-shell';
import { getKeyboardState, subscribeKeyboardState } from './keyboard-state';
import './lan.css';

const escape = (value: unknown) => escapeText(String(value ?? ''));
export function formatLanDuration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function scheduleLanFinish(deadline: number, complete: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined, cancelled = false;
  const wake = () => {
    if (cancelled) return;
    const remaining = deadline - performance.now();
    // A rounded or early timer must keep a wake-up pending until the absolute deadline.
    if (remaining > 0) timer = setTimeout(wake, Math.max(1, Math.ceil(remaining)));
    else { timer = undefined; complete(); }
  };
  wake();
  return () => { cancelled = true; clearTimeout(timer); timer = undefined; };
}
const difficultyNames = { easy: '简单', normal: '普通', hard: '困难' };
const modeName = (mode?: string) => mode === 'battle' ? '连锁对战' : '同图竞分';
const winners = (result: MatchResult) => result.winnerIds ?? (result.winnerId ? [result.winnerId] : []);
const resultLabel = (result: MatchResult, self: string) => result.reason === 'interrupted' ? '本局中断' : winners(result).includes(self) ? winners(result).length > 1 ? '并列获胜' : '胜利' : winners(result).length ? '本局结束' : '平局 / 无胜者';
type Route = 'choose' | 'create-name' | 'create-rules' | 'history' | 'help';
type BrowseTab = 'nearby' | 'address' | 'recent' | 'diagnostics';

export function installLan(openHome: () => void): { isActive: () => boolean; back: () => void; foreground: (active: boolean) => void } {
  const entry = document.querySelector<HTMLElement>('#lan-entry-slot') ?? document.createElement('div');
  entry.className = 'mode-card lan-mode';
  entry.innerHTML = '<button id="lan-button" class="mode-main" type="button"><b class="mode-symbol">⇄</b><span><strong>局域网联机</strong><small>2–4 人 · 竞分 / 对战</small></span><b class="mode-action">联机 →</b></button>';
  if (!entry.isConnected) document.querySelector('.home-actions')?.append(entry);
  const root = document.createElement('section'); root.id = 'lan-screen'; root.className = 'lan-screen'; root.hidden = true;
  document.querySelector('#app')!.append(root);
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const text = (selector: string, value: string) => { const element = q(selector); if (element && element.textContent !== value) element.textContent = value; };
  const entryButton = entry.querySelector<HTMLButtonElement>('button')!;
  const simulated = import.meta.env.DEV && new URLSearchParams(location.search).has('lan-test');
  const nickname = () => readStorage('orbbound-lan-name') ?? '玩家';
  let session: LanSession | undefined, key = '', route: Route = 'choose', browseTab: BrowseTab = 'address';
  let lobbyPage: 'players' | 'rules' | 'addresses' = 'players';
  let page = 0, helpPage = 0, generation = 0, busy = false, error = '', closing: Promise<void> | undefined;
  let selectedRoomAddress = '', shareKey = '';
  let boardDispose: (() => void) | undefined, unsubscribe: (() => void) | undefined, focusRelease: (() => void) | undefined;
  let roomMarkup = '', recordedResult = '', finishResult = '', finishAt = 0, finishCancel: (() => void) | undefined;
  let settingsVisible = false, requestKey = '', pauseMarkup = '', detailsId = '', observeId = '', keyboardField: { label: HTMLElement; marker: Comment; overlay: HTMLElement } | undefined;
  let form = { name: nickname(), room: '', address: readStorage('orbbound-lan-address') ?? '', config: { mode: 'score', difficultyId: 'normal', durationMs: 180000, capacity: 4 } as RoomConfig };
  const selectedEndpoints = new Map<string, string>();
  const height = () => window.visualViewport?.height ?? window.innerHeight;
  const capacity = (reserved: number, itemHeight: number, maximum: number) => Math.max(1, Math.min(maximum, Math.floor((height() - reserved) / itemHeight)));
  const setRoute = (value: Route) => { captureForm(); route = value; page = 0; key = ''; render(); };
  const run = (action: () => void | Promise<void>) => {
    if (busy) return; const operation = generation; busy = true; error = '';
    void Promise.resolve().then(() => { if (operation === generation) return action(); }).catch(reason => {
      if (operation === generation) error = reason instanceof Error ? reason.message : String(reason);
    }).finally(() => { if (operation === generation) { busy = false; render(); } });
  };
  function captureForm(): void {
    if (q<HTMLInputElement>('#lan-name')) form.name = q<HTMLInputElement>('#lan-name').value;
    if (q<HTMLInputElement>('#lan-room-name')) form.room = q<HTMLInputElement>('#lan-room-name').value;
    if (q<HTMLInputElement>('#lan-address')) form.address = q<HTMLInputElement>('#lan-address').value;
  }
  function closeKeyboard(): void {
    if (!keyboardField) return;
    const { label, marker, overlay } = keyboardField; keyboardField = undefined;
    (document.activeElement as HTMLElement | null)?.blur(); marker.replaceWith(label); overlay.remove(); root.classList.remove('lan-editing');
  }
  const closeSettings = () => { if (settingsVisible) window.dispatchEvent(new Event('orbbound-close-settings')); };
  function openSettings(): void {
    if (!session || settingsVisible || session.view.forceCloseSettings || !['paused', 'lobby', 'finished'].includes(session.view.phase)) return;
    settingsVisible = true; session.settingsChanged(true);
    window.dispatchEvent(new CustomEvent('orbbound-open-settings', { detail: { onClosed: () => {
      settingsVisible = false; session?.settingsChanged(false); render();
    } } }));
  }
  const startSession = () => { session = new LanSession(simulated ? new MockLanTransport() : new NativeLanTransport()); unsubscribe = session.subscribe(render); };
  const open = () => {
    if (!root.hidden) return;
    generation++; busy = false; selectedEndpoints.clear(); form.name = nickname();
    openHome(); document.querySelector<HTMLElement>('#home-screen')!.hidden = true;
    root.hidden = false; document.documentElement.classList.add('lan-active');
    startSession(); route = 'choose'; browseTab = 'address'; lobbyPage = 'players'; selectedRoomAddress = ''; page = 0; key = ''; error = ''; render(); q('h1')?.focus();
  };
  const exit = async () => {
    generation++; busy = false; closeKeyboard(); closeSettings(); finishCancel?.(); finishCancel = undefined; finishResult = ''; finishAt = 0;
    focusRelease?.(); focusRelease = undefined; boardDispose?.(); boardDispose = undefined; unsubscribe?.(); unsubscribe = undefined;
    const previous = session;
    if (previous?.view.snapshot?.status === 'playing' && !previous.view.isHost) {
      const snapshot = previous.view.snapshot, self = snapshot.players[previous.view.selfId];
      if (self) savePendingLanRecord({ matchId: snapshot.matchId, endedAt: Date.now(), selfId: previous.view.selfId,
        name: previous.view.players.find(p => p.id === previous.view.selfId)?.name ?? '你', score: self.score, completedWaves: self.completedWaves,
        mode: snapshot.mode, playerCount: snapshot.playerIds.length, protocolVersion: LAN_PROTOCOL_VERSION, reason: self.sealed ? 'left-spectating' : 'left-active' });
    }
    session = undefined; root.hidden = true; document.documentElement.classList.remove('lan-active');
    let closeResult = '';
    const captureCloseResult = previous?.subscribe(() => {
      const snapshot = previous.view.snapshot, result = snapshot?.result;
      if (!snapshot || !result || closeResult === result.resultId) return;
      closeResult = result.resultId;
      saveLanRecord({ resultId: result.resultId, matchId: result.matchId, endedAt: Date.now(), difficultyId: snapshot.difficultyId,
        durationMs: snapshot.durationMs, rulesHash: snapshot.rulesHash, selfId: previous.view.selfId, names: Object.fromEntries(previous.view.players.map(p => [p.id, p.name])), mode: snapshot.mode, protocolVersion: LAN_PROTOCOL_VERSION, result });
    });
    const cleanup = previous?.close() ?? Promise.resolve(); closing = cleanup;
    gameAudio.setPressure(0); gameAudio.setScene('menu'); openHome(); entryButton.focus();
    try { await cleanup; } finally { captureCloseResult?.(); if (closing === cleanup) closing = undefined; }
  };
  const leave = () => { void exit().catch(() => {}); };
  const confirmLeave = () => {
    if (root.hidden) return;
    if (root.querySelector('.lan-confirm')) { q<HTMLButtonElement>('#lan-stay')?.click(); return; }
    if (keyboardField) { closeKeyboard(); return; }
    if (settingsVisible) { closeSettings(); return; }
    if (!session?.view.snapshot || ['finished', 'closed'].includes(session.view.phase)) { leave(); return; }
    const self = session.view.snapshot.players[session.view.selfId];
    const overlay = document.createElement('div'); overlay.className = 'lan-confirm'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `<div class="lan-card"><h2>离开本局？</h2><p>${session.view.isHost ? '房主关闭房间将中断所有人的比赛。认输后可留在房间观战。' : self.sealed ? '你的成绩已保留，离开观战后最终排名可能暂未同步。' : '退出比赛将按弃权处理；你也可以认输后留在房间观战。'}</p><div class="lan-actions"><button class="primary-button" data-autofocus id="lan-stay">返回</button>${!self.sealed ? '<button class="quiet-button" id="lan-concede">认输并观战</button>' : ''}<button class="quiet-button" id="lan-confirm-exit">${session.view.isHost ? '关闭房间' : '离开房间'}</button></div></div>`;
    root.append(overlay); focusRelease = bindModalFocus(overlay, [q('.lan-body'), q('.lan-top')]);
    const dismiss = () => { focusRelease?.(); focusRelease = undefined; overlay.remove(); q<HTMLButtonElement>('#lan-exit')?.focus(); };
    q('#lan-stay').onclick = dismiss; q('#lan-confirm-exit').onclick = () => { dismiss(); leave(); };
    q('#lan-concede')?.addEventListener('click', () => { dismiss(); session?.forfeit(); });
    overlay.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(); } };
  };
  const base = (title: string, body: string, game = false) => {
    closeKeyboard(); roomMarkup = ''; requestKey = ''; pauseMarkup = ''; observeId = ''; shareKey = '';
    focusRelease?.(); focusRelease = undefined; boardDispose?.(); boardDispose = undefined;
    root.classList.toggle('lan-in-game', game);
    const settings = loadSettings(); syncGameShell(root, { touch: usesButtonControls(), immersive: settings.immersiveMode, mode: session?.view.snapshot?.mode ?? 'lan' });
    root.classList.toggle('lan-swapped', settings.controlsSwapped); root.style.setProperty('--lan-fire-width', `${settings.fireSize}px`);
    root.innerHTML = `<header class="lan-top"><span class="brand-name">ORBBOUND <span class="lan-label">${game ? modeName(session?.view.snapshot?.mode) : '局域网 · 2–4 人'}</span></span><button id="lan-exit" class="quiet-button" type="button">${session?.view.snapshot ? '离开房间' : '返回首页'}</button></header><main class="lan-body ${game ? 'lan-wide' : ''}"><h1 tabindex="-1">${title}</h1><div class="lan-content">${body}</div><p id="lan-error" role="alert" class="lan-error"></p></main>`;
    q('#lan-exit').onclick = confirmLeave;
  };
  const button = (id: string, title: string, primary = false) => `<button id="${id}" class="${primary ? 'primary-button' : 'quiet-button'}" type="button">${title}</button>`;
  const nameField = () => `<label class="lan-field">你的昵称<input id="lan-name" maxlength="16" value="${escape(form.name)}" autocomplete="nickname"></label>`;
  const configFields = (config: RoomConfig) => `<div class="lan-form-row"><label class="lan-field">玩法<select id="lan-mode"><option value="score" ${config.mode !== 'battle' ? 'selected' : ''}>同图竞分</option><option value="battle" ${config.mode === 'battle' ? 'selected' : ''}>连锁对战</option></select></label><label class="lan-field">人数上限<select id="lan-capacity">${[2, 3, 4].map(n => `<option value="${n}" ${(config.capacity ?? 4) === n ? 'selected' : ''}>${n} 人</option>`).join('')}</select></label><label class="lan-field">难度<select id="lan-difficulty">${Object.entries(difficultyNames).map(([id, label]) => `<option value="${id}" ${config.difficultyId === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="lan-field">时长<select id="lan-duration"><option value="180000" ${config.durationMs === 180000 ? 'selected' : ''}>3 分钟</option><option value="300000" ${config.durationMs === 300000 ? 'selected' : ''}>5 分钟</option></select></label></div>`;
  const readConfig = (): RoomConfig => ({ mode: q<HTMLSelectElement>('#lan-mode').value as RoomConfig['mode'], difficultyId: q<HTMLSelectElement>('#lan-difficulty').value as RoomConfig['difficultyId'], durationMs: Number(q<HTMLSelectElement>('#lan-duration').value) as RoomConfig['durationMs'], capacity: Number(q<HTMLSelectElement>('#lan-capacity').value) as 2 | 3 | 4 });
  const saveName = () => { captureForm(); form.name = form.name.trim() || '玩家'; writeStorage('orbbound-lan-name', form.name); return form.name; };
  const summary = (config: RoomConfig) => `${modeName(config.mode)} · ${difficultyNames[config.difficultyId]} · ${config.durationMs / 60000} 分钟 · 最多 ${config.capacity ?? 4} 人`;
  const pager = () => '<nav class="lan-pagination" aria-label="分页"><button id="lan-prev" class="quiet-button">上一页</button><span id="lan-page-label"></span><button id="lan-next" class="quiet-button">下一页</button></nav>';
  const updatePager = (count: number, size: number, refresh: () => void) => {
    const pages = Math.max(1, Math.ceil(count / size)); page = Math.min(page, pages - 1);
    const previous = q<HTMLButtonElement>('#lan-prev'), next = q<HTMLButtonElement>('#lan-next');
    if (!previous || !next) return;
    text('#lan-page-label', `${page + 1} / ${pages}`); previous.disabled = page === 0; next.disabled = page + 1 >= pages;
    previous.onclick = () => { page--; refresh(); }; next.onclick = () => { page++; refresh(); };
  };
  const joinAddress = () => run(async () => { captureForm(); const address = parseAddress(form.address); if (!address) throw new Error('请输入有效 IPv4 地址和端口'); writeStorage('orbbound-lan-address', form.address.trim()); await session!.join(saveName(), address.address, address.port); });

  const addressShareMarkup = () => '<section class="lan-address-share" aria-label="分享房间地址"><div class="lan-address-copy-row"><label class="lan-field">房间地址<input id="lan-share-address" readonly aria-label="房间地址" spellcheck="false"></label><button id="lan-copy-address" class="quiet-button" type="button">复制地址</button></div><label id="lan-share-interface-label" class="lan-field" hidden>其他网络地址<select id="lan-share-interface" aria-label="选择房间网络地址"></select></label><p id="lan-copy-status" class="lan-muted" role="status"></p></section>';
  function bindAddressShare(): void {
    q<HTMLSelectElement>('#lan-share-interface').onchange = event => { selectedRoomAddress = (event.target as HTMLSelectElement).value; updateAddressShare(); };
    q<HTMLButtonElement>('#lan-copy-address').onclick = async event => {
      const button = event.currentTarget as HTMLButtonElement, input = q<HTMLInputElement>('#lan-share-address'), operation = generation, address = input.value;
      button.disabled = true; button.setAttribute('aria-busy', 'true');
      const copied = await copyRoomAddress(address);
      if (!button.isConnected || operation !== generation) return;
      button.removeAttribute('aria-busy'); button.disabled = !parseAddress(input.value);
      if (input.value !== address) return;
      text('#lan-copy-status', copied ? '已复制完整地址和端口。' : '未能自动复制，请选中地址后长按或手动复制。');
      if (!copied) { input.focus(); input.select(); }
    };
  }
  function updateAddressShare(): void {
    const input = q<HTMLInputElement>('#lan-share-address'); if (!input) return;
    const endpoints = roomEndpoints(session!.view.hostInfo), nextKey = endpoints.join('|');
    if (!endpoints.includes(selectedRoomAddress)) selectedRoomAddress = endpoints[0] ?? '';
    if (shareKey !== nextKey) {
      q<HTMLSelectElement>('#lan-share-interface').innerHTML = endpoints.map(value => `<option value="${escape(value)}">${escape(value)}</option>`).join('');
      shareKey = nextKey;
    }
    const changed = input.value !== selectedRoomAddress;
    if (changed) input.value = selectedRoomAddress;
    input.placeholder = endpoints.length ? '' : '暂无可用局域网地址';
    q<HTMLSelectElement>('#lan-share-interface').value = selectedRoomAddress;
    q('#lan-share-interface-label').hidden = endpoints.length < 2;
    const copyButton = q<HTMLButtonElement>('#lan-copy-address');
    copyButton.disabled = !endpoints.length || copyButton.getAttribute('aria-busy') === 'true';
    if (changed || !q('#lan-copy-status').textContent) text('#lan-copy-status', !endpoints.length ? '请连接可互通的局域网后重新创建。' : session!.view.hostInfo?.discoveryAvailable === false ? '广播不可用，可复制地址直接加入。' : '请朋友输入完整地址和端口。');
  }

  function render(): void {
    if (!session || root.hidden) return;
    const view = session.view;
    root.classList.toggle('lan-lobby', view.phase === 'lobby');
    if (settingsVisible && view.phase === 'paused') {
      const context = document.querySelector<HTMLElement>('.settings-context');
      if (context) context.textContent = `本机设置 · 比赛已暂停 · 剩余 ${Math.ceil(view.pauseRemainingMs / 1000)} 秒，完成后请准备继续`;
    }
    if ((view.forceCloseSettings || !['paused', 'lobby', 'finished'].includes(view.phase)) && settingsVisible) closeSettings();
    if (view.autoOpenSettings && view.phase === 'paused' && !settingsVisible) { openSettings(); return; }
    if (view.phase === 'finished' && view.snapshot?.result) {
      const snapshot = view.snapshot, result = snapshot.result!;
      if (recordedResult !== result.resultId) { recordedResult = result.resultId; saveLanRecord({ resultId: result.resultId, matchId: result.matchId, endedAt: Date.now(), difficultyId: snapshot.difficultyId, durationMs: snapshot.durationMs, rulesHash: snapshot.rulesHash, selfId: view.selfId, names: Object.fromEntries(view.players.map(p => [p.id, p.name])), mode: snapshot.mode, protocolVersion: LAN_PROTOCOL_VERSION, result }); }
      if (finishResult !== result.resultId) {
        finishResult = result.resultId; finishAt = performance.now() + (key.startsWith('game:') && view.presentationEvents.length ? 2000 : 0);
        finishCancel?.(); finishCancel = undefined;
        if (performance.now() < finishAt) finishCancel = scheduleLanFinish(finishAt, () => { finishCancel = undefined; render(); });
      }
    }
    const gamePhases = ['preparing', 'countdown', 'playing', 'paused', 'reconnecting'];
    const finishing = view.phase === 'finished' && !document.hidden && performance.now() < finishAt;
    if (!finishing && finishCancel) { finishCancel(); finishCancel = undefined; }
    const nextKey = view.phase === 'idle' ? `${route}:${page}:${helpPage}` : view.phase === 'browsing' ? `browsing:${browseTab}` : view.phase === 'lobby' ? `lobby:${lobbyPage}` : (gamePhases.includes(view.phase) || finishing) && view.snapshot ? `game:${view.snapshot.matchId}` : view.phase;
    if (key !== nextKey) {
      key = nextKey;
      if (view.phase === 'idle' && route === 'choose') {
        base('一起，打出下一次连锁。', `<div class="lan-intro"><p>连接同一路由器或可互通热点，2–4 人同时开局。</p>${simulated ? '<p class="lan-notice">开发模拟 · 不代表真实局域网测试。</p>' : ''}</div><div class="lan-choice">${button('lan-create', '创建房间', true)}${button('lan-browse', '加入房间')}</div><p class="lan-muted">同图竞分看得分；连锁对战累计其他选手的消除量，抵御来袭。</p><div class="lan-actions">${button('lan-help', '玩法说明')}${button('lan-history', '联机记录')}</div>${!session.transport.available ? '<p class="lan-notice">请使用同版本的 Android / Windows 安装版联机。</p>' : ''}`);
        q('#lan-create').onclick = () => setRoute('create-name'); q('#lan-browse').onclick = () => { browseTab = 'address'; run(() => session!.browse({ discover: false })); };
        q('#lan-help').onclick = () => setRoute('help'); q('#lan-history').onclick = () => setRoute('history');
      } else if (view.phase === 'idle' && route === 'create-name') {
        base('创建房间 · 1 / 2', `<div class="lan-form-card">${nameField()}<label class="lan-field">房间名<input id="lan-room-name" maxlength="24" value="${escape(form.room)}" placeholder="朋友的小房间"></label><p class="lan-muted">双方均可当房主；至少两人准备后即可开局。</p><div class="lan-actions">${button('lan-back', '返回')}${button('lan-next-step', '选择规则', true)}</div></div>`);
        q('#lan-next-step').onclick = () => setRoute('create-rules'); q('#lan-back').onclick = () => setRoute('choose');
      } else if (view.phase === 'idle' && route === 'create-rules') {
        base('创建房间 · 2 / 2', `<div class="lan-form-card">${configFields(form.config)}<p class="lan-muted">对战每行需其他存活选手合计消除 12 / 24 / 36 球；自己的消除也可抵消来袭。</p><div class="lan-actions">${button('lan-back', '上一步')}${button('lan-host', '创建房间', true)}</div></div>`);
        q('#lan-back').onclick = () => { form.config = readConfig(); setRoute('create-name'); };
        q('#lan-host').onclick = () => run(async () => { form.config = readConfig(); await session!.host(saveName(), form.room, form.config); lobbyPage = 'players'; });
      } else if (view.phase === 'browsing') {
        base('加入房间', `${nameField()}<nav class="lan-tabs" aria-label="加入方式">${(['nearby', 'address', 'recent', 'diagnostics'] as const).map((tab, i) => `<button class="quiet-button" data-tab="${tab}" aria-pressed="${browseTab === tab}">${['附近', '地址', '最近', '诊断'][i]}</button>`).join('')}</nav><div id="lan-browser-body" class="lan-browser-body"></div>`);
        root.querySelectorAll<HTMLElement>('[data-tab]').forEach(tab => { tab.onclick = () => { captureForm(); browseTab = tab.dataset.tab as BrowseTab; page = 0; key = ''; render(); if (browseTab === 'nearby' && view.discovery.status === 'cancelled') run(() => session!.refreshDiscovery()); }; });
        if (browseTab === 'nearby') {
          q('#lan-browser-body').innerHTML = `<div class="lan-section-title"><p id="lan-scan-status" role="status"></p>${button('lan-refresh', '刷新')}</div><div id="lan-room-list" class="lan-room-list"></div>${pager()}`;
          q('#lan-refresh').onclick = () => run(() => view.discovery.status === 'scanning' ? session!.stopDiscovery() : session!.refreshDiscovery());
        } else if (browseTab === 'address') {
          q('#lan-browser-body').innerHTML = `<label class="lan-field">房主地址<input id="lan-address" placeholder="192.168.1.8:42171" value="${escape(form.address)}" inputmode="text"></label><p id="lan-fill-notice" class="lan-muted" role="status">找不到广播房间时，可按地址查询实际端口。</p><div class="lan-actions">${button('lan-probe-address', '按地址检索')}${button('lan-connect', '通过地址加入', true)}</div><p class="lan-muted">手动地址也需要网络允许设备互通。</p>`;
          q('#lan-connect').onclick = joinAddress;
          q('#lan-probe-address').onclick = () => run(async () => { captureForm(); const value = parseAddress(form.address); if (!value) throw new Error('先输入房主的有效 IPv4 地址'); await session!.refreshDiscovery([value.address]); browseTab = 'nearby'; key = ''; render(); });
        } else q('#lan-browser-body').innerHTML = `<div id="lan-room-list" class="lan-room-list"></div>${pager()}${browseTab === 'diagnostics' ? button('lan-copy-log', '复制完整诊断') : ''}`;
      } else if (view.phase === 'lobby') {
        if (lobbyPage === 'rules' && view.isHost) {
          base('调整房间规则', `${configFields(view.config)}<p class="lan-muted">修改规则后，所有选手需要重新准备。</p><div class="lan-actions">${button('lan-lobby-back', '取消')}${button('lan-save-rules', '应用规则', true)}</div>`);
          q('#lan-lobby-back').onclick = () => { lobbyPage = 'players'; key = ''; render(); };
          q('#lan-save-rules').onclick = () => { const config = readConfig(); session!.setConfig(config); lobbyPage = 'players'; key = ''; render(); };
        } else if (lobbyPage === 'addresses') {
          base('房间地址', addressShareMarkup()+'<div class="lan-actions">'+button('lan-lobby-back', '返回大厅')+'</div>');
          bindAddressShare();
          q('#lan-lobby-back').onclick = () => { lobbyPage = 'players'; key = ''; render(); };
        } else {
          base(escape(view.roomName), `${view.isHost ? addressShareMarkup() : ''}<div id="lan-players" class="lan-players"></div><p id="lan-settings-summary" class="lan-muted"></p><div class="lan-actions">${button('lan-ready', '准备', true)}${view.isHost ? button('lan-start', '开始对局', true) : ''}</div><div class="lan-actions">${view.isHost ? button('lan-edit-rules', '房间规则')+button('lan-addresses', '更多地址') : ''}${button('lan-local-settings', '本机设置')}</div><p class="lan-muted">至少两人，全员准备后由房主开始。</p>`);
          if (view.isHost) bindAddressShare();
          q('#lan-ready').onclick = () => session!.ready(); q('#lan-start')?.addEventListener('click', () => session!.start());
          q('#lan-edit-rules')?.addEventListener('click', () => { lobbyPage = 'rules'; key = ''; render(); });
          q('#lan-addresses')?.addEventListener('click', () => { lobbyPage = 'addresses'; key = ''; render(); }); q('#lan-local-settings').onclick = openSettings;
        }
      } else if (nextKey.startsWith('game:')) {
        const others = view.snapshot!.playerIds.filter(id => id !== view.selfId);
        base(modeName(view.snapshot!.mode), lanMatchLayoutMarkup(others.map(id => ({ id, name: view.players.find(p => p.id === id)?.name ?? id }))), true);
        q('#lan-pause').onclick = () => session!.requestPause('pause');
        q('#lan-settings').onclick = () => { if (view.phase === 'paused') openSettings(); else session!.requestPause('settings'); };
        q('#lan-watch-self').onclick = () => { delete root.dataset.watchPlayer; render(); };
        root.querySelectorAll<HTMLElement>('[data-watch]').forEach(item => { item.onclick = () => {
          if (!view.snapshot!.players[view.selfId].sealed) { openObservation(item.dataset.watch!); return; }
          root.dataset.watchPlayer = item.dataset.watch; render();
        }; });
        boardDispose = bindLanBoard(root, session); gameAudio.setScene('play');
      } else if (view.phase === 'finished') {
        const snapshot = view.snapshot!, result = snapshot.result!;
        detailsId = detailsId && result.players[detailsId] ? detailsId : view.selfId;
        const ranking = result.ranking ?? snapshot.playerIds.map((playerId, index) => ({ playerId, rank: result.winnerId === playerId ? 1 : index + 1, status: 'sealed' }));
        base(resultLabel(result, view.selfId), `<p class="lan-muted">${modeName(snapshot.mode)} · ${snapshot.playerIds.length} 人 · ${result.reason === 'interrupted' ? '连接中断，不计胜负' : '最终排名由房主统一确认'}</p><div class="lan-ranking">${ranking.map(row => `<button class="lan-rank-row ${winners(result).includes(row.playerId) ? 'lan-winner' : ''}" data-result-player="${escape(row.playerId)}"><b>${row.rank ?? '—'}</b><span>${escape(view.players.find(p => p.id === row.playerId)?.name ?? row.playerId)}${row.playerId === view.selfId ? ' · 你' : ''}</span><strong>${result.players[row.playerId].score.toLocaleString('zh-CN')}</strong><small>${row.status === 'forfeit' ? '弃权' : row.rank === 1 ? '获胜' : '完赛'}</small></button>`).join('')}</div><p id="lan-result-detail" class="lan-muted"></p><p id="lan-finished-notice" role="status"></p><div class="lan-actions">${button('lan-rematch', '再来一局', true)}${button('lan-finish-home', '返回首页')}</div>`);
        root.querySelectorAll<HTMLElement>('[data-result-player]').forEach(item => { item.onclick = () => { detailsId = item.dataset.resultPlayer!; render(); }; });
        q('#lan-rematch').onclick = () => { lobbyPage = 'players'; session!.rematch(); }; q('#lan-finish-home').onclick = leave;
        if (result.reason !== 'interrupted') gameAudio.blip(winners(result).includes(view.selfId) ? 'win' : 'lose');
      } else if (view.phase === 'idle' && route === 'history') {
        base('联机记录', `<p class="lan-muted">记录保存在本机；旧双人记录继续保留。</p><div id="lan-history-list" class="lan-history-list"></div>${pager()}${button('lan-back', '返回联机')}`);
        q('#lan-back').onclick = () => setRoute('choose');
      } else if (view.phase === 'idle' && route === 'help') {
        const help = [ ['两种玩法', '同图竞分：相同开局，各自拆解。到时比分，再比完成波次；触底保留分数，其余选手继续。'], ['连锁对战', '累计其他存活选手的消除与掉落。2 / 3 / 4 人每 12 / 24 / 36 球形成一行来袭，2 秒预告后安全下压。'], ['攻击与防御', '自己每消除 12 球抵消一行来袭；同次消除也贡献给其他人。队列最多 3 行，两次攻击下压至少间隔 3 秒。'], ['暂停与设置', '暂停不限次数，同一申请人间隔15秒，每次最多60秒。全体在赛选手同意后暂停，可调整设置；完成后全员准备，共同倒计时恢复。'], ['连接帮助', '同一网络不一定允许广播。找不到房间时按地址检索；使用房主显示的实际端口，确认网络隔离和防火墙。'] ];
        helpPage = Math.max(0, Math.min(helpPage, help.length - 1));
        base(help[helpPage][0], `<div class="lan-help-page"><p>${help[helpPage][1]}</p><p class="lan-muted">${helpPage + 1} / ${help.length}</p></div><div class="lan-actions">${button('lan-help-prev', '上一页')}${button('lan-help-next', '下一页')}${button('lan-back', '返回联机')}</div>`);
        q<HTMLButtonElement>('#lan-help-prev').disabled = helpPage === 0; q<HTMLButtonElement>('#lan-help-next').disabled = helpPage === help.length - 1;
        q('#lan-help-prev').onclick = () => { helpPage--; key = ''; render(); }; q('#lan-help-next').onclick = () => { helpPage++; key = ''; render(); }; q('#lan-back').onclick = () => setRoute('choose');
      } else if (view.phase === 'closed') {
        base('连接已结束', `<p id="lan-closed-reason" role="status"></p>${button('lan-retry', '重新加入', true)}`); q('#lan-retry').onclick = () => { browseTab = 'address'; run(() => session!.browse({ discover: false })); };
      } else base('正在连接…', '<p>正在连接局域网，可以返回取消。</p>');
    }
    text('#lan-error', error || view.error);
    if (view.phase === 'browsing') updateBrowser();
    if (view.phase === 'lobby') updateLobby();
    if (key.startsWith('game:') && view.snapshot) updateGame();
    if (view.phase === 'finished' && key === 'finished') {
      const result = view.snapshot!.result!, p = result.players[detailsId];
      text('#lan-result-detail', `${view.players.find(x => x.id === detailsId)?.name ?? '选手'} · 完成 ${p.completedWaves} 波 · 发射 ${p.totalShots} 次${p.battle ? ` · 抵消 ${p.battle.cancelledRows} 行 / 下压 ${p.battle.appliedRows} 行` : ''}`);
      text('#lan-finished-notice', view.notice); q<HTMLButtonElement>('#lan-rematch').disabled = view.players.filter(p => p.connected).length < 2;
    }
    if (view.phase === 'idle' && route === 'history') {
      const records = [
        ...loadLanHistory().map(r => ({ endedAt: r.endedAt, label: resultLabel(r.result, r.selfId), detail: `${r.names?.[r.selfId] ?? '你'} · ${r.result.players[r.selfId].score} 分 · ${modeName(r.mode)} · ${Object.keys(r.result.players).length} 人 · ${r.protocolVersion === 3 ? '联机协议 v3' : '旧版规则'}` })),
        ...loadPendingLanHistory().map(r => ({ endedAt: r.endedAt, label: '最终结果未同步', detail: `${r.name} · ${r.score} 分 · ${modeName(r.mode)} · ${r.playerCount} 人 · ${r.reason === 'left-active' ? '主动离开' : '离开观战'}` })),
      ].sort((a, b) => b.endedAt - a.endedAt).slice(0, 100);
      const size = capacity(250, 78, 6); updatePager(records.length, size, () => { key = ''; render(); });
      q('#lan-history-list').innerHTML = records.slice(page * size, (page + 1) * size).map(r => `<article class="lan-history-row"><strong>${escape(r.label)}</strong><small>${escape(new Date(r.endedAt).toLocaleString('zh-CN'))}</small><p>${escape(r.detail)}</p></article>`).join('') || '<p>完成对局后，记录会出现在这里。</p>';
    }
    if (view.phase === 'closed') text('#lan-closed-reason', view.notice || view.error || '连接已关闭。');
  }

  function updateBrowser(): void {
    const view = session!.view, discovery = view.discovery, list = q('#lan-room-list');
    if (browseTab === 'address') return;
    if (browseTab === 'nearby') {
      const scanning = discovery.status === 'scanning'; text('#lan-refresh', scanning ? '停止' : '刷新');
      text('#lan-scan-status', scanning ? `查找中 · ${view.rooms.length} 个房间` : `${discovery.status === 'failed' ? '查找失败' : '本轮结束'} · ${view.rooms.length} 个房间`);
      const size = capacity(390, 160, 3); updatePager(view.rooms.length, size, updateBrowser);
      const markup = view.rooms.slice(page * size, (page + 1) * size).map(room => {
        const compatible = room.metadata.rulesHash === LAN_RULES_HASH && room.metadata.protocolVersion === LAN_PROTOCOL_VERSION && room.metadata.contentHash === LAN_CONTENT_HASH;
        const available = compatible && (room.metadata.players ?? 1) < (room.metadata.capacity ?? 2) && (!room.metadata.phase || room.metadata.phase === 'lobby');
        const status = !compatible ? '版本不兼容' : !available ? '满员 / 对局中' : session!.roomAgeMs(room) >= 12000 ? '暂未响应' : '可加入';
        return `<article class="lan-room"><strong>${escape(room.name)}</strong><small>${escape(room.metadata.platform ?? '未知平台')} · ${modeName(room.metadata.mode)} · ${room.metadata.players ?? '?'}/${room.metadata.capacity ?? '?'} · ${status}</small><select data-endpoints="${escape(room.metadata.roomId)}" aria-label="${escape(room.name)}的连接地址">${room.endpoints.map(endpoint => `<option value="${escape(endpoint.address)}:${endpoint.port}" ${selectedEndpoints.get(room.metadata.roomId) === `${endpoint.address}:${endpoint.port}` ? 'selected' : ''}>${escape(endpoint.address)}:${endpoint.port}</option>`).join('')}</select><div class="lan-actions"><button class="quiet-button" data-fill="${escape(room.metadata.roomId)}">填入地址</button><button class="primary-button" data-join="${escape(room.metadata.roomId)}" ${available ? '' : 'disabled'}>加入</button></div></article>`;
      }).join('') || '<p class="lan-muted">未收到房间回应。可切换「地址」按 IP 检索。</p>';
      if (roomMarkup !== markup && !(document.activeElement?.tagName === 'SELECT' && list.contains(document.activeElement))) {
        list.innerHTML = markup; roomMarkup = markup;
        list.querySelectorAll<HTMLSelectElement>('[data-endpoints]').forEach(select => { select.onchange = () => selectedEndpoints.set(select.dataset.endpoints!, select.value); });
        const endpoint = (id: string) => parseAddress([...list.querySelectorAll<HTMLSelectElement>('[data-endpoints]')].find(item => item.dataset.endpoints === id)?.value ?? '');
        list.querySelectorAll<HTMLButtonElement>('[data-fill]').forEach(item => { item.onclick = () => { const value = endpoint(item.dataset.fill!); if (!value) return; captureForm(); form.address = `${value.address}:${value.port}`; browseTab = 'address'; key = ''; render(); text('#lan-fill-notice', '已填入完整地址，点击加入即可连接。'); }; });
        list.querySelectorAll<HTMLButtonElement>('[data-join]').forEach(item => { item.onclick = () => { const value = endpoint(item.dataset.join!); if (!value) return; captureForm(); form.address = `${value.address}:${value.port}`; joinAddress(); }; });
      }
    } else if (browseTab === 'recent') {
      const items = recentLanAddresses(), size = capacity(330, 70, 6); updatePager(items.length, size, updateBrowser);
      const markup = items.slice(page * size, (page + 1) * size).map((item, index) => `<button class="lan-recent-row quiet-button" data-recent="${page * size + index}">${escape(item.name)}<small>${escape(item.address)}:${item.port} · 历史地址</small></button>`).join('') || '<p class="lan-muted">成功加入后会保留最近地址。</p>';
      if (roomMarkup !== markup) { list.innerHTML = markup; roomMarkup = markup; list.querySelectorAll<HTMLElement>('[data-recent]').forEach(item => { item.onclick = () => { captureForm(); const value = items[Number(item.dataset.recent)]; form.address = `${value.address}:${value.port}`; browseTab = 'address'; key = ''; render(); }; }); }
    } else {
      const lines = discovery.diagnostics, size = capacity(380, 38, 6); updatePager(lines.length, size, updateBrowser);
      const markup = `<p class="lan-muted">路径 ${discovery.paths} · 发送 ${discovery.sent} · 回应 ${discovery.received} · 错误 ${discovery.errors}</p><div class="lan-log-page">${lines.slice(page * size, (page + 1) * size).map(line => `<p>${escape(line)}</p>`).join('') || '<p>暂无诊断。没有回应不代表已确定故障原因。</p>'}</div>`;
      if (roomMarkup !== markup) { list.innerHTML = markup; roomMarkup = markup; }
      q('#lan-copy-log').onclick = () => run(async () => { await navigator.clipboard.writeText(lines.join('\n')); text('#lan-error', '诊断已复制'); });
    }
  }
  function openObservation(playerId: string): void {
    if (!session?.view.snapshot || root.querySelector('.lan-confirm')) return;
    observeId = playerId;
    const overlay = document.createElement('div'); overlay.className = 'lan-confirm'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', '观察对手棋盘'); overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = '<div class="lan-card"><h2 id="lan-observe-name"></h2><p>比赛仍在继续；此处不会触发你的发射。</p><canvas id="lan-observe-board" class="lan-observe-canvas" width="640" height="760" aria-label="观察的选手棋盘"></canvas><div class="lan-actions">'+button('lan-observe-prev', '上一位')+button('lan-observe-next', '下一位')+button('lan-stay', '返回自己', true)+'</div></div>';
    root.append(overlay); focusRelease = bindModalFocus(overlay, [q('.lan-body'), q('.lan-top')]);
    const dismiss = () => { observeId = ''; focusRelease?.(); focusRelease = undefined; overlay.remove(); };
    q('#lan-stay').onclick = dismiss;
    const turn = (delta: number) => { const ids = session!.view.snapshot!.playerIds.filter(id => id !== session!.view.selfId); observeId = ids[(ids.indexOf(observeId) + delta + ids.length) % ids.length]; render(); };
    q('#lan-observe-prev').onclick = () => turn(-1); q('#lan-observe-next').onclick = () => turn(1);
    overlay.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(); } }; render();
  }
  function updateLobby(): void {
    const view = session!.view;
    updateAddressShare();
    if (lobbyPage === 'addresses') {
      return;
    }
    if (lobbyPage !== 'players') return;
    const markup = Array.from({ length: 4 }, (_, index) => {
      const player = view.players[index]; return `<div class="lan-player"><strong>${player ? escape(player.name) : index < (view.config.capacity ?? 4) ? '等待朋友' : '未开放'}</strong><small>${player ? `${player.isHost || index === 0 ? '房主 · ' : ''}${player.connected ? player.ready ? '已准备' : '未准备' : '离线'}` : '空位'}</small>${player && view.isHost && player.id !== view.selfId ? `<button class="text-button" data-kick="${escape(player.id)}" aria-label="移除${escape(player.name)}">移除</button>` : ''}</div>`;
    }).join('');
    if (q('#lan-players').innerHTML !== markup) { q('#lan-players').innerHTML = markup; root.querySelectorAll<HTMLElement>('[data-kick]').forEach(item => { item.onclick = () => session!.kick(item.dataset.kick); }); }
    text('#lan-settings-summary', summary(view.config)); text('#lan-ready', view.players.find(p => p.id === view.selfId)?.ready ? '取消准备' : '准备');
    const start = q<HTMLButtonElement>('#lan-start'); if (start) start.disabled = !roomEndpoints(view.hostInfo).length || view.players.length < 2 || view.players.some(p => !p.connected || !p.ready);
  }
  function updateGame(): void {
    const view = session!.view, snapshot = view.snapshot!, self = snapshot.players[view.selfId];
    if (!self) return;
    root.classList.toggle('lan-watching', self.sealed); root.classList.toggle('lan-battle', snapshot.mode === 'battle');
    text('#lan-self-name', `${view.players.find(p => p.id === view.selfId)?.name ?? '你'} · ${self.sealed ? '观战' : '你'}`);
    text('#lan-self-score', self.score.toLocaleString('zh-CN')); text('#lan-self-wave', self.sealed ? '已结束操作' : `第 ${self.waveIndex + 1} 波`);
    text('#lan-clock', formatLanDuration(Math.max(0, snapshot.durationMs - session!.displayElapsed()))); text('#lan-network', lanNetworkLabel(view.rtt));
    q('#lan-watch-self').hidden = !self.sealed || !root.dataset.watchPlayer;
    root.querySelectorAll<HTMLElement>('[data-watch]').forEach(item => item.setAttribute('aria-pressed', String(self.sealed && item.dataset.watch === root.dataset.watchPlayer)));
    for (const id of snapshot.playerIds.filter(id => id !== view.selfId)) {
      const p = snapshot.players[id], peer = view.players.find(item => item.id === id); text(`[data-player-name="${id}"]`, peer?.name ?? '选手'); text(`[data-player-score="${id}"]`, `${p.score} 分`); text(`[data-player-state="${id}"]`, p.forfeited ? '弃权' : p.sealed ? snapshot.mode === 'score' ? '已封盘' : '已淘汰' : peer?.connected === false ? '掉线' : `第 ${p.waveIndex + 1} 波`);
    }
    const status = lanStatusSummary(self, snapshot.playerIds.length, snapshot.startedAtMs + session!.displayElapsed());
    text('#lan-status-progress', status.progress); text('#lan-status-defense', status.defense); text('#lan-status-queue', status.queue); text('#lan-attack-warning', status.warning);
    q('#lan-status-defense').hidden = !status.defense; q('#lan-attack-warning').hidden = !status.warning;
    const outcome = view.pauseOutcome && (view.pauseOutcome.status !== 'approved' || view.phase === 'paused') ? view.pauseOutcome.message : '';
    text('#lan-notice', view.notice || outcome || (self.sealed ? '点击其他选手切换观战。' : usesButtonControls() ? loadSettings().immersiveMode ? '按住瞄准，松手发射。' : '方向与微调；支持双指操作。' : '鼠标左右键松开发射 · 沿用自定义快捷键'));
    if (observeId && q<HTMLCanvasElement>('#lan-observe-board')) {
      text('#lan-observe-name', `${view.players.find(p => p.id === observeId)?.name ?? '选手'} · ${snapshot.players[observeId].score} 分`);
      q<HTMLCanvasElement>('#lan-observe-board').dataset.lanObservePlayer = observeId;
    }
    q<HTMLButtonElement>('#lan-pause').disabled = view.phase !== 'playing' || !!view.pauseRequest || self.sealed;
    q<HTMLButtonElement>('#lan-settings').disabled = view.forceCloseSettings || !['paused', 'playing'].includes(view.phase) || view.phase === 'playing' && (!!view.pauseRequest || self.sealed);
    const request = view.pauseRequest, requestBox = q('#lan-pause-request'); requestBox.hidden = !request; q('#lan-attack-bar').hidden = !!request;
    root.classList.toggle('lan-voting', !!request);
    if (request) {
      if (requestKey !== request.requestId) {
        requestKey = request.requestId;
        requestBox.innerHTML = `<span id="lan-request-message" role="status"></span><div class="lan-actions">${request.requesterId === view.selfId ? button('lan-cancel-pause', '取消申请') : button('lan-accept-pause', '同意暂停')+button('lan-reject-pause', '继续比赛')}</div>`;
        q('#lan-cancel-pause')?.addEventListener('click', () => session!.cancelPause()); q('#lan-accept-pause')?.addEventListener('click', () => session!.decidePause(true, request.requestId)); q('#lan-reject-pause')?.addEventListener('click', () => session!.decidePause(false, request.requestId));
      }
      const votes = request.participantIds.filter(id => request.votes[id] === true).length;
      text('#lan-request-message', `${view.players.find(p => p.id === request.requesterId)?.name ?? '选手'}申请${request.reason === 'settings' ? '设置' : ''}暂停 · ${votes}/${request.participantIds.length} 同意 · ${Math.ceil(view.pauseVoteRemainingMs / 1000)}秒`);
      const accepted = request.votes[view.selfId] === true; if (q<HTMLButtonElement>('#lan-accept-pause')) q<HTMLButtonElement>('#lan-accept-pause').disabled = accepted || !request.participantIds.includes(view.selfId);
      if (q<HTMLButtonElement>('#lan-reject-pause')) q<HTMLButtonElement>('#lan-reject-pause').disabled = accepted || !request.participantIds.includes(view.selfId);
    } else requestKey = '';
    const overlay = q('#lan-game-overlay'); overlay.hidden = ['playing', 'finished'].includes(view.phase);
    const markup = view.phase === 'countdown' ? '<strong id="lan-overlay-countdown"></strong><p>所有选手同时开局</p>' : view.phase === 'preparing' ? '<strong>装载棋盘…</strong><p>等待全部选手完成准备。</p>' : `<strong>${view.phase === 'reconnecting' ? '等待恢复连接' : '比赛已暂停'}</strong><p id="lan-overlay-notice"></p><small id="lan-pause-time"></small><div class="lan-actions">${view.phase === 'paused' ? button('lan-overlay-settings', '本机设置') : ''}${button('lan-resume', '准备继续', true)}</div><small id="lan-ready-count"></small>`;
    if (!overlay.hidden && pauseMarkup !== markup) {
      overlay.innerHTML = markup; pauseMarkup = markup; q('#lan-overlay-settings')?.addEventListener('click', openSettings); q('#lan-resume')?.addEventListener('click', () => session!.resume());
    }
    text('#lan-overlay-countdown', String(view.countdown || '开始')); text('#lan-overlay-notice', view.notice);
    text('#lan-pause-time', view.phase === 'paused' ? `本次剩余 ${Math.ceil(view.pauseRemainingMs / 1000)} 秒` : '网络恢复后统一装载并继续');
    text('#lan-ready-count', `${view.resumeReady.length} 人已准备`);
    const resume = q<HTMLButtonElement>('#lan-resume'); if (resume) { resume.disabled = view.resumeReady.includes(view.selfId) || settingsVisible || self.sealed && !view.isHost; resume.textContent = view.resumeReady.includes(view.selfId) ? '等待其余选手' : '准备继续'; }
    const settingsButton = q<HTMLButtonElement>('#lan-overlay-settings'); if (settingsButton) settingsButton.disabled = view.forceCloseSettings;
  }
  const resize = () => {
    if (root.hidden) return;
    const focused = document.activeElement as HTMLInputElement | null;
    if (getKeyboardState().visible && focused?.tagName === 'INPUT' && !focused.readOnly && !focused.disabled && !focused.closest('#modal-root') && focused.closest('#lan-screen') && !keyboardField) {
      const label = focused.closest<HTMLElement>('.lan-field');
      if (label) { const marker = document.createComment('field'); label.replaceWith(marker); const overlay = document.createElement('div'); overlay.className = 'lan-field-editor'; overlay.append(label); const done = document.createElement('button'); done.className = 'primary-button'; done.textContent = '完成输入'; done.onclick = closeKeyboard; overlay.append(done); root.append(overlay); root.classList.add('lan-editing'); keyboardField = { label, marker, overlay }; focused.focus(); }
    } else if (keyboardField && !getKeyboardState().visible) closeKeyboard();
    if (!keyboardField) render();
  };
  entryButton.addEventListener('click', open);
  window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize);
  subscribeKeyboardState(resize);
  subscribeSettings(settings => { if (!root.hidden) syncGameShell(root, { touch: usesButtonControls(), immersive: settings.immersiveMode, mode: session?.view.snapshot?.mode ?? 'lan' }); });
  window.addEventListener('keydown', event => {
    if (root.hidden || event.defaultPrevented || event.repeat || settingsVisible || root.querySelector('.lan-confirm')) return;
    if (event.key === 'Escape') { event.preventDefault(); confirmLeave(); return; }
    if ((event.target as HTMLElement | null)?.closest?.('input,select,textarea,button')) return;
    if (shortcutAction(event, loadSettings().shortcuts) === 'settings' && session?.view.snapshot) { event.preventDefault(); if (session.view.phase === 'paused') openSettings(); else session.requestPause('settings'); }
  });
  return { isActive: () => !root.hidden, back: confirmLeave, foreground: active => session?.foregroundChanged(active) };
}
