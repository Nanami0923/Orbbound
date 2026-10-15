import { advanceMatch, applyShot, createMatch, finishMatch, forfeitMatch } from './authority';
import { isMatchSnapshot, LAN_CONTENT_HASH, LAN_PROTOCOL_VERSION, LAN_RULES_HASH, type MatchSnapshot } from './protocol';
import type { DiscoveredRoom, HostInfo, LanEvent, LanTransport } from './transport';

export type SessionPhase = 'idle' | 'browsing' | 'joining' | 'lobby' | 'preparing' | 'countdown' | 'playing' | 'paused' | 'reconnecting' | 'finished' | 'closed';
export interface RoomConfig { difficultyId: 'easy' | 'normal' | 'hard'; durationMs: 180000 | 300000 }
export interface RoomPlayer { id: string; name: string; ready: boolean; connected: boolean }
export interface SessionView {
  phase: SessionPhase; isHost: boolean; selfId: string; roomId: string; roomName: string;
  config: RoomConfig; players: RoomPlayer[]; hostInfo?: HostInfo; snapshot?: MatchSnapshot;
  countdown: number; rtt: number; error: string; notice: string; pauseRequester?: string;
  resumeReady: string[]; pendingShot: boolean; rooms: DiscoveredRoom[];
}
type Packet = { v: number; type: string; roomId: string; matchId?: string; data: Record<string, unknown> };
const id = () => globalThis.crypto.randomUUID();
const cleanName = (value: unknown, max = 16) => typeof value === 'string' ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, max).join('') : '';
export function validRoomConfig(value: unknown): value is RoomConfig {
  const c = value as RoomConfig | null;
  return !!c && ['easy', 'normal', 'hard'].includes(c.difficultyId) && [180000, 300000].includes(c.durationMs);
}
export class LanSession {
  readonly view: SessionView = { phase: 'idle', isHost: false, selfId: 'guest', roomId: '', roomName: '',
    config: { difficultyId: 'normal', durationMs: 180000 }, players: [], countdown: 0, rtt: 0,
    error: '', notice: '', resumeReady: [], pendingShot: false, rooms: [] };
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval>;
  private peer?: string;
  private candidates = new Map<string, number>();
  private reconnectToken = '';
  private target?: { address: string; port: number };
  private nickname = '';
  private lastReceive = 0;
  private lastPing = 0;
  private lastPublish = 0;
  private lastTick = 0;
  private activeMs = 0;
  private startAt = 0;
  private offset = 0;
  private bestRtt = Infinity;
  private sequence = 0;
  private serverSeq = 0;
  private lastServerSeq = -1;
  private epoch = 0;
  private receivedEpoch = 0;
  private pendingSeq?: number;
  private foreground = true;
  private peerForeground = true;
  private recoveryDeadline = 0;
  private recoveryBegan = 0;
  private recoverySpent = 0;
  private recoveryCount = 0;
  private retryAt = 0;
  private retrying = false;
  private preparationDeadline = 0;
  private pauseDeadline = 0;
  private pauseUsed = new Set<string>();
  private roomSeen = new Map<string, number>();
  private closed = false;
  private generation = 0;
  private commands = new Map<string, Record<string, unknown>>();
  private packetWindow = 0;
  private packetCount = 0;
  private seenMatches = new Set<string>();
  private awaitingWelcome = false;

  constructor(readonly transport: LanTransport, private now = () => performance.now()) {
    this.unsubscribe = transport.subscribe(event => this.event(event));
    this.timer = setInterval(() => this.tick(), 50);
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { for (const listener of this.listeners) listener(); }
  private fail(error: unknown): void { this.view.error = error instanceof Error ? error.message : String(error); this.changed(); }
  private send(type: string, data: Record<string, unknown> = {}, connectionId = this.peer): void {
    if (!connectionId || this.closed) return;
    const message: Packet = { v: 1, type, roomId: this.view.roomId, matchId: this.view.snapshot?.matchId, data };
    void this.transport.request('send', { connectionId, message: JSON.stringify(message) }).catch(() => {
      if (this.peer === connectionId && !this.closed) this.disconnected(connectionId);
    });
  }
  private disconnect(connectionId: string): void { void this.transport.request('disconnect', { connectionId }).catch(() => {}); }
  private roomState(): Record<string, unknown> {
    return { roomId: this.view.roomId, roomName: this.view.roomName, config: this.view.config,
      players: this.view.players, phase: this.view.phase, pauseRequester: this.view.pauseRequester ?? null,
      resumeReady: this.view.resumeReady, notice: this.view.notice };
  }
  private publishRoom(): void { this.send('ROOM', this.roomState()); this.changed(); }
  private publishSnapshot(): void {
    if (!this.view.snapshot) return;
    this.send('STATE', { snapshot: this.view.snapshot, serverSeq: ++this.serverSeq, epoch: this.epoch });
    this.lastPublish = this.now(); this.changed();
  }
  private async reset(): Promise<void> {
    this.generation++; this.peer = undefined; this.awaitingWelcome = false; this.candidates.clear(); this.commands.clear();
    this.view.pendingShot = false; this.pendingSeq = undefined; this.view.snapshot = undefined;
    this.view.resumeReady = []; this.view.pauseRequester = undefined; this.reconnectToken = '';
    this.recoveryDeadline = 0; this.recoverySpent = 0; this.recoveryCount = 0;
    this.pauseUsed.clear(); this.epoch = 0; this.lastServerSeq = -1; this.receivedEpoch = 0;
    this.bestRtt = Infinity; this.offset = 0; this.sequence = 0; this.serverSeq = 0;
    this.target = undefined; this.retrying = false; this.retryAt = 0; this.view.hostInfo = undefined; this.view.error = ''; this.view.notice = '';
    this.view.players = []; this.view.roomId = ''; this.view.rooms = []; this.roomSeen.clear();
    await this.transport.request('dispose').catch(() => {});
  }
  async browse(): Promise<void> {
    const operation = this.reset(), generation = this.generation; await operation; if (generation !== this.generation || this.closed) return;
    this.view.isHost = false; this.view.selfId = 'guest'; this.view.phase = 'browsing'; this.changed();
    try { await this.transport.request('discover'); } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  async host(name: string, roomName: string, config: RoomConfig): Promise<void> {
    if (!validRoomConfig(config)) throw new Error('房间设置无效');
    const operation = this.reset(), generation = this.generation; await operation; if (generation !== this.generation || this.closed) return;
    this.nickname = cleanName(name) || '玩家'; this.view.isHost = true; this.view.selfId = 'host';
    this.view.roomId = id(); this.view.roomName = cleanName(roomName, 24) || `${this.nickname}的房间`;
    this.view.config = { ...config }; this.view.players = [{ id: 'host', name: this.nickname, ready: false, connected: true }];
    this.view.phase = 'joining'; this.changed();
    try {
      const hostInfo = await this.transport.request<HostInfo>('startHost', { name: this.view.roomName,
        metadata: { roomId: this.view.roomId, protocolVersion: LAN_PROTOCOL_VERSION, rulesHash: LAN_RULES_HASH } });
      if (generation !== this.generation || this.closed) return;
      this.view.hostInfo = hostInfo;
      this.view.phase = 'lobby'; this.changed();
    } catch (error) { if (generation !== this.generation) return; this.view.phase = 'idle'; this.fail(error); throw error; }
  }
  async join(name: string, address: string, port: number): Promise<void> {
    const operation = this.reset(), generation = this.generation; await operation; if (generation !== this.generation || this.closed) return;
    this.nickname = cleanName(name) || '玩家'; this.view.selfId = 'guest'; this.view.isHost = false;
    this.target = { address, port }; this.view.phase = 'joining'; this.preparationDeadline = this.now() + 10000; this.changed();
    try { await this.connect(); } catch (error) { if (generation !== this.generation) return; this.view.phase = 'browsing'; this.fail(error); throw error; }
  }
  private async connect(): Promise<void> {
    if (!this.target || this.retrying) return;
    this.retrying = true; const generation = this.generation;
    try {
      const result = await this.transport.request<{ connectionId: string }>('connect', this.target);
      if (generation !== this.generation || this.closed) { this.disconnect(result.connectionId); return; }
      this.peer = result.connectionId; this.awaitingWelcome = true; this.lastReceive = this.now();
      this.send('HELLO', { protocolVersion: LAN_PROTOCOL_VERSION, rulesHash: LAN_RULES_HASH, contentHash: LAN_CONTENT_HASH,
        name: this.nickname, token: this.reconnectToken, foreground: this.foreground, appVersion: import.meta.env.VITE_APP_VERSION });
    } finally { if (generation === this.generation) { this.retrying = false; this.retryAt = this.now() + 1500; } }
  }
  setConfig(config: RoomConfig): void {
    if (!this.view.isHost || this.view.phase !== 'lobby' || !validRoomConfig(config)) return;
    this.view.config = { ...config }; this.view.players.forEach(player => { player.ready = false; }); this.publishRoom();
  }
  ready(): void {
    if (this.view.phase !== 'lobby') return;
    if (!this.view.isHost) { this.send('READY', { ready: !this.view.players.find(p => p.id === this.view.selfId)?.ready }); return; }
    const player = this.view.players.find(p => p.id === 'host')!; player.ready = !player.ready; this.publishRoom();
  }
  start(): void {
    if (!this.view.isHost || this.view.phase !== 'lobby' || this.view.players.length !== 2 || this.view.players.some(p => !p.ready || !p.connected) || !this.foreground || !this.peerForeground) return;
    this.activeMs = 0; this.sequence = 0; this.commands.clear(); this.pauseUsed.clear(); this.recoveryCount = 0; this.recoverySpent = 0; this.epoch++;
    this.view.snapshot = createMatch({ ...this.view.config, seed: crypto.getRandomValues(new Uint32Array(1))[0], matchId: id(), playerIds: ['host', 'guest'] }, 0);
    this.view.phase = 'preparing'; this.preparationDeadline = this.now() + 10000; this.view.notice = '等待双方棋盘就绪';
    this.send('PREPARE', { snapshot: this.view.snapshot, epoch: this.epoch }); this.publishRoom();
  }
  shoot(angleMilliDeg: number): void {
    const snapshot = this.view.snapshot;
    if (this.view.phase !== 'playing' || !snapshot || this.view.pendingShot || !this.foreground) return;
    const player = snapshot.players[this.view.selfId]; if (!player || player.sealed) return;
    const seq = ++this.sequence;
    const data = { seq, boardRevision: player.boardRevision, angleMilliDeg, epoch: this.view.isHost ? this.epoch : this.receivedEpoch };
    if (this.view.isHost) this.acceptShot('host', data);
    else { this.pendingSeq = seq; this.view.pendingShot = true; this.send('SHOT', data); this.changed(); }
  }
  private acceptShot(playerId: string, data: Record<string, unknown>): void {
    if (this.view.phase !== 'playing' || !this.view.snapshot || data.epoch !== this.epoch) return;
    const now = this.now(), delta = Math.max(0, now - this.lastTick);
    if (delta > 1500 || !this.foreground || !this.peerForeground) { this.freeze('等待双方返回对局', true); return; }
    this.activeMs += delta; this.lastTick = now;
    const key = `${playerId}:${String(data.seq)}`;
    const cached = this.commands.get(key);
    if (cached) { if (playerId === 'guest') this.send('COMMAND', cached); return; }
    const response = applyShot(this.view.snapshot, { playerId, seq: data.seq as number,
      boardRevision: data.boardRevision as number, angleMilliDeg: data.angleMilliDeg as number }, this.activeMs);
    this.view.snapshot = response.snapshot;
    const result = { seq: data.seq, accepted: response.accepted, reason: response.reason ?? '', epoch: this.epoch };
    this.commands.set(key, result); if (this.commands.size > 512) this.commands.delete(this.commands.keys().next().value!);
    if (playerId === 'guest') this.send('COMMAND', result);
    else if (!response.accepted) this.view.notice = rejectionMessage(response.reason);
    this.publishSnapshot(); this.checkFinished();
  }
  requestPause(): void {
    if (this.view.phase !== 'playing' || this.view.pauseRequester) return;
    if (this.view.isHost) this.askPause('host'); else this.send('PAUSE_REQUEST');
  }
  private askPause(playerId: string): void {
    if (this.pauseUsed.has(playerId)) { this.view.notice = '每人每局可请求一次暂停'; this.publishRoom(); return; }
    this.view.pauseRequester = playerId; this.publishRoom();
  }
  decidePause(accepted: boolean): void {
    if (!this.view.pauseRequester || this.view.pauseRequester === this.view.selfId) return;
    if (!this.view.isHost) { this.send('PAUSE_DECISION', { accepted }); return; }
    this.completePause(accepted);
  }
  private completePause(accepted: boolean): void {
    const requester = this.view.pauseRequester; this.view.pauseRequester = undefined;
    if (accepted && requester) { this.pauseUsed.add(requester); this.freeze('双方暂停 · 最长 30 秒', false); }
    else this.publishRoom();
  }
  resume(): void {
    if (!['paused', 'reconnecting'].includes(this.view.phase) || !this.foreground) return;
    if (!this.view.isHost) { this.send('RESUME_READY'); return; }
    if (!this.view.resumeReady.includes('host')) this.view.resumeReady.push('host');
    this.tryResume(); this.publishRoom();
  }
  private tryResume(): void {
    if (this.peer && this.foreground && this.peerForeground && this.view.resumeReady.length === 2) this.countdown();
  }
  private countdown(): void {
    if (!this.view.isHost || !this.peer || !this.foreground || !this.peerForeground) return;
    if (this.recoveryDeadline) this.recoverySpent += Math.max(0, this.now() - this.recoveryBegan);
    this.recoveryDeadline = 0; this.pauseDeadline = 0; this.view.resumeReady = [];
    this.view.pendingShot = false; this.pendingSeq = undefined; this.view.phase = 'countdown';
    this.startAt = this.now() + 3000; this.view.countdown = 3; this.view.notice = ''; this.epoch++;
    this.send('START', { startAt: this.startAt, snapshot: this.view.snapshot, epoch: this.epoch }); this.publishRoom();
  }
  private freeze(reason: string, recovery: boolean): void {
    if (!this.view.snapshot || this.view.snapshot.status === 'finished') return;
    if (recovery && !this.recoveryDeadline) {
      this.recoveryCount++; this.recoveryBegan = this.now();
      if (this.recoveryCount > 3 || this.recoverySpent >= 60000) { this.interrupt('恢复次数或等待时间已用尽'); return; }
      this.recoveryDeadline = this.now() + Math.min(20000, 60000 - this.recoverySpent);
    }
    this.view.phase = recovery ? 'reconnecting' : 'paused'; this.view.notice = reason;
    this.view.resumeReady = []; this.view.pauseRequester = undefined; this.view.pendingShot = false; this.pendingSeq = undefined;
    if (!recovery) this.pauseDeadline = this.now() + 30000;
    if (this.view.isHost) { this.send('FREEZE', { snapshot: this.view.snapshot, recovery, reason, epoch: this.epoch }); this.publishRoom(); }
    this.changed();
  }
  foregroundChanged(active: boolean): void {
    if (this.foreground === active) return; this.foreground = active;
    if (!active) {
      this.send('BACKGROUND');
      if (['playing', 'countdown', 'paused', 'preparing'].includes(this.view.phase)) this.freeze('玩家离开前台，等待恢复 · 最多 20 秒', true);
    } else { this.lastTick = this.now(); this.send('FOREGROUND'); this.changed(); }
  }
  rematch(): void {
    if (this.view.phase !== 'finished' || !this.peer) return;
    if (!this.view.isHost) { this.send('REMATCH'); return; }
    this.toLobby();
  }
  private toLobby(): void {
    this.view.snapshot = undefined; this.view.phase = 'lobby'; this.view.notice = '新一局使用新开局，请双方重新准备';
    this.view.players.forEach(p => { p.ready = false; }); this.send('LOBBY', this.roomState()); this.publishRoom();
  }
  kick(): void {
    if (!this.view.isHost || this.view.phase !== 'lobby' || !this.peer) return;
    const peer = this.peer; this.send('CLOSED', { reason: '房主已移除当前玩家' }); this.disconnected(peer); this.disconnect(peer);
  }
  private checkFinished(): void {
    if (this.view.snapshot?.status !== 'finished' || this.view.phase === 'finished') return;
    this.view.phase = 'finished'; this.view.pendingShot = false; this.view.pauseRequester = undefined;
    this.recoveryDeadline = 0; this.pauseDeadline = 0;
    if (this.view.isHost) { this.publishSnapshot(); this.publishRoom(); }
    this.changed();
  }
  private interrupt(reason: string): void {
    this.view.notice = reason;
    if (this.view.snapshot && this.view.snapshot.status !== 'finished') {
      this.view.snapshot = finishMatch(this.view.snapshot, 'interrupted', this.activeMs);
      this.checkFinished();
    } else { this.view.phase = 'closed'; this.changed(); }
    this.recoveryDeadline = 0;
  }
  async leave(): Promise<void> {
    if (this.view.snapshot?.status === 'playing') {
      if (this.view.isHost) {
        this.view.snapshot = forfeitMatch(this.view.snapshot, 'host', this.activeMs); this.publishSnapshot();
        this.send('CLOSED', { reason: '房主已退出', snapshot: this.view.snapshot });
      } else this.send('LEAVE');
      // Give the native serialized writer a bounded opportunity to flush the explicit leave.
      await new Promise(resolve => setTimeout(resolve, 100));
    } else this.send(this.view.isHost ? 'CLOSED' : 'LEAVE', { reason: '玩家已离开房间' });
    await this.reset(); this.view.phase = 'idle'; this.changed();
  }
  async close(): Promise<void> {
    await this.leave(); this.closed = true; clearInterval(this.timer); this.unsubscribe(); this.listeners.clear(); await this.transport.close();
  }
  private event(event: LanEvent): void {
    if (this.closed) return;
    if (event.event === 'background' || event.event === 'foreground') { this.foregroundChanged(event.event === 'foreground'); return; }
    if (event.event === 'discovered' && this.view.phase === 'browsing' && event.room) {
      const room = event.room;
      if (typeof room.name !== 'string' || typeof room.address !== 'string' || !Number.isInteger(room.port)
        || !room.metadata || typeof room.metadata.roomId !== 'string') return;
      const key = `${room.metadata.roomId}:${room.address}:${room.port}`; this.roomSeen.set(key, this.now());
      this.view.rooms = [...this.view.rooms.filter(r => `${r.metadata.roomId}:${r.address}:${r.port}` !== key), room].slice(-30); this.changed(); return;
    }
    if (event.event === 'error') { this.fail(event.error ?? '网络服务异常'); return; }
    if (!event.connectionId) return;
    if (event.event === 'connected' && this.view.isHost && event.connectionId !== this.peer && !this.candidates.has(event.connectionId)) this.candidates.set(event.connectionId, this.now() + 5000);
    if (event.event === 'disconnected') { this.candidates.delete(event.connectionId); this.disconnected(event.connectionId); }
    if (event.event === 'message' && typeof event.message === 'string') this.receive(event.connectionId, event.message);
  }
  private disconnected(connectionId: string): void {
    if (connectionId !== this.peer) return;
    this.peer = undefined; this.view.pendingShot = false; this.pendingSeq = undefined;
    const remoteId = this.view.isHost ? 'guest' : 'host'; const player = this.view.players.find(p => p.id === remoteId);
    if (player) player.connected = false;
    if (this.view.phase === 'lobby' && this.view.isHost) {
      this.view.players = this.view.players.filter(p => p.id !== 'guest'); this.reconnectToken = ''; this.publishRoom();
    } else if (['playing', 'paused', 'countdown', 'reconnecting'].includes(this.view.phase)) this.freeze('连接中断，正在等待恢复 · 最多 20 秒', true);
    else if (this.view.phase !== 'finished') { this.view.phase = 'closed'; this.view.notice = '与房主的连接已关闭，请重新加入'; this.changed(); }
    else this.changed();
  }
  private receive(connectionId: string, text: string): void {
    if (text.length > 65536) { this.disconnect(connectionId); return; }
    let packet: Packet;
    try { packet = JSON.parse(text); } catch { this.disconnect(connectionId); return; }
    if (!packet || packet.v !== 1 || typeof packet.type !== 'string' || !packet.data || typeof packet.data !== 'object' || Array.isArray(packet.data)) { this.disconnect(connectionId); return; }
    const data = packet.data;
    if (this.view.isHost && packet.type === 'HELLO') { this.hello(connectionId, data, packet.roomId); return; }
    if (connectionId !== this.peer) return;
    if (this.now() - this.packetWindow >= 1000) { this.packetWindow = this.now(); this.packetCount = 0; }
    if (++this.packetCount > 80) { this.disconnect(connectionId); return; }
    if (packet.type !== 'WELCOME' && packet.type !== 'REJECT' && packet.roomId !== this.view.roomId) return;
    this.lastReceive = this.now();
    if (packet.type === 'PING') { this.send('PONG', { sent: data.sent, now: this.now() }); return; }
    if (packet.type === 'PONG' && typeof data.sent === 'number' && Number.isFinite(data.sent) && typeof data.now === 'number' && Number.isFinite(data.now)) {
      const rtt = Math.max(0, this.now() - data.sent); this.view.rtt = Math.round(rtt);
      if (!this.view.isHost && rtt <= this.bestRtt + 10) { this.bestRtt = Math.min(rtt, this.bestRtt); this.offset = data.now - (data.sent + this.now()) / 2; }
      return;
    }
    if (this.view.isHost) this.hostPacket(packet.type, data, packet.matchId);
    else {
      if (['START', 'COMMAND', 'STATE', 'FREEZE'].includes(packet.type) && packet.matchId !== this.view.snapshot?.matchId) return;
      if (packet.type === 'CLOSED' && this.view.snapshot && packet.matchId !== this.view.snapshot.matchId) return;
      this.guestPacket(packet.type, data);
    }
  }
  private hello(connectionId: string, data: Record<string, unknown>, roomId: string): void {
    const reject = (reason: string) => { this.send('REJECT', { reason }, connectionId); setTimeout(() => this.disconnect(connectionId), 150); };
    if (!['lobby', 'reconnecting', 'paused', 'finished'].includes(this.view.phase)) { reject('房间正在对局中'); return; }
    if (data.protocolVersion !== 1 || data.rulesHash !== LAN_RULES_HASH || data.contentHash !== LAN_CONTENT_HASH) { reject('版本不兼容，请双方更新到相同联机版本'); return; }
    if (roomId && roomId !== this.view.roomId) { reject('房间已失效，请重新查找'); return; }
    const resume = !!this.reconnectToken && data.token === this.reconnectToken;
    if ((this.peer && this.peer !== connectionId) || (this.view.phase !== 'lobby' && !resume)) { reject('房间已满，或恢复身份不匹配'); return; }
    this.candidates.delete(connectionId); this.peer = connectionId; this.lastReceive = this.now(); this.peerForeground = data.foreground !== false;
    if (!resume) this.reconnectToken = id(); else this.epoch++;
    let guest = this.view.players.find(p => p.id === 'guest');
    if (!guest) { guest = { id: 'guest', name: cleanName(data.name) || '玩家', ready: false, connected: true }; this.view.players.push(guest); }
    guest.connected = true;
    this.send('WELCOME', { ...this.roomState(), token: this.reconnectToken, rulesHash: LAN_RULES_HASH, contentHash: LAN_CONTENT_HASH,
      snapshot: this.view.snapshot ?? null, epoch: this.epoch, hostNow: this.now(), serverSeq: this.serverSeq });
    this.publishRoom();
  }
  private hostPacket(type: string, data: Record<string, unknown>, matchId?: string): void {
    if (['SHOT', 'LOADED', 'RESUME_READY', 'PAUSE_REQUEST', 'PAUSE_DECISION'].includes(type) && matchId !== this.view.snapshot?.matchId) return;
    switch (type) {
      case 'READY': if (this.view.phase === 'lobby') { const guest = this.view.players.find(p => p.id === 'guest'); if (guest) guest.ready = data.ready === true; this.publishRoom(); } break;
      case 'LOADED': if (this.view.phase === 'preparing' && this.foreground && this.peerForeground) this.countdown(); break;
      case 'SHOT': this.acceptShot('guest', data); break;
      case 'RESYNC': this.publishSnapshot(); break;
      case 'PAUSE_REQUEST': if (this.view.phase === 'playing' && !this.view.pauseRequester) this.askPause('guest'); break;
      case 'PAUSE_DECISION': if (this.view.pauseRequester === 'host') this.completePause(data.accepted === true); break;
      case 'BACKGROUND': this.peerForeground = false; if (['playing', 'countdown', 'paused', 'preparing'].includes(this.view.phase)) this.freeze('对方离开前台，等待恢复 · 最多 20 秒', true); break;
      case 'FOREGROUND': this.peerForeground = true; this.publishRoom(); break;
      case 'RESUME_READY': if (['paused', 'reconnecting'].includes(this.view.phase) && this.peerForeground) { if (!this.view.resumeReady.includes('guest')) this.view.resumeReady.push('guest'); this.tryResume(); this.publishRoom(); } break;
      case 'REMATCH': if (this.view.phase === 'finished') this.toLobby(); break;
      case 'LEAVE': {
        if (this.view.snapshot?.status === 'playing') { this.view.snapshot = forfeitMatch(this.view.snapshot, 'guest', this.activeMs); this.checkFinished(); }
        const peer = this.peer; if (peer) { this.disconnected(peer); this.disconnect(peer); }
        break;
      }
    }
  }
  private readRoom(data: Record<string, unknown>): void {
    if (typeof data.roomId !== 'string' || !validRoomConfig(data.config) || !Array.isArray(data.players) || data.players.length > 2) return;
    const players = data.players as RoomPlayer[];
    if (players.some(p => !p || !['host', 'guest'].includes(p.id) || typeof p.name !== 'string' || typeof p.ready !== 'boolean' || typeof p.connected !== 'boolean')) return;
    this.view.roomId = data.roomId; this.view.roomName = cleanName(data.roomName, 24); this.view.config = data.config;
    this.view.players = players.map(p => ({ ...p, name: cleanName(p.name) }));
    this.view.pauseRequester = data.pauseRequester === 'host' || data.pauseRequester === 'guest' ? data.pauseRequester : undefined;
    this.view.resumeReady = Array.isArray(data.resumeReady) ? data.resumeReady.filter((p): p is string => p === 'host' || p === 'guest') : [];
    if (typeof data.notice === 'string') this.view.notice = data.notice.slice(0, 160);
  }
  private guestPacket(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case 'WELCOME': {
        if (!this.awaitingWelcome || !['joining', 'reconnecting'].includes(this.view.phase)) return;
        if (data.rulesHash !== LAN_RULES_HASH || data.contentHash !== LAN_CONTENT_HASH || typeof data.token !== 'string' || typeof data.epoch !== 'number') { this.fail('联机版本不兼容'); return; }
        this.awaitingWelcome = false;
        this.readRoom(data); this.reconnectToken = data.token; this.receivedEpoch = data.epoch;
        this.view.pendingShot = false; this.pendingSeq = undefined;
        if (typeof data.hostNow === 'number') this.offset = data.hostNow - this.now();
        if (isMatchSnapshot(data.snapshot)) {
          this.view.snapshot = data.snapshot; this.activeMs = data.snapshot.elapsedMs; this.lastPublish = this.now();
          this.seenMatches.add(data.snapshot.matchId);
          this.sequence = Math.max(this.sequence, data.snapshot.players.guest.lastSeq);
          this.view.phase = data.snapshot.status === 'finished' ? 'finished' : 'reconnecting';
        } else { this.view.phase = 'lobby'; this.view.snapshot = undefined; }
        this.send('PING', { sent: this.now() }); this.changed(); break;
      }
      case 'ROOM': this.readRoom(data); this.changed(); break;
      case 'LOBBY': this.readRoom(data); this.view.snapshot = undefined; this.view.phase = 'lobby'; this.recoveryDeadline = 0; this.view.pendingShot = false; this.changed(); break;
      case 'PREPARE':
        if (!isMatchSnapshot(data.snapshot)) { this.fail('初始棋盘校验失败，请重新加入'); return; }
        if (this.view.phase === 'preparing' && this.view.snapshot?.matchId === data.snapshot.matchId) { if (this.foreground) this.send('LOADED'); return; }
        if (this.view.phase !== 'lobby' || this.seenMatches.has(data.snapshot.matchId)) return;
        this.seenMatches.add(data.snapshot.matchId);
        this.view.snapshot = data.snapshot; this.receivedEpoch = data.epoch as number; this.sequence = 0; this.lastServerSeq = -1;
        this.view.phase = 'preparing'; this.activeMs = 0; this.preparationDeadline = this.now() + 10000;
        if (this.foreground) this.send('LOADED'); else this.send('BACKGROUND'); this.changed(); break;
      case 'START':
        if (!isMatchSnapshot(data.snapshot) || typeof data.startAt !== 'number' || !Number.isFinite(data.startAt)) return;
        if (!['preparing', 'paused', 'reconnecting', 'countdown'].includes(this.view.phase) || typeof data.epoch !== 'number' || data.epoch < this.receivedEpoch) return;
        if (!this.foreground) { this.send('BACKGROUND'); return; }
        this.view.snapshot = data.snapshot; this.receivedEpoch = data.epoch; this.activeMs = data.snapshot.elapsedMs; this.lastPublish = this.now();
        this.view.phase = 'countdown'; this.startAt = data.startAt - this.offset; this.recoveryDeadline = 0;
        this.view.pendingShot = false; this.pendingSeq = undefined; this.view.notice = ''; this.changed(); break;
      case 'STATE': {
        if (!isMatchSnapshot(data.snapshot) || data.snapshot.matchId !== this.view.snapshot?.matchId || data.epoch !== this.receivedEpoch
          || typeof data.serverSeq !== 'number' || data.serverSeq < this.lastServerSeq) return;
        this.lastServerSeq = data.serverSeq; this.view.snapshot = data.snapshot; this.activeMs = data.snapshot.elapsedMs; this.lastPublish = this.now();
        this.checkFinished(); this.changed(); break;
      }
      case 'COMMAND':
        if (data.epoch !== this.receivedEpoch || data.seq !== this.pendingSeq) return;
        this.view.pendingShot = false; this.pendingSeq = undefined;
        if (data.accepted !== true) { this.view.notice = rejectionMessage(data.reason); this.send('RESYNC'); }
        else this.view.notice = '';
        this.changed(); break;
      case 'FREEZE':
        if (isMatchSnapshot(data.snapshot) && data.snapshot.matchId === this.view.snapshot?.matchId) {
          this.view.snapshot = data.snapshot; this.activeMs = data.snapshot.elapsedMs;
          this.freeze(typeof data.reason === 'string' ? data.reason.slice(0, 160) : '比赛已暂停', data.recovery === true);
        }
        break;
      case 'REJECT': this.view.error = typeof data.reason === 'string' ? data.reason.slice(0, 160) : '无法加入'; this.view.phase = 'closed'; this.changed(); break;
      case 'CLOSED':
        if (isMatchSnapshot(data.snapshot) && data.snapshot.status === 'finished') { this.view.snapshot = data.snapshot; this.checkFinished(); }
        else if (this.view.snapshot?.status === 'playing') this.interrupt('房主已关闭房间');
        else if (this.view.phase !== 'finished') this.view.phase = 'closed';
        this.view.notice = typeof data.reason === 'string' ? data.reason.slice(0, 160) : '房间已关闭'; this.changed(); break;
    }
  }
  private tick(): void {
    if (this.closed) return;
    const now = this.now(), delta = this.lastTick ? Math.max(0, now - this.lastTick) : 0; this.lastTick = now;
    for (const [connectionId, deadline] of this.candidates) if (now > deadline) { this.candidates.delete(connectionId); this.disconnect(connectionId); }
    if (this.peer && now - this.lastPing >= 1000) { this.lastPing = now; this.send('PING', { sent: now }); }
    if (this.peer && now - this.lastReceive > 3500) { const peer = this.peer; this.disconnected(peer); this.disconnect(peer); }
    if (this.view.phase === 'joining' && now > this.preparationDeadline && !this.view.isHost) { this.view.phase = 'closed'; this.view.error = '加入超时，请检查地址、防火墙与网络隔离'; this.changed(); }
    if (this.view.phase === 'preparing' && now > this.preparationDeadline) {
      if (this.view.isHost) this.toLobby(); else { this.view.phase = 'closed'; this.view.error = '房主开局未完成，请重新加入'; this.changed(); }
    }
    if (this.view.phase === 'reconnecting') {
      if (this.recoveryDeadline && now >= this.recoveryDeadline) this.interrupt('重连超时，本局中断，不计胜负');
      else if (!this.view.isHost && !this.peer && this.foreground && now >= this.retryAt) void this.connect().catch(() => {});
    }
    if (this.view.isHost && this.view.phase === 'paused' && now >= this.pauseDeadline) {
      if (this.foreground && this.peerForeground && this.peer) this.countdown(); else this.interrupt('暂停结束，但玩家未返回');
    }
    if (this.view.phase === 'countdown') {
      this.view.countdown = Math.max(0, Math.ceil((this.startAt - now) / 1000));
      if (now >= this.startAt && this.foreground) { this.view.phase = 'playing'; this.lastTick = now; this.lastPublish = now; this.view.notice = ''; }
      this.changed();
    } else if (this.view.phase === 'playing' && this.view.snapshot) {
      if (delta > 1500 || !this.foreground) { this.freeze('游戏暂时挂起，等待双方恢复', true); return; }
      if (this.view.isHost) {
        const previous = this.view.snapshot;
        this.activeMs += delta; this.view.snapshot = advanceMatch(previous, this.activeMs);
        const boardChanged = previous.playerIds.some(p => previous.players[p].boardRevision !== this.view.snapshot!.players[p].boardRevision);
        if (boardChanged || now - this.lastPublish >= 1000 || this.view.snapshot.status === 'finished') this.publishSnapshot();
        this.checkFinished();
      }
      this.changed();
    }
    if (this.view.phase === 'browsing') {
      const before = this.view.rooms.length;
      this.view.rooms = this.view.rooms.filter(r => now - (this.roomSeen.get(`${r.metadata.roomId}:${r.address}:${r.port}`) ?? 0) < 6000);
      if (before !== this.view.rooms.length) this.changed();
    }
  }
  displayElapsed(): number {
    if (!this.view.snapshot) return 0;
    const extra = !this.view.isHost && this.view.phase === 'playing' ? Math.min(1200, Math.max(0, this.now() - this.lastPublish)) : 0;
    return Math.min(this.view.snapshot.durationMs, this.view.snapshot.elapsedMs + extra);
  }
}
function rejectionMessage(reason: unknown): string {
  const messages: Record<string, string> = { STALE_STATE: '棋盘已下移，请重新瞄准', COOLDOWN: '正在完成上一发',
    INVALID_LANDING: '这个角度没有合法落点', PLAYER_SEALED: '已触底，观看对方完成本局', MATCH_FINISHED: '本局已结束' };
  return messages[String(reason)] ?? '发射未确认，请重新瞄准';
}
