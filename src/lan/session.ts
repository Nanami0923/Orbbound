import { advanceWithEvents, applyShot, createMatch, finishMatch, forfeitPlayersMatch } from './authority';
import { applyBattleBatch } from './battle';
import { isPresentationEvent, partitionPresentationEvents, type PresentationEvent } from './presentation';
import { isMatchSnapshot, LAN_CONTENT_HASH, LAN_PROTOCOL_VERSION, LAN_RULES_HASH, PAUSE_RULES, type MatchSnapshot, type BattleBatchOutcome } from './protocol';
import { PresentationClock } from './presentation-clock';
import { lanPlatform, parseAddress, type DiscoveredRoom, type HostInfo, type LanEvent, type LanTransport, type DiscoveryStatus } from './transport';
import { recentLanAddresses, rememberLanAddress } from '../storage/lan-history';

export type SessionPhase = 'idle' | 'browsing' | 'joining' | 'lobby' | 'preparing' | 'countdown' | 'playing' | 'paused' | 'reconnecting' | 'finished' | 'closed';
export interface RoomConfig { mode?: 'score' | 'battle'; difficultyId: 'easy' | 'normal' | 'hard'; durationMs: 180000 | 300000; capacity?: 2 | 3 | 4 }
export interface SessionRoom extends DiscoveredRoom { endpoints: Array<{ address: string; port: number }>; lastSeenAt: number; seenScanId: string }
export interface DiscoveryView { scanId: string; status: DiscoveryStatus; paths: number; sent: number; received: number; errors: number; diagnostics: string[] }
export interface RoomPlayer { id: string; name: string; ready: boolean; connected: boolean; isHost?: boolean; platform?: string }
export type PauseReason = 'pause' | 'settings';
export interface PauseRequest { requestId: string; requesterId: string; reason: PauseReason; participantIds: string[]; votes: Record<string, boolean>; expiresAt: number; status: 'sending' | 'waiting'; epoch: number }
export interface PauseOutcome { requestId: string; requesterId: string; reason: PauseReason; status: 'approved' | 'rejected' | 'cancelled' | 'expired' | 'failed'; message: string }
export interface SessionView {
  phase: SessionPhase; isHost: boolean; selfId: string; roomId: string; roomName: string;
  config: RoomConfig; players: RoomPlayer[]; hostInfo?: HostInfo; snapshot?: MatchSnapshot;
  countdown: number; rtt: number; error: string; notice: string; pauseRequester?: string;
  pauseRequest?: PauseRequest; pauseOutcome?: PauseOutcome; pauseRemainingMs: number; pauseVoteRemainingMs: number;
  settingsOpen: string[]; forceCloseSettings: boolean; autoOpenSettings: boolean;
  resumeReady: string[]; pendingShot: boolean; rooms: SessionRoom[]; discovery: DiscoveryView; presentationEvents: PresentationEvent[];
}
type Packet = { v: number; type: string; roomId: string; matchId?: string; data: Record<string, unknown> };
interface Peer { playerId: string; connectionId?: string; token: string; foreground: boolean; lastReceive: number; lastPing: number; rtt: number; loaded: boolean; recoveryCount: number; recoveryDeadline: number }
interface Transfer { parts: Map<number, string>; count: number; bytes: number; receivedBytes: number; expiresAt: number }
const id = () => globalThis.crypto.randomUUID();
const cleanName = (value: unknown, max = 16) => typeof value === 'string' ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, max).join('') : '';
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(value);
const utf8 = (value: string) => new TextEncoder().encode(value).byteLength;
export const LAN_WIRE_TARGET_BYTES = 60 * 1024;
const MAX_TRANSFER_BYTES = 512 * 1024;
export function validRoomConfig(value: unknown): value is RoomConfig {
  const c = value as RoomConfig | null;
  return !!c && (c.mode === undefined || c.mode === 'score' || c.mode === 'battle') && ['easy', 'normal', 'hard'].includes(c.difficultyId) && [180000, 300000].includes(c.durationMs) && (c.capacity === undefined || [2, 3, 4].includes(c.capacity));
}
export class LanSession {
  readonly view: SessionView = { phase: 'idle', isHost: false, selfId: 'guest', roomId: '', roomName: '',
    config: { difficultyId: 'normal', durationMs: 180000, capacity: 4 }, players: [], countdown: 0, rtt: 0,
    error: '', notice: '', resumeReady: [], pendingShot: false, rooms: [], presentationEvents: [], settingsOpen: [],
    forceCloseSettings: false, autoOpenSettings: false, pauseRemainingMs: 0, pauseVoteRemainingMs: 0,
    discovery: { scanId: '', status: 'cancelled', paths: 0, sent: 0, received: 0, errors: 0, diagnostics: [] } };
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval>;
  /** Only guests have an upstream peer; a host owns one independent record per guest. */
  private peer?: string;
  private peers = new Map<string, Peer>();
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
  private recoveryDeadline = 0;
  private recoveryBegan = 0;
  private recoverySpent = 0;
  private hostRecoveryCount = 0;
  private retryAt = 0;
  private retrying = false;
  private preparationDeadline = 0;
  private pauseDeadline = 0;
  private pauseResumeRequester?: string;
  private pauseCooldown = new Map<string, number>();
  private pauseResults = new Map<string, PauseOutcome>();
  private pendingPause?: { requestId: string; reason: PauseReason; began: number; queried: boolean; confirmed?: boolean };
  private pendingForfeits = new Set<string>();
  private closingSettings = false;
  private closeSettingsDeadline = 0;
  private closeAcks = new Set<string>();
  private closureMissing = new Set<string>();
  private localSettingsOpen = false;
  private closed = false;
  private generation = 0;
  private commands = new Map<string, Record<string, unknown>>();
  private packetRates = new Map<string, { began: number; count: number }>();
  private transfers = new Map<string, Transfer>();
  private seenMatches = new Set<string>();
  private awaitingWelcome = false;
  private scanDeadline = 0;
  private discoveryRequested = false;
  private lastEventSeq = 0;
  private eventWatermarks = new Map<string, number>();
  private queuedShots = new Map<string, Record<string, unknown>>();
  private lastAdvertisement = '';
  private presentationClock = new PresentationClock();

  constructor(readonly transport: LanTransport, private now = () => performance.now()) {
    this.unsubscribe = transport.subscribe(event => this.event(event));
    this.timer = setInterval(() => this.tick(), 50);
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { this.presentationTime(); for (const listener of this.listeners) listener(); }
  private fail(error: unknown): void { this.view.error = error instanceof Error ? error.message : String(error); this.changed(); }
  private connectionFor(playerId: string): string | undefined { return this.peers.get(playerId)?.connectionId; }
  private playerFor(connectionId: string): Peer | undefined { return [...this.peers.values()].find(p => p.connectionId === connectionId); }
  private hostNow(): number { return this.now() + (this.view.isHost ? 0 : this.offset); }
  private requiredIds(): string[] {
    return this.view.players.filter(p => p.isHost || !this.view.snapshot || this.operating(p.id)).map(p => p.id);
  }
  private operating(playerId: string): boolean { const player = this.view.snapshot?.players[playerId]; return !!player && !player.sealed && !player.forfeited; }
  private allPresent(): boolean { return this.foreground && this.requiredIds().every(p => p === this.view.selfId || !!this.peers.get(p)?.connectionId && this.peers.get(p)?.foreground); }
  private envelope(type: string, data: Record<string, unknown>): Packet { return { v: LAN_PROTOCOL_VERSION, type, roomId: this.view.roomId, matchId: this.view.snapshot?.matchId, data }; }
  private send(type: string, data: Record<string, unknown> = {}, connectionId?: string): void {
    if (this.closed) return;
    const targets = connectionId ? [connectionId] : this.view.isHost ? [...this.peers.values()].flatMap(p => p.connectionId ? [p.connectionId] : []) : this.peer ? [this.peer] : [];
    const message = this.envelope(type, data), text = JSON.stringify(message), bytes = utf8(text);
    if (bytes > MAX_TRANSFER_BYTES) { this.fail('同步数据超出限制，请重新加入房间'); return; }
    const texts: string[] = [];
    if (bytes <= LAN_WIRE_TARGET_BYTES) texts.push(text);
    else {
      const transferId = id(), parts: string[] = [];
      for (let offset = 0; offset < text.length; offset += 12000) parts.push(text.slice(offset, offset + 12000));
      parts.forEach((body, index) => texts.push(JSON.stringify(this.envelope('CHUNK', { transferId, index, count: parts.length, totalBytes: bytes, body }))));
      if (texts.some(part => utf8(part) > LAN_WIRE_TARGET_BYTES)) { this.fail('同步分包超出限制'); return; }
    }
    for (const target of targets) for (const part of texts) void this.transport.request('send', { connectionId: target, message: part }).catch(() => { if (!this.closed) this.disconnected(target); });
  }
  private disconnect(connectionId: string): void { void this.transport.request('disconnect', { connectionId }).catch(() => {}); }
  private roomState(): Record<string, unknown> {
    return { roomId: this.view.roomId, roomName: this.view.roomName, config: this.view.config, players: this.view.players,
      phase: this.view.phase, pauseRequester: this.view.pauseRequester ?? null, pauseRequest: this.view.pauseRequest ?? null,
      pauseOutcome: this.view.pauseOutcome ?? null, resumeReady: this.view.resumeReady, settingsOpen: this.view.settingsOpen,
      forceCloseSettings: this.closingSettings, pauseDeadline: this.pauseDeadline, hostNow: this.now(), notice: this.view.notice };
  }
  private metadata() { return { roomId: this.view.roomId, protocolVersion: LAN_PROTOCOL_VERSION, rulesHash: LAN_RULES_HASH, contentHash: LAN_CONTENT_HASH,
    mode: this.view.config.mode ?? 'score', platform: lanPlatform(), players: this.view.players.length, capacity: this.view.config.capacity ?? 4, phase: this.view.phase }; }
  private publishRoom(): void {
    this.send('ROOM', this.roomState());
    if (this.view.isHost && this.view.hostInfo) {
      const metadata = this.metadata(), value = JSON.stringify(metadata);
      if (value !== this.lastAdvertisement) { this.lastAdvertisement = value; void this.transport.request('updateAdvertisement', { name: this.view.roomName, metadata }).catch(() => {}); }
    }
    this.changed();
  }
  private acceptEvents(events: PresentationEvent[]): void {
    const fresh = events.filter(event => event.eventSeq > (this.eventWatermarks.get(event.playerId) ?? 0));
    for (const event of fresh) this.eventWatermarks.set(event.playerId, Math.max(event.eventSeq, this.eventWatermarks.get(event.playerId) ?? 0));
    if (fresh.length) { this.lastEventSeq = Math.max(this.lastEventSeq, ...fresh.map(e => e.eventSeq)); this.view.presentationEvents = [...this.view.presentationEvents, ...fresh].sort((a, b) => a.eventSeq - b.eventSeq).slice(-128); }
  }
  private eventBaseline(): void { this.lastEventSeq = this.view.snapshot?.eventSeq ?? 0; this.view.presentationEvents = []; this.eventWatermarks.clear(); for (const playerId of this.view.snapshot?.playerIds ?? []) this.eventWatermarks.set(playerId, this.lastEventSeq); }
  private publishSnapshot(events: PresentationEvent[] = []): void {
    if (!this.view.snapshot) return;
    this.acceptEvents(events);
    const data = { snapshot: this.view.snapshot, serverSeq: ++this.serverSeq, epoch: this.epoch, events };
    if (utf8(JSON.stringify(this.envelope('STATE', data))) <= LAN_WIRE_TARGET_BYTES || !events.length) this.send('STATE', data);
    else {
      // State always arrives first; presentation is routed without starving later seats.
      this.send('STATE', { ...data, events: [] });
      for (const playerId of this.view.snapshot.playerIds) {
        const routed = events.filter(event => event.playerId === playerId), eventWatermark = Math.max(0, ...routed.map(event => event.eventSeq));
        const envelope = (part: PresentationEvent[]) => this.envelope('PRESENTATION', { serverSeq: this.serverSeq, epoch: this.epoch, playerId, eventWatermark, events: part });
        for (const part of partitionPresentationEvents(routed, envelope)) this.send('PRESENTATION', { serverSeq: this.serverSeq, epoch: this.epoch, playerId, eventWatermark, events: part });
      }
    }
    this.lastPublish = this.now(); this.changed();
  }
  private async reset(): Promise<void> {
    this.generation++; this.peer = undefined; this.peers.clear(); this.awaitingWelcome = false; this.candidates.clear(); this.commands.clear(); this.queuedShots.clear(); this.pendingForfeits.clear(); this.packetRates.clear(); this.transfers.clear();
    this.scanDeadline = 0; this.discoveryRequested = false; this.view.discovery = { scanId: '', status: 'cancelled', paths: 0, sent: 0, received: 0, errors: 0, diagnostics: [] };
    this.lastEventSeq = 0; this.eventWatermarks.clear(); this.view.presentationEvents = []; this.lastAdvertisement = '';
    this.view.pendingShot = false; this.pendingSeq = undefined; this.view.snapshot = undefined;
    this.view.resumeReady = []; this.view.pauseRequester = undefined; this.reconnectToken = '';
    this.view.pauseRequest = undefined; this.view.pauseOutcome = undefined; this.view.settingsOpen = []; this.localSettingsOpen = false; this.view.autoOpenSettings = false; this.view.forceCloseSettings = false;
    this.pendingPause = undefined; this.pauseResults.clear(); this.pauseCooldown.clear(); this.pauseResumeRequester = undefined; this.pauseDeadline = 0; this.closingSettings = false; this.closeAcks.clear(); this.closureMissing.clear(); this.presentationClock.reset();
    this.view.pauseRemainingMs = this.view.pauseVoteRemainingMs = 0;
    this.recoveryDeadline = 0; this.recoveryBegan = 0; this.recoverySpent = 0; this.hostRecoveryCount = 0;
    this.epoch = 0; this.lastServerSeq = -1; this.receivedEpoch = 0;
    this.bestRtt = Infinity; this.offset = 0; this.sequence = 0; this.serverSeq = 0;
    this.target = undefined; this.retrying = false; this.retryAt = 0; this.view.hostInfo = undefined; this.view.error = ''; this.view.notice = '';
    this.view.players = []; this.view.roomId = ''; this.view.rooms = [];
    await this.transport.request('dispose').catch(() => {});
  }
  async browse(options: { discover?: boolean } = {}): Promise<void> {
    const operation = this.reset(), generation = this.generation; await operation; if (generation !== this.generation || this.closed) return;
    this.discoveryRequested = options.discover !== false;
    this.view.isHost = false; this.view.selfId = 'guest'; this.view.phase = 'browsing'; this.changed();
    if (this.discoveryRequested) await this.refreshDiscovery();
  }
  async refreshDiscovery(extraAddresses: string[] = []): Promise<void> {
    if (this.view.phase !== 'browsing' || this.closed) return;
    this.discoveryRequested = true;
    if (!this.foreground) return;
    const scanId = id(); this.scanDeadline = this.now() + 8500; this.view.error = '';
    this.view.discovery = { scanId, status: 'scanning', paths: 0, sent: 0, received: 0, errors: 0, diagnostics: [] }; this.changed();
    const candidates = [...new Set([...extraAddresses, ...recentLanAddresses().map(r => r.address)])].filter(address => !!parseAddress(address)).slice(0, 8);
    try { await this.transport.request('discover', { scanId, recentAddresses: candidates }); }
    catch (error) { if (this.view.discovery.scanId === scanId && this.view.discovery.status === 'scanning' && this.view.phase === 'browsing') { this.view.discovery.status = 'failed'; this.scanDeadline = 0; this.fail(error); } }
  }
  async stopDiscovery(): Promise<void> {
    this.scanDeadline = 0; this.view.discovery.status = 'cancelled'; this.changed();
    await this.transport.request('stopDiscovery').catch(() => {});
  }
  async host(name: string, roomName: string, config: RoomConfig): Promise<void> {
    if (!validRoomConfig(config)) throw new Error('房间设置无效');
    const operation = this.reset(), generation = this.generation; await operation; if (generation !== this.generation || this.closed) return;
    this.nickname = cleanName(name) || '玩家'; this.view.isHost = true; this.view.selfId = 'host';
    this.view.roomId = id(); this.view.roomName = cleanName(roomName, 24) || `${this.nickname}的房间`;
    this.view.config = { ...config, capacity: config.capacity ?? 4 }; this.view.players = [{ id: this.view.selfId, name: this.nickname, ready: false, connected: true, isHost: true, platform: lanPlatform() }];
    this.view.phase = 'joining'; this.changed();
    try {
      const hostInfo = await this.transport.request<HostInfo>('startHost', { name: this.view.roomName, metadata: this.metadata() });
      if (generation !== this.generation || this.closed) return;
      this.view.hostInfo = hostInfo; this.view.phase = 'lobby'; this.publishRoom();
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
        name: this.nickname, token: this.reconnectToken, foreground: this.foreground, platform: lanPlatform(), appVersion: import.meta.env.VITE_APP_VERSION });
    } finally { if (generation === this.generation) { this.retrying = false; this.retryAt = this.now() + 1500; } }
  }
  setConfig(config: RoomConfig): void {
    if (!this.view.isHost || this.view.phase !== 'lobby' || !validRoomConfig(config)) return;
    if ((config.capacity ?? 4) < this.view.players.length) { this.view.notice = '人数超过新容量，请先移除多余玩家'; this.changed(); return; }
    this.view.config = { ...config, capacity: config.capacity ?? 4 }; this.view.players.forEach(player => { player.ready = false; }); this.publishRoom();
  }
  ready(): void {
    if (this.view.phase !== 'lobby') return;
    if (!this.view.isHost) { this.send('READY', { ready: !this.view.players.find(p => p.id === this.view.selfId)?.ready }); return; }
    const player = this.view.players.find(p => p.id === this.view.selfId)!; player.ready = !player.ready; this.publishRoom();
  }
  start(): void {
    if (!this.view.isHost || this.view.phase !== 'lobby' || this.view.players.length < 2 || this.view.players.length > (this.view.config.capacity ?? 4) || this.view.players.some(p => !p.ready || !p.connected) || !this.allPresent()) return;
    if (this.view.settingsOpen.length) { this.view.notice = '请先关闭所有选手的设置'; this.publishRoom(); return; }
    this.activeMs = 0; this.sequence = 0; this.commands.clear(); this.queuedShots.clear(); this.lastEventSeq = 0; this.view.presentationEvents = [];
    this.pauseResults.clear(); this.pauseCooldown.clear(); this.pauseResumeRequester = undefined; this.pauseDeadline = 0; this.view.pauseOutcome = undefined; this.view.pauseRequest = undefined; this.view.settingsOpen = []; this.presentationClock.reset();
    this.hostRecoveryCount = 0; this.recoverySpent = 0; this.recoveryDeadline = 0; this.recoveryBegan = 0;
    for (const peer of this.peers.values()) { peer.loaded = false; peer.recoveryCount = 0; peer.recoveryDeadline = 0; }
    this.epoch++;
    const { mode, difficultyId, durationMs } = this.view.config;
    this.view.snapshot = createMatch({ mode, difficultyId, durationMs, seed: crypto.getRandomValues(new Uint32Array(1))[0], matchId: id(), playerIds: this.view.players.map(p => p.id) }, 0);
    this.eventBaseline();
    this.view.phase = 'preparing'; this.preparationDeadline = this.now() + 10000; this.view.notice = '等待所有选手棋盘就绪';
    this.send('PREPARE', { snapshot: this.view.snapshot, epoch: this.epoch }); this.publishRoom();
  }
  shoot(angleMilliDeg: number): void {
    const snapshot = this.view.snapshot;
    if (this.view.phase !== 'playing' || !snapshot || this.view.pendingShot || !this.foreground || this.view.settingsOpen.includes(this.view.selfId)) return;
    const player = snapshot.players[this.view.selfId]; if (!player || player.sealed || player.forfeited) return;
    const seq = ++this.sequence, data = { seq, boardRevision: player.boardRevision, angleMilliDeg, epoch: this.view.isHost ? this.epoch : this.receivedEpoch };
    if (this.view.isHost) { if (snapshot.mode === 'battle') { this.pendingSeq = seq; this.view.pendingShot = true; } this.acceptShot(this.view.selfId, data); }
    else { this.pendingSeq = seq; this.view.pendingShot = true; this.send('SHOT', data); this.changed(); }
  }
  private acceptShot(playerId: string, data: Record<string, unknown>): void {
    if (this.view.phase !== 'playing' || !this.view.snapshot || data.epoch !== this.epoch) return;
    if (this.pendingForfeits.has(playerId)) { this.completeCommand(playerId, { seq: data.seq, accepted: false, reason: 'PLAYER_SEALED', epoch: this.epoch }); return; }
    const now = this.now(), delta = Math.max(0, now - this.lastTick);
    if (delta > 1500 || !this.allPresent()) { this.beginRecovery('等待选手返回对局', this.requiredIds().filter(p => p === this.view.selfId ? !this.foreground : !this.peers.get(p)?.foreground)); return; }
    const key = `${playerId}:${String(data.seq)}`, cached = this.commands.get(key);
    if (cached) { const connection = this.connectionFor(playerId); if (playerId !== this.view.selfId && connection) this.send('COMMAND', cached, connection); return; }
    if (this.view.snapshot.mode === 'battle') {
      if (!this.queuedShots.has(playerId)) this.queuedShots.set(playerId, { ...data, playerId });
      else if (this.queuedShots.get(playerId)!.seq !== data.seq) this.completeCommand(playerId, { seq: data.seq, accepted: false, reason: 'COOLDOWN', epoch: this.epoch });
      return;
    }
    this.activeMs += delta; this.lastTick = now;
    const response = applyShot(this.view.snapshot, { playerId, seq: data.seq as number, boardRevision: data.boardRevision as number, angleMilliDeg: data.angleMilliDeg as number }, this.activeMs);
    this.view.snapshot = response.snapshot;
    this.completeCommand(playerId, { seq: data.seq, accepted: response.accepted, reason: response.reason ?? '', epoch: this.epoch });
    this.publishSnapshot(response.presentationEvents); this.checkPauseMembers(); this.checkFinished();
  }
  private completeCommand(playerId: string, result: Record<string, unknown>): void {
    this.commands.set(`${playerId}:${String(result.seq)}`, result); if (this.commands.size > 512) this.commands.delete(this.commands.keys().next().value!);
    if (playerId !== this.view.selfId) { const connection = this.connectionFor(playerId); if (connection) this.send('COMMAND', result, connection); }
    else { this.view.pendingShot = false; this.pendingSeq = undefined; if (result.accepted !== true) this.view.notice = rejectionMessage(result.reason); }
  }
  requestPause(reason: PauseReason = 'pause'): void {
    if (this.view.phase !== 'playing' || !this.operating(this.view.selfId)) { this.view.notice = '当前不能申请暂停'; this.changed(); return; }
    if (this.view.pauseRequest) { this.view.notice = '已有暂停申请，请先处理'; this.changed(); return; }
    const remaining = (this.pauseCooldown.get(this.view.selfId) ?? 0) - this.now();
    if (remaining > 0) { this.view.notice = `请等待 ${Math.ceil(remaining / 1000)} 秒后再次申请`; this.changed(); return; }
    const requestId = id(); this.pendingPause = { requestId, reason, began: this.now(), queried: false };
    this.view.pauseOutcome = undefined; this.view.notice = reason === 'settings' ? '正在申请暂停以调整设置' : '正在申请暂停';
    this.view.pauseRequest = { requestId, requesterId: this.view.selfId, reason, participantIds: [], votes: {}, expiresAt: this.hostNow() + PAUSE_RULES.voteMs, status: 'sending', epoch: this.view.isHost ? this.epoch : this.receivedEpoch };
    this.view.pauseRequester = this.view.selfId; this.changed();
    if (this.view.isHost) this.askPause(this.view.selfId, requestId, reason, this.epoch); else this.send('PAUSE_REQUEST', { requestId, reason, epoch: this.receivedEpoch });
  }
  private askPause(playerId: string, requestId: string, reason: PauseReason, epoch: unknown): void {
    const existing = this.pauseResults.get(requestId);
    if (existing) { if (existing.requesterId === playerId) this.send('PAUSE_OUTCOME', { outcome: existing }, this.connectionFor(playerId)); return; }
    const pending = this.view.pauseRequest;
    if (pending?.status === 'waiting') {
      if (pending.requestId === requestId && pending.requesterId === playerId) this.publishRoom();
      else this.reportPause({ requestId, requesterId: playerId, reason, status: 'rejected', message: '已有暂停申请，请先处理' }, false);
      return;
    }
    let message = '';
    if (this.view.phase !== 'playing' || epoch !== this.epoch || !this.operating(playerId)) message = '当前不能申请暂停';
    else if ((this.pauseCooldown.get(playerId) ?? 0) > this.now()) message = `请等待 ${Math.ceil((this.pauseCooldown.get(playerId)! - this.now()) / 1000)} 秒后再次申请`;
    if (message) { this.reportPause({ requestId, requesterId: playerId, reason, status: 'rejected', message }); return; }
    const participantIds = this.view.snapshot!.playerIds.filter(p => this.operating(p));
    this.view.pauseRequest = { requestId, requesterId: playerId, reason, participantIds, votes: { [playerId]: true }, expiresAt: this.now() + PAUSE_RULES.voteMs, status: 'waiting', epoch: this.epoch };
    this.view.pauseRequester = playerId; this.pendingPause = undefined; this.view.notice = '暂停申请已送达，等待其他选手同意'; this.publishRoom();
    this.approveIfUnanimous();
  }
  decidePause(accepted: boolean, requestId = this.view.pauseRequest?.requestId): void {
    const request = this.view.pauseRequest;
    if (!request || request.requestId !== requestId || request.status !== 'waiting' || !request.participantIds.includes(this.view.selfId) || request.requesterId === this.view.selfId) return;
    if (!this.view.isHost) this.send('PAUSE_DECISION', { requestId, accepted, epoch: this.receivedEpoch }); else this.vote(this.view.selfId, requestId!, accepted, this.epoch);
  }
  private vote(playerId: string, requestId: string, accepted: boolean, epoch: unknown): void {
    const request = this.view.pauseRequest;
    if (this.view.phase !== 'playing' || !request || request.requestId !== requestId || request.epoch !== epoch || this.pauseResults.has(requestId) || !request.participantIds.includes(playerId) || request.votes[playerId] !== undefined) return;
    if (this.now() >= request.expiresAt) { this.finishPauseRequest('expired', '暂停申请已超时'); return; }
    request.votes[playerId] = accepted;
    if (!accepted) this.finishPauseRequest('rejected', '有选手选择继续比赛'); else { this.publishRoom(); this.approveIfUnanimous(); }
  }
  cancelPause(): void {
    const request = this.view.pauseRequest; if (!request || request.requesterId !== this.view.selfId) return;
    this.pendingPause = undefined; this.view.autoOpenSettings = false;
    if (this.view.isHost) this.finishPauseRequest('cancelled', '申请人取消了暂停');
    else { this.send('PAUSE_CANCEL', { requestId: request.requestId, epoch: this.receivedEpoch }); this.view.notice = '正在取消暂停申请'; this.changed(); }
  }
  private reportPause(outcome: PauseOutcome, clear = true, startCooldown = false): void {
    if (this.pauseResults.has(outcome.requestId)) return;
    // Keep terminal request identities for the whole match: old retries must not become a fresh vote.
    this.pauseResults.set(outcome.requestId, outcome);
    if (clear && this.view.pauseRequest?.requestId === outcome.requestId) { this.view.pauseRequest = undefined; this.view.pauseRequester = undefined; }
    this.view.pauseOutcome = outcome; this.view.notice = outcome.message;
    if (startCooldown && outcome.status !== 'approved') this.pauseCooldown.set(outcome.requesterId, this.now() + PAUSE_RULES.cooldownMs);
    if (this.pendingPause?.requestId === outcome.requestId) this.pendingPause = undefined;
    this.send('PAUSE_OUTCOME', { outcome }); this.publishRoom();
  }
  private finishPauseRequest(status: PauseOutcome['status'], message: string): void {
    const request = this.view.pauseRequest; if (!request) return;
    this.reportPause({ requestId: request.requestId, requesterId: request.requesterId, reason: request.reason, status, message }, true, true);
  }
  private approveIfUnanimous(): void {
    const request = this.view.pauseRequest;
    if (!request || !request.participantIds.every(p => request.votes[p] === true)) return;
    // All control messages run between 50 ms rule batches; uncommitted shots are cancelled at this boundary.
    this.pauseResumeRequester = request.requesterId; this.pauseDeadline = this.now() + PAUSE_RULES.maxPauseMs;
    this.view.pauseRemainingMs = PAUSE_RULES.maxPauseMs;
    this.view.autoOpenSettings = request.reason === 'settings' && request.requesterId === this.view.selfId;
    this.freeze('比赛已暂停，可以调整本机设置', false);
    this.reportPause({ requestId: request.requestId, requesterId: request.requesterId, reason: request.reason, status: 'approved', message: '全员同意，比赛已暂停' });
  }
  private checkPauseMembers(): void {
    const request = this.view.pauseRequest; if (!this.view.isHost || !request || request.status !== 'waiting') return;
    const active = this.view.snapshot!.playerIds.filter(p => this.operating(p));
    if (active.length !== request.participantIds.length || active.some(p => !request.participantIds.includes(p))) this.finishPauseRequest('cancelled', '参赛状态已变化，请重新申请暂停');
  }
  settingsChanged(open: boolean): void {
    this.view.autoOpenSettings = false;
    if (open && (!['paused', 'finished', 'lobby'].includes(this.view.phase) || this.view.forceCloseSettings)) return;
    this.localSettingsOpen = open;
    if (!open) this.view.forceCloseSettings = false;
    this.view.settingsOpen = this.view.settingsOpen.filter(p => p !== this.view.selfId); if (open) this.view.settingsOpen.push(this.view.selfId);
    if (open) this.view.resumeReady = this.view.resumeReady.filter(p => p !== this.view.selfId);
    if (this.view.isHost) { if (!open) { this.closureMissing.delete(this.view.selfId); if (this.closingSettings) this.closeAcks.add(this.view.selfId); } this.tryResume(); this.publishRoom(); }
    else { this.send('SETTINGS', { open, epoch: this.receivedEpoch, closing: this.view.forceCloseSettings }); if (!open) this.view.forceCloseSettings = false; this.changed(); }
  }
  resume(): void {
    if (!['paused', 'reconnecting'].includes(this.view.phase) || !this.foreground || this.view.settingsOpen.includes(this.view.selfId)) return;
    if (!this.view.isHost) { this.send('RESUME_READY', { epoch: this.receivedEpoch }); return; }
    if (!this.view.resumeReady.includes(this.view.selfId)) this.view.resumeReady.push(this.view.selfId);
    this.tryResume(); this.publishRoom();
  }
  private tryResume(): void {
    if (!this.view.isHost || !['paused', 'reconnecting'].includes(this.view.phase) || !this.allPresent()) return;
    const required = this.requiredIds();
    if (this.closingSettings) {
      if (required.every(p => this.closeAcks.has(p)) && required.every(p => !this.view.settingsOpen.includes(p))) this.countdown();
    } else if (required.every(p => this.view.resumeReady.includes(p)) && required.every(p => !this.view.settingsOpen.includes(p))) this.beginCloseSettings();
  }
  private beginCloseSettings(): void {
    if (this.closingSettings) return;
    this.closingSettings = true; this.closeSettingsDeadline = this.now() + 3000; this.closeAcks.clear();
    this.view.forceCloseSettings = true;
    if (!this.view.settingsOpen.includes(this.view.selfId) && this.foreground) this.closeAcks.add(this.view.selfId);
    this.send('CLOSE_SETTINGS', { snapshot: this.view.snapshot, epoch: this.epoch }); this.publishRoom(); this.tryResume();
  }
  private countdown(): void {
    if (!this.view.isHost || !this.allPresent()) return;
    if (this.recoveryBegan) this.recoverySpent += Math.max(0, this.now() - this.recoveryBegan);
    this.recoveryBegan = 0; this.recoveryDeadline = 0;
    for (const peer of this.peers.values()) peer.recoveryDeadline = 0;
    this.pauseDeadline = 0; this.view.pauseRemainingMs = 0; this.view.resumeReady = [];
    this.closingSettings = false; this.view.forceCloseSettings = false; this.view.settingsOpen = []; this.view.autoOpenSettings = false;
    this.closureMissing.clear();
    this.view.pendingShot = false; this.pendingSeq = undefined; this.view.phase = 'countdown';
    this.queuedShots.clear(); this.eventBaseline(); this.startAt = this.now() + 3000; this.view.countdown = 3; this.view.notice = ''; this.epoch++;
    this.send('START', { startAt: this.startAt, snapshot: this.view.snapshot, epoch: this.epoch }); this.publishRoom();
  }
  private freeze(reason: string, recovery: boolean): void {
    if (!this.view.snapshot || this.view.snapshot.status === 'finished') return;
    if (this.view.isHost) {
      for (const [playerId, command] of this.queuedShots) this.completeCommand(playerId, { seq: command.seq, accepted: false, reason: 'PAUSED', epoch: this.epoch });
      this.epoch++;
    }
    this.view.phase = recovery ? 'reconnecting' : 'paused'; this.view.notice = reason;
    this.view.resumeReady = []; this.view.pendingShot = false; this.pendingSeq = undefined; this.queuedShots.clear(); this.eventBaseline();
    this.closingSettings = false; this.view.forceCloseSettings = false; this.closeAcks.clear();
    if (this.view.isHost) { this.send('FREEZE', { snapshot: this.view.snapshot, recovery, reason, epoch: this.epoch, pauseDeadline: this.pauseDeadline }); this.publishRoom(); }
    this.changed();
  }
  private beginRecovery(reason: string, affected: string[]): void {
    if (!this.view.snapshot || this.view.snapshot.status !== 'playing') return;
    if (!this.view.isHost) { this.recoveryDeadline ||= this.now() + 20000; this.freeze(reason, true); return; }
    if (this.view.pauseRequest) this.finishPauseRequest('cancelled', '连接或前台状态变化，暂停申请已取消');
    const now = this.now();
    if (!this.recoveryBegan) this.recoveryBegan = now;
    if (!this.recoveryDeadline) this.recoveryDeadline = now + Math.min(20000, Math.max(0, 60000 - this.recoverySpent - (now - this.recoveryBegan)));
    const forfeits: string[] = [];
    for (const playerId of affected) {
      if (playerId === this.view.selfId) { if (this.view.phase !== 'reconnecting') this.hostRecoveryCount++; if (this.hostRecoveryCount > 3) { this.interrupt('房主恢复次数已用尽'); return; } }
      else {
        const peer = this.peers.get(playerId); if (!peer || !this.operating(playerId)) continue;
        if (!peer.recoveryDeadline) { peer.recoveryCount++; peer.recoveryDeadline = this.recoveryDeadline; }
        if (peer.recoveryCount > 3) forfeits.push(playerId);
      }
    }
    if (forfeits.length) this.applyForfeits(forfeits);
    if (this.view.snapshot.status !== 'playing') return;
    this.freeze(reason, true);
    if (this.recoverySpent >= 60000) this.recoveryTimeout();
  }
  foregroundChanged(active: boolean): void {
    if (this.foreground === active) return; this.foreground = active;
    if (this.view.phase === 'browsing') { if (active) { if (this.discoveryRequested) void this.refreshDiscovery(); } else void this.stopDiscovery(); }
    if (!active) {
      this.send('BACKGROUND');
      if (['playing', 'countdown', 'paused', 'preparing'].includes(this.view.phase) && (this.view.isHost || this.operating(this.view.selfId))) this.beginRecovery('玩家离开前台，等待恢复 · 最多 20 秒', [this.view.selfId]);
    } else { this.lastTick = this.now(); this.send('FOREGROUND'); this.changed(); }
  }
  rematch(): void {
    if (this.view.phase !== 'finished') return;
    if (!this.view.isHost) { this.send('REMATCH'); return; }
    this.toLobby();
  }
  private toLobby(): void {
    this.view.snapshot = undefined; this.view.phase = 'lobby'; this.view.notice = '新一局使用新开局，请所有选手重新准备';
    this.view.players = this.view.players.filter(p => p.isHost || p.connected);
    for (const [playerId, peer] of this.peers) if (!peer.connectionId) this.peers.delete(playerId);
    this.view.players.forEach(p => { p.ready = false; }); this.view.pauseRequest = undefined; this.view.pauseRequester = undefined; this.view.settingsOpen = []; this.view.forceCloseSettings = false;
    this.send('LOBBY', this.roomState()); this.publishRoom();
  }
  kick(playerId = this.view.players.find(p => !p.isHost)?.id): void {
    if (!this.view.isHost || this.view.phase !== 'lobby' || !playerId) return;
    const connection = this.connectionFor(playerId); if (!connection) return;
    this.send('CLOSED', { reason: '房主已移除当前玩家' }, connection); this.disconnected(connection); this.disconnect(connection);
  }
  forfeit(): void {
    if (!this.operating(this.view.selfId) || this.view.snapshot?.status !== 'playing') return;
    if (this.view.isHost) this.pendingForfeits.add(this.view.selfId); else this.send('FORFEIT', { epoch: this.receivedEpoch });
  }
  private applyForfeits(playerIds: string[]): void {
    if (!this.view.snapshot || this.view.snapshot.status !== 'playing') return;
    const controlTime = this.activeMs + (this.view.phase === 'playing' ? Math.min(1500, Math.max(0, this.now() - this.lastTick)) : 0);
    this.view.snapshot = forfeitPlayersMatch(this.view.snapshot, playerIds, controlTime); this.activeMs = this.view.snapshot.elapsedMs;
    for (const playerId of playerIds) {
      const queued = this.queuedShots.get(playerId);
      if (queued) this.completeCommand(playerId, { seq: queued.seq, accepted: false, reason: 'PLAYER_SEALED', epoch: this.epoch });
      if (playerId === this.view.selfId) { this.view.pendingShot = false; this.pendingSeq = undefined; }
      this.queuedShots.delete(playerId); this.view.resumeReady = this.view.resumeReady.filter(p => p !== playerId);
    }
    this.checkPauseMembers(); this.publishSnapshot(); this.checkFinished();
  }
  private checkFinished(): void {
    if (this.view.snapshot?.status !== 'finished' || this.view.phase === 'finished') return;
    if (this.view.isHost && this.view.pauseRequest) this.finishPauseRequest('cancelled', '本局已结束');
    this.view.phase = 'finished'; this.view.pendingShot = false; this.view.pauseRequest = undefined; this.view.pauseRequester = undefined; this.pendingPause = undefined; this.view.autoOpenSettings = false;
    this.recoveryDeadline = 0; this.recoveryBegan = 0; this.pauseDeadline = 0; this.closingSettings = false; this.view.forceCloseSettings = this.view.settingsOpen.includes(this.view.selfId);
    if (this.view.isHost) { this.publishSnapshot(); this.publishRoom(); } this.changed();
  }
  private interrupt(reason: string): void {
    this.view.notice = reason;
    if (this.view.snapshot && this.view.snapshot.status !== 'finished') { this.view.snapshot = finishMatch(this.view.snapshot, 'interrupted', this.activeMs); this.checkFinished(); }
    else { this.view.phase = 'closed'; this.changed(); }
    this.recoveryDeadline = 0;
  }
  async leave(): Promise<void> {
    if (this.view.snapshot?.status === 'playing') {
      if (this.view.isHost) { this.interrupt('房主已关闭房间，本局中断'); this.send('CLOSED', { reason: '房主已关闭房间', snapshot: this.view.snapshot }); }
      else this.send('LEAVE');
      await new Promise(resolve => setTimeout(resolve, 100));
    } else this.send(this.view.isHost ? 'CLOSED' : 'LEAVE', { reason: '玩家已离开房间' });
    await this.reset(); this.view.phase = 'idle'; this.changed();
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    try { await this.leave(); }
    finally { this.closed = true; this.unsubscribe(); this.listeners.clear(); await this.transport.close(); }
  }
  private event(event: LanEvent): void {
    if (this.closed) return;
    if (event.event === 'background' || event.event === 'foreground') { this.foregroundChanged(event.event === 'foreground'); return; }
    if (event.event === 'advertisement-status' && this.view.isHost && this.view.hostInfo) {
      this.view.hostInfo.discoveryAvailable = event.discoveryAvailable === true;
      if (event.error) this.view.notice = `自动发现状态：${event.error}，仍可尝试地址加入`; this.changed(); return;
    }
    if (event.event === 'discovery-status' && this.view.phase === 'browsing' && event.scanId === this.view.discovery.scanId) {
      if (this.view.discovery.status !== 'scanning') return;
      if (['scanning', 'completed', 'cancelled', 'failed'].includes(event.status ?? '')) this.view.discovery.status = event.status!;
      for (const field of ['paths', 'sent', 'received', 'errors'] as const) if (Number.isSafeInteger(event[field]) && event[field]! >= 0) this.view.discovery[field] = event[field]!;
      if (Array.isArray(event.diagnostics)) this.view.discovery.diagnostics = event.diagnostics.filter(x => typeof x === 'string').slice(-200).map(x => x.slice(0, 300));
      if (event.error && event.status === 'failed') this.view.error = event.error.slice(0, 300);
      if (event.status !== 'scanning') this.scanDeadline = 0;
      this.changed(); return;
    }
    if (event.event === 'discovered' && this.view.phase === 'browsing' && event.scanId === this.view.discovery.scanId && this.view.discovery.status === 'scanning' && event.room) {
      const room = event.room;
      if (typeof room.name !== 'string' || !Number.isInteger(room.port) || !parseAddress(`${room.address}:${room.port}`)
        || !room.metadata || typeof room.metadata.roomId !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(room.metadata.roomId)) return;
      room.metadata = { roomId: room.metadata.roomId, protocolVersion: Number(room.metadata.protocolVersion),
        rulesHash: typeof room.metadata.rulesHash === 'string' ? room.metadata.rulesHash.slice(0, 64) : '',
        contentHash: typeof room.metadata.contentHash === 'string' ? room.metadata.contentHash.slice(0, 64) : undefined,
        mode: room.metadata.mode === 'battle' ? 'battle' : 'score', platform: cleanName(room.metadata.platform, 24) || undefined,
        players: Number.isInteger(room.metadata.players) && room.metadata.players! >= 0 && room.metadata.players! <= 4 ? room.metadata.players : undefined,
        capacity: [2, 3, 4].includes(room.metadata.capacity ?? 0) ? room.metadata.capacity : undefined,
        phase: typeof room.metadata.phase === 'string' ? cleanName(room.metadata.phase, 24) : undefined };
      const existing = this.view.rooms.find(r => r.metadata.roomId === room.metadata.roomId);
      const endpoint = { address: room.address, port: room.port };
      if (existing) { existing.name = cleanName(room.name, 24); existing.metadata = room.metadata; existing.lastSeenAt = this.now(); existing.seenScanId = event.scanId!;
        if (!existing.endpoints.some(e => e.address === room.address && e.port === room.port)) existing.endpoints = [...existing.endpoints, endpoint].slice(-8);
      } else this.view.rooms = [...this.view.rooms, { ...room, name: cleanName(room.name, 24), endpoints: [endpoint], lastSeenAt: this.now(), seenScanId: event.scanId! }].slice(-30);
      this.changed(); return;
    }
    if (event.event === 'error') { this.fail(event.error ?? '网络服务异常'); return; }
    if (!event.connectionId) return;
    if (event.event === 'connected' && this.view.isHost && !this.playerFor(event.connectionId) && !this.candidates.has(event.connectionId)) this.candidates.set(event.connectionId, this.now() + 5000);
    if (event.event === 'disconnected') { this.candidates.delete(event.connectionId); this.disconnected(event.connectionId); }
    if (event.event === 'message' && typeof event.message === 'string') this.receive(event.connectionId, event.message);
  }
  private disconnected(connectionId: string): void {
    this.packetRates.delete(connectionId);
    for (const key of this.transfers.keys()) if (key.startsWith(`${connectionId}:`)) this.transfers.delete(key);
    if (this.view.isHost) {
      const peer = this.playerFor(connectionId); if (!peer) return;
      peer.connectionId = undefined; const player = this.view.players.find(p => p.id === peer.playerId); if (player) player.connected = false;
      if (this.view.phase === 'lobby') { this.view.players = this.view.players.filter(p => p.id !== peer.playerId); this.peers.delete(peer.playerId); this.publishRoom(); }
      else if (['playing', 'paused', 'countdown', 'preparing', 'reconnecting'].includes(this.view.phase) && this.operating(peer.playerId) && !this.pendingForfeits.has(peer.playerId)) this.beginRecovery('连接中断，等待选手恢复 · 最多 20 秒', [peer.playerId]);
      else this.publishRoom();
      return;
    }
    if (connectionId !== this.peer) return;
    this.peer = undefined; this.awaitingWelcome = false; this.view.pendingShot = false; this.pendingSeq = undefined;
    const host = this.view.players.find(p => p.isHost); if (host) host.connected = false;
    if (['playing', 'paused', 'countdown', 'preparing', 'reconnecting'].includes(this.view.phase)) this.beginRecovery('与房主连接中断，等待恢复 · 最多 20 秒', [host?.id ?? 'host']);
    else if (this.view.phase !== 'finished') { this.view.phase = 'closed'; this.view.notice = '与房主的连接已关闭，请重新加入'; this.changed(); }
    else this.changed();
  }
  private receive(connectionId: string, text: string, reassembled = false): void {
    if (utf8(text) > (reassembled ? MAX_TRANSFER_BYTES : 65536)) { this.disconnect(connectionId); return; }
    let packet: Packet; try { packet = JSON.parse(text); } catch { this.disconnect(connectionId); return; }
    if (!packet || packet.v !== LAN_PROTOCOL_VERSION || typeof packet.type !== 'string' || !packet.data || typeof packet.data !== 'object' || Array.isArray(packet.data)) { this.disconnect(connectionId); return; }
    const data = packet.data;
    if (this.view.isHost && packet.type === 'HELLO') { this.hello(connectionId, data, packet.roomId); return; }
    const remote = this.view.isHost ? this.playerFor(connectionId) : undefined;
    if (this.view.isHost ? !remote : connectionId !== this.peer) return;
    if (!reassembled) {
      let rate = this.packetRates.get(connectionId); if (!rate || this.now() - rate.began >= 1000) { rate = { began: this.now(), count: 0 }; this.packetRates.set(connectionId, rate); }
      if (++rate.count > 160) { this.disconnect(connectionId); return; }
    }
    if (remote) remote.lastReceive = this.now(); else this.lastReceive = this.now();
    if (packet.type === 'CHUNK') { if (reassembled) { this.disconnect(connectionId); return; } this.receiveChunk(connectionId, data); return; }
    if (packet.type !== 'WELCOME' && packet.type !== 'REJECT' && packet.roomId !== this.view.roomId) return;
    if (packet.type === 'PING') { this.send('PONG', { sent: data.sent, now: this.now() }, connectionId); return; }
    if (packet.type === 'PONG' && typeof data.sent === 'number' && Number.isFinite(data.sent) && typeof data.now === 'number' && Number.isFinite(data.now)) {
      const rtt = Math.max(0, this.now() - data.sent); if (remote) remote.rtt = Math.round(rtt); this.view.rtt = Math.round(rtt);
      if (!this.view.isHost && rtt <= this.bestRtt + 10) { this.bestRtt = Math.min(rtt, this.bestRtt); this.offset = data.now - (data.sent + this.now()) / 2; } return;
    }
    if (this.view.isHost) this.hostPacket(remote!.playerId, packet.type, data, packet.matchId);
    else {
      if (['START', 'COMMAND', 'STATE', 'PRESENTATION', 'FREEZE', 'CLOSE_SETTINGS', 'PAUSE_OUTCOME'].includes(packet.type) && packet.matchId !== this.view.snapshot?.matchId) return;
      if (packet.type === 'CLOSED' && this.view.snapshot && packet.matchId !== this.view.snapshot.matchId) return;
      this.guestPacket(packet.type, data);
    }
  }
  private receiveChunk(connectionId: string, data: Record<string, unknown>): void {
    if (!validId(data.transferId) || !Number.isInteger(data.count) || Number(data.count) < 1 || Number(data.count) > 96 || !Number.isInteger(data.index) || Number(data.index) < 0 || Number(data.index) >= Number(data.count) || !Number.isInteger(data.totalBytes) || Number(data.totalBytes) > MAX_TRANSFER_BYTES || Number(data.totalBytes) < 1 || typeof data.body !== 'string') { this.disconnect(connectionId); return; }
    const key = `${connectionId}:${data.transferId}`;
    let transfer = this.transfers.get(key);
    if (!transfer) {
      if ([...this.transfers.keys()].filter(k => k.startsWith(`${connectionId}:`)).length >= 4) { this.disconnect(connectionId); return; }
      transfer = { parts: new Map(), count: Number(data.count), bytes: Number(data.totalBytes), receivedBytes: 0, expiresAt: this.now() + 3000 }; this.transfers.set(key, transfer);
    }
    if (transfer.count !== data.count || transfer.bytes !== data.totalBytes) { this.disconnect(connectionId); return; }
    const index = Number(data.index), previous = transfer.parts.get(index);
    if (previous !== undefined && previous !== data.body) { this.disconnect(connectionId); return; }
    if (previous === undefined) { transfer.parts.set(index, data.body); transfer.receivedBytes += utf8(data.body); }
    if (transfer.receivedBytes > MAX_TRANSFER_BYTES + 192) { this.disconnect(connectionId); return; }
    if (transfer.parts.size === transfer.count) {
      this.transfers.delete(key); const text = Array.from({ length: transfer.count }, (_, i) => transfer!.parts.get(i)!).join('');
      if (utf8(text) !== transfer.bytes) { this.disconnect(connectionId); return; } this.receive(connectionId, text, true);
    }
  }
  private hello(connectionId: string, data: Record<string, unknown>, roomId: string): void {
    const reject = (reason: string) => { this.send('REJECT', { reason }, connectionId); setTimeout(() => this.disconnect(connectionId), 150); };
    if (data.protocolVersion !== LAN_PROTOCOL_VERSION || data.rulesHash !== LAN_RULES_HASH || data.contentHash !== LAN_CONTENT_HASH) { reject('版本不兼容，请所有选手更新到相同联机版本'); return; }
    if (roomId && roomId !== this.view.roomId) { reject('房间已失效，请重新查找'); return; }
    const attached = this.playerFor(connectionId);
    if (attached && data.token && data.token !== attached.token) { reject('恢复身份不匹配'); return; }
    const resumed = attached ?? (typeof data.token === 'string' && data.token ? [...this.peers.values()].find(p => p.token === data.token) : undefined);
    if (this.view.phase !== 'lobby' && !resumed) { reject('房间正在对局中，或恢复身份不匹配'); return; }
    if (!['lobby', 'playing', 'preparing', 'countdown', 'reconnecting', 'paused', 'finished'].includes(this.view.phase)) { reject('房间当前不可加入'); return; }
    if (resumed?.connectionId && resumed.connectionId !== connectionId) { reject('该恢复身份仍在线'); return; }
    if (!resumed && this.view.players.length >= (this.view.config.capacity ?? 4)) { reject('房间已满'); return; }
    if (!resumed && data.token) { reject('恢复身份不匹配'); return; }
    const playerId = resumed?.playerId ?? (this.view.players.some(p => p.id === 'guest') ? id() : 'guest');
    const peer: Peer = resumed ?? { playerId, token: id(), foreground: true, lastReceive: 0, lastPing: 0, rtt: 0, loaded: false, recoveryCount: 0, recoveryDeadline: 0 };
    peer.connectionId = connectionId; peer.foreground = data.foreground !== false; peer.lastReceive = this.now();
    this.peers.set(playerId, peer); this.candidates.delete(connectionId);
    let player = this.view.players.find(p => p.id === playerId);
    if (!player) { player = { id: playerId, name: cleanName(data.name) || '玩家', ready: false, connected: true, isHost: false, platform: cleanName(data.platform, 24) }; this.view.players.push(player); }
    player.connected = true;
    this.send('WELCOME', { ...this.roomState(), selfId: playerId, token: peer.token, rulesHash: LAN_RULES_HASH, contentHash: LAN_CONTENT_HASH,
      snapshot: this.view.snapshot ?? null, epoch: this.epoch, hostNow: this.now(), serverSeq: this.serverSeq }, connectionId);
    this.publishRoom();
  }
  private hostPacket(playerId: string, type: string, data: Record<string, unknown>, matchId?: string): void {
    const peer = this.peers.get(playerId); if (!peer) return;
    if (['SHOT', 'LOADED', 'RESUME_READY', 'PAUSE_REQUEST', 'PAUSE_DECISION', 'PAUSE_CANCEL', 'PAUSE_STATUS', 'SETTINGS', 'FORFEIT'].includes(type) && matchId !== this.view.snapshot?.matchId) return;
    switch (type) {
      case 'READY': if (this.view.phase === 'lobby') { const player = this.view.players.find(p => p.id === playerId); if (player) player.ready = data.ready === true; this.publishRoom(); } break;
      case 'LOADED': if (this.view.phase === 'preparing' && data.epoch === this.epoch) { peer.loaded = true; if (this.allPresent() && [...this.peers.values()].every(p => p.loaded)) this.countdown(); } break;
      case 'SHOT': this.acceptShot(playerId, data); break;
      case 'RESYNC': this.publishSnapshot(); this.publishRoom(); break;
      case 'PAUSE_REQUEST': if (validId(data.requestId)) this.askPause(playerId, data.requestId, data.reason === 'settings' ? 'settings' : 'pause', data.epoch); break;
      case 'PAUSE_STATUS': { const outcome = typeof data.requestId === 'string' ? this.pauseResults.get(data.requestId) : undefined; if (outcome) this.send('PAUSE_OUTCOME', { outcome }, peer.connectionId); else this.publishRoom(); break; }
      case 'PAUSE_DECISION': if (typeof data.requestId === 'string' && typeof data.accepted === 'boolean') this.vote(playerId, data.requestId, data.accepted, data.epoch); break;
      case 'PAUSE_CANCEL': if (this.view.pauseRequest && this.view.pauseRequest.requestId === data.requestId && this.view.pauseRequest.requesterId === playerId && data.epoch === this.epoch) this.finishPauseRequest('cancelled', '申请人取消了暂停'); break;
      case 'BACKGROUND':
        peer.foreground = false;
        if (this.operating(playerId)) {
          if (this.view.pauseRequest) this.finishPauseRequest('cancelled', '选手离开前台，暂停申请已取消');
          if (['playing', 'countdown', 'paused', 'preparing', 'reconnecting'].includes(this.view.phase)) this.beginRecovery('有选手离开前台，等待恢复 · 最多 20 秒', [playerId]);
        }
        break;
      case 'FOREGROUND': peer.foreground = true; this.publishRoom(); break;
      case 'SETTINGS':
        if (data.epoch !== this.epoch || typeof data.open !== 'boolean' || data.open && (!['paused', 'finished', 'lobby'].includes(this.view.phase) || this.closingSettings)) break;
        this.view.settingsOpen = this.view.settingsOpen.filter(p => p !== playerId); if (data.open) this.view.settingsOpen.push(playerId);
        if (data.open) this.view.resumeReady = this.view.resumeReady.filter(p => p !== playerId);
        if (!data.open) { this.closureMissing.delete(playerId); if (this.closingSettings) this.closeAcks.add(playerId); }
        this.tryResume(); this.publishRoom(); break;
      case 'RESUME_READY': if (['paused', 'reconnecting'].includes(this.view.phase) && data.epoch === this.epoch && peer.foreground && !this.view.settingsOpen.includes(playerId)) { if (!this.view.resumeReady.includes(playerId)) this.view.resumeReady.push(playerId); this.tryResume(); this.publishRoom(); } break;
      case 'REMATCH': if (this.view.phase === 'finished') this.toLobby(); break;
      case 'FORFEIT': if (data.epoch === this.epoch) this.pendingForfeits.add(playerId); break;
      case 'LEAVE': {
        if (this.operating(playerId)) this.pendingForfeits.add(playerId);
        const connection = peer.connectionId; if (connection) { this.disconnected(connection); this.disconnect(connection); }
        this.tryResume(); break;
      }
    }
  }
  private readRoom(data: Record<string, unknown>): boolean {
    if (typeof data.roomId !== 'string' || !validRoomConfig(data.config) || !Array.isArray(data.players) || data.players.length < 1 || data.players.length > 4) return false;
    const players = data.players as RoomPlayer[];
    if (players.some(p => !p || !validId(p.id) || typeof p.name !== 'string' || typeof p.ready !== 'boolean' || typeof p.connected !== 'boolean') || new Set(players.map(p => p.id)).size !== players.length || players.filter(p => p.isHost).length !== 1) return false;
    this.view.roomId = data.roomId; this.view.roomName = cleanName(data.roomName, 24); this.view.config = data.config;
    this.view.players = players.map(p => ({ ...p, name: cleanName(p.name), platform: cleanName(p.platform, 24) }));
    const ids = new Set(players.map(p => p.id));
    const request = data.pauseRequest as PauseRequest | null;
    if (this.view.phase === 'playing' && request && validId(request.requestId) && ids.has(request.requesterId) && ['pause', 'settings'].includes(request.reason) && request.status === 'waiting'
      && Array.isArray(request.participantIds) && request.participantIds.length <= 4 && request.participantIds.every(p => ids.has(p)) && typeof request.expiresAt === 'number' && Number.isFinite(request.expiresAt)
      && request.votes && typeof request.votes === 'object' && Object.entries(request.votes).every(([p, vote]) => request.participantIds.includes(p) && typeof vote === 'boolean') && !this.pauseResults.has(request.requestId)) {
      this.view.pauseRequest = { ...request, participantIds: [...request.participantIds], votes: { ...request.votes } }; this.view.pauseRequester = request.requesterId;
      if (this.pendingPause?.requestId === request.requestId) { this.pendingPause.queried = true; this.pendingPause.confirmed = true; }
    } else if (!request) { this.view.pauseRequest = undefined; this.view.pauseRequester = undefined; }
    this.view.resumeReady = Array.isArray(data.resumeReady) ? data.resumeReady.filter((p): p is string => typeof p === 'string' && ids.has(p)) : [];
    this.view.settingsOpen = Array.isArray(data.settingsOpen) ? data.settingsOpen.filter((p): p is string => typeof p === 'string' && ids.has(p)) : [];
    if (this.localSettingsOpen && !this.view.settingsOpen.includes(this.view.selfId)) this.view.settingsOpen.push(this.view.selfId);
    this.view.forceCloseSettings = data.forceCloseSettings === true || this.view.forceCloseSettings && this.localSettingsOpen;
    if (typeof data.pauseDeadline === 'number' && Number.isFinite(data.pauseDeadline)) this.pauseDeadline = data.pauseDeadline;
    if (typeof data.notice === 'string') this.view.notice = data.notice.slice(0, 160);
    if (data.pauseOutcome) this.readPauseOutcome(data.pauseOutcome);
    return true;
  }
  private readPauseOutcome(value: unknown): void {
    const outcome = value as PauseOutcome | null;
    if (!outcome || !validId(outcome.requestId) || !validId(outcome.requesterId) || !['pause', 'settings'].includes(outcome.reason) || !['approved', 'rejected', 'cancelled', 'expired', 'failed'].includes(outcome.status) || typeof outcome.message !== 'string' || this.pauseResults.has(outcome.requestId)) return;
    const intent = this.pendingPause;
    if (this.view.phase === 'paused' && outcome.status === 'approved' && outcome.reason === 'settings' && outcome.requesterId === this.view.selfId && intent?.requestId === outcome.requestId && (intent.confirmed || this.now() - intent.began < PAUSE_RULES.voteMs)) this.view.autoOpenSettings = true;
    this.pauseResults.set(outcome.requestId, outcome); if (this.pauseResults.size > 64) this.pauseResults.delete(this.pauseResults.keys().next().value!);
    this.view.pauseOutcome = { ...outcome, message: outcome.message.slice(0, 160) }; this.view.notice = outcome.message.slice(0, 160);
    if (this.view.pauseRequest?.requestId === outcome.requestId) { this.view.pauseRequest = undefined; this.view.pauseRequester = undefined; }
    if (intent?.requestId === outcome.requestId) this.pendingPause = undefined;
  }
  private guestPacket(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case 'WELCOME': {
        if (!this.awaitingWelcome || !['joining', 'reconnecting'].includes(this.view.phase)) return;
        if (data.rulesHash !== LAN_RULES_HASH || data.contentHash !== LAN_CONTENT_HASH || typeof data.token !== 'string' || typeof data.epoch !== 'number' || !validId(data.selfId) || !this.readRoom(data)) {
          this.awaitingWelcome = false; this.view.phase = 'closed';
          if (this.peer) this.disconnect(this.peer);
          this.fail('联机版本或身份不兼容'); return;
        }
        this.awaitingWelcome = false; this.view.selfId = data.selfId; this.reconnectToken = data.token; this.receivedEpoch = data.epoch;
        this.lastServerSeq = typeof data.serverSeq === 'number' ? data.serverSeq : -1;
        if (typeof data.hostNow === 'number') this.offset = data.hostNow - this.now();
        if (isMatchSnapshot(data.snapshot) && data.snapshot.players[this.view.selfId]) {
          this.view.snapshot = data.snapshot; this.activeMs = data.snapshot.elapsedMs; this.lastPublish = this.now(); this.seenMatches.add(data.snapshot.matchId);
          this.sequence = Math.max(this.sequence, data.snapshot.players[this.view.selfId].lastSeq);
          this.view.phase = data.snapshot.status === 'finished' ? 'finished' : data.phase === 'playing' && !this.operating(this.view.selfId) ? 'playing' : 'reconnecting';
          this.send('LOADED', { epoch: this.receivedEpoch });
        } else { this.view.phase = 'lobby'; this.view.snapshot = undefined; }
        this.eventBaseline(); if (this.target) rememberLanAddress(this.target.address, this.target.port, this.view.roomName);
        this.send('PING', { sent: this.now() }); this.changed(); break;
      }
      case 'ROOM': this.readRoom(data); this.changed(); break;
      case 'LOBBY': if (!this.readRoom(data)) return; this.view.snapshot = undefined; this.eventBaseline(); this.view.phase = 'lobby'; this.recoveryDeadline = 0; this.view.pendingShot = false; this.changed(); break;
      case 'PREPARE':
        if (!isMatchSnapshot(data.snapshot) || !data.snapshot.players[this.view.selfId]) { this.fail('初始棋盘校验失败，请重新加入'); return; }
        if (this.view.phase === 'preparing' && this.view.snapshot?.matchId === data.snapshot.matchId) { if (this.foreground) this.send('LOADED', { epoch: this.receivedEpoch }); return; }
        if (this.view.phase !== 'lobby' || this.seenMatches.has(data.snapshot.matchId)) return;
        this.seenMatches.add(data.snapshot.matchId); this.view.snapshot = data.snapshot; this.receivedEpoch = data.epoch as number; this.sequence = 0; this.lastServerSeq = -1;
        this.eventBaseline(); this.pauseResults.clear(); this.pauseCooldown.clear(); this.pauseResumeRequester = undefined; this.pendingPause = undefined; this.view.phase = 'preparing'; this.activeMs = 0; this.preparationDeadline = this.now() + 10000;
        if (this.foreground) this.send('LOADED', { epoch: this.receivedEpoch }); else this.send('BACKGROUND'); this.changed(); break;
      case 'START':
        if (!isMatchSnapshot(data.snapshot) || typeof data.startAt !== 'number' || !Number.isFinite(data.startAt)) return;
        if (!['preparing', 'paused', 'reconnecting', 'countdown'].includes(this.view.phase) || typeof data.epoch !== 'number' || data.epoch < this.receivedEpoch) return;
        if (!this.foreground && this.operating(this.view.selfId)) { this.send('BACKGROUND'); return; }
        if (this.localSettingsOpen) { this.view.forceCloseSettings = true; if (this.operating(this.view.selfId)) { this.send('BACKGROUND'); this.changed(); return; } }
        this.view.snapshot = data.snapshot; this.receivedEpoch = data.epoch; this.activeMs = data.snapshot.elapsedMs; this.lastPublish = this.now(); this.eventBaseline();
        this.view.phase = 'countdown'; this.startAt = data.startAt - this.offset; this.recoveryDeadline = 0; this.pauseDeadline = 0;
        this.view.pendingShot = false; this.pendingSeq = undefined; this.view.notice = ''; this.view.forceCloseSettings = this.localSettingsOpen; this.view.settingsOpen = this.localSettingsOpen ? [this.view.selfId] : []; this.view.autoOpenSettings = false; this.changed(); break;
      case 'STATE': {
        if (!isMatchSnapshot(data.snapshot) || data.snapshot.matchId !== this.view.snapshot?.matchId || data.epoch !== this.receivedEpoch || typeof data.serverSeq !== 'number' || data.serverSeq < this.lastServerSeq) return;
        this.lastServerSeq = data.serverSeq; this.view.snapshot = data.snapshot; this.activeMs = data.snapshot.elapsedMs; this.lastPublish = this.now();
        if (data.snapshot.players[this.view.selfId]?.sealed) { this.view.pendingShot = false; this.pendingSeq = undefined; }
        if (Array.isArray(data.events) && data.events.length <= 128 && data.events.every(isPresentationEvent) && data.events.every(event => event.eventSeq <= this.view.snapshot!.eventSeq)) this.acceptEvents(data.events);
        else if (data.events !== undefined) { this.eventBaseline(); this.send('RESYNC'); }
        this.checkFinished(); this.changed(); break;
      }
      case 'PRESENTATION':
        if (data.epoch !== this.receivedEpoch || data.serverSeq !== this.lastServerSeq || typeof data.playerId !== 'string' || !this.view.snapshot?.playerIds.includes(data.playerId) || !Array.isArray(data.events) || data.events.length > 32
          || !data.events.every(isPresentationEvent) || !data.events.every(event => event.playerId === data.playerId && event.eventSeq <= Number(data.eventWatermark) && event.eventSeq <= this.view.snapshot!.eventSeq)) return;
        this.acceptEvents(data.events); this.changed(); break;
      case 'COMMAND':
        if (data.epoch !== this.receivedEpoch || data.seq !== this.pendingSeq) return;
        this.view.pendingShot = false; this.pendingSeq = undefined;
        if (data.accepted !== true) { this.view.notice = rejectionMessage(data.reason); this.send('RESYNC'); } else this.view.notice = '';
        this.changed(); break;
      case 'FREEZE':
        if (this.view.snapshot?.status === 'finished') return;
        if (isMatchSnapshot(data.snapshot) && data.snapshot.matchId === this.view.snapshot?.matchId && typeof data.epoch === 'number' && data.epoch >= this.receivedEpoch) {
          this.view.snapshot = data.snapshot; this.activeMs = data.snapshot.elapsedMs; this.receivedEpoch = data.epoch;
          if (typeof data.pauseDeadline === 'number') this.pauseDeadline = data.pauseDeadline;
          if (data.recovery === true) this.recoveryDeadline ||= this.now() + 20000;
          this.freeze(typeof data.reason === 'string' ? data.reason.slice(0, 160) : '比赛已暂停', data.recovery === true);
        } break;
      case 'PAUSE_OUTCOME': this.readPauseOutcome(data.outcome); this.changed(); break;
      case 'CLOSE_SETTINGS':
        if (this.view.snapshot?.status === 'finished' || !['paused', 'reconnecting'].includes(this.view.phase) || data.epoch !== this.receivedEpoch || !isMatchSnapshot(data.snapshot)) return;
        this.view.snapshot = data.snapshot; this.eventBaseline(); this.view.forceCloseSettings = true; this.view.autoOpenSettings = false;
        if (!this.view.settingsOpen.includes(this.view.selfId) && this.foreground) this.settingsChanged(false); else this.changed(); break;
      case 'REJECT': this.view.error = typeof data.reason === 'string' ? data.reason.slice(0, 160) : '无法加入'; this.view.phase = 'closed'; this.changed(); break;
      case 'CLOSED':
        if (isMatchSnapshot(data.snapshot) && data.snapshot.status === 'finished') { this.view.snapshot = data.snapshot; this.checkFinished(); }
        else if (this.view.snapshot?.status === 'playing') this.interrupt('房主已关闭房间'); else if (this.view.phase !== 'finished') this.view.phase = 'closed';
        this.view.notice = typeof data.reason === 'string' ? data.reason.slice(0, 160) : '房间已关闭'; this.changed(); break;
    }
  }
  private recoveryTimeout(): void {
    if (!this.view.isHost) { this.interrupt('房主恢复超时，本局中断，结果未同步'); return; }
    if (!this.foreground || this.view.settingsOpen.includes(this.view.selfId) || this.closureMissing.has(this.view.selfId) || this.closingSettings && !this.closeAcks.has(this.view.selfId)) { this.interrupt('房主恢复超时，本局中断'); return; }
    const missing = this.requiredIds().filter(p => p !== this.view.selfId && (!this.peers.get(p)?.connectionId || !this.peers.get(p)?.foreground || this.view.settingsOpen.includes(p) || this.closureMissing.has(p) || this.closingSettings && !this.closeAcks.has(p)));
    if (missing.length) this.applyForfeits(missing);
    if (this.view.snapshot?.status !== 'playing') return;
    // The original recovery deadline has been handled. Healthy peers get the entire
    // close-settings acknowledgement window, even on a LAN with >50 ms latency.
    this.recoveryDeadline = 0;
    this.view.notice = missing.length ? '未返回选手已弃权，准备继续' : '恢复等待结束，准备继续';
    this.view.resumeReady = this.requiredIds(); this.closingSettings = false; this.view.forceCloseSettings = false; this.beginCloseSettings();
  }
  private tick(): void {
    if (this.closed) return;
    const now = this.now(), delta = this.lastTick ? Math.max(0, now - this.lastTick) : 0;
    let gameDelta = delta;
    if (this.view.isHost && this.pendingForfeits.size) { const leaving = [...this.pendingForfeits]; this.pendingForfeits.clear(); this.applyForfeits(leaving); gameDelta = 0; }
    this.lastTick = now;
    for (const [connectionId, deadline] of this.candidates) if (now > deadline) { this.candidates.delete(connectionId); this.disconnect(connectionId); }
    for (const [key, transfer] of this.transfers) if (now >= transfer.expiresAt) { this.transfers.delete(key); if (!this.view.isHost) { this.eventBaseline(); this.send('RESYNC'); } }
    if (this.view.isHost) {
      for (const peer of this.peers.values()) if (peer.connectionId) {
        if (now - peer.lastPing >= 1000) { peer.lastPing = now; this.send('PING', { sent: now }, peer.connectionId); }
        if (now - peer.lastReceive > 3500) { const connection = peer.connectionId; this.disconnected(connection); this.disconnect(connection); }
      }
    } else if (this.peer) {
      if (now - this.lastPing >= 1000) { this.lastPing = now; this.send('PING', { sent: now }); }
      if (now - this.lastReceive > 3500) { const peer = this.peer; this.disconnected(peer); this.disconnect(peer); }
    }
    if (this.view.phase === 'joining' && now > this.preparationDeadline && !this.view.isHost) { this.view.phase = 'closed'; this.view.error = '加入超时，请检查地址、防火墙与网络隔离'; this.changed(); }
    if (this.view.phase === 'preparing' && now > this.preparationDeadline) {
      if (this.view.isHost) this.toLobby(); else { this.view.phase = 'closed'; this.view.error = '房主开局未完成，请重新加入'; this.changed(); }
    }
    if (this.pendingPause && this.view.pauseRequest?.status === 'sending') {
      const waiting = now - this.pendingPause.began;
      if (waiting >= PAUSE_RULES.voteMs) { const pending = this.pendingPause; this.pendingPause = undefined; this.pauseCooldown.set(this.view.selfId, now + PAUSE_RULES.cooldownMs); this.view.autoOpenSettings = false; this.view.pauseRequest = undefined; this.view.pauseRequester = undefined; this.view.pauseOutcome = { requestId: pending.requestId, requesterId: this.view.selfId, reason: pending.reason, status: 'failed', message: '暂停申请未确认，请检查连接后重试' }; this.view.notice = this.view.pauseOutcome.message; this.send('PAUSE_CANCEL', { requestId: pending.requestId, epoch: this.receivedEpoch }); this.changed(); }
      else if (waiting >= 2000 && !this.pendingPause.queried) { this.pendingPause.queried = true; this.view.notice = '暂停申请尚未确认，正在查询'; this.send('PAUSE_STATUS', { requestId: this.pendingPause.requestId }); this.changed(); }
    }
    this.view.pauseVoteRemainingMs = this.view.pauseRequest ? Math.max(0, this.view.pauseRequest.expiresAt - this.hostNow()) : 0;
    this.view.pauseRemainingMs = this.pauseDeadline ? Math.max(0, this.pauseDeadline - this.hostNow()) : 0;
    if (this.view.isHost && this.view.pauseRequest?.status === 'waiting' && now >= this.view.pauseRequest.expiresAt) this.finishPauseRequest('expired', '暂停申请已超时，比赛继续');
    if (this.view.phase === 'reconnecting') {
      if (this.recoveryDeadline && now >= this.recoveryDeadline && (this.view.isHost || !this.peer)) this.recoveryTimeout();
      else if (!this.view.isHost && !this.peer && this.foreground && now >= this.retryAt) void this.connect().catch(() => {});
      if (this.view.isHost && this.pauseDeadline && now >= this.pauseDeadline && !this.closingSettings) this.beginCloseSettings();
    }
    if (this.view.isHost && this.view.phase === 'paused' && this.pauseDeadline && now >= this.pauseDeadline && !this.closingSettings) this.beginCloseSettings();
    if (this.view.isHost && this.closingSettings && now >= this.closeSettingsDeadline) {
      const missing = this.requiredIds().filter(p => !this.closeAcks.has(p));
      for (const playerId of missing) this.closureMissing.add(playerId);
      this.beginRecovery('等待设置关闭确认，正在恢复连接', missing); this.closeSettingsDeadline = Infinity;
    }
    if (this.view.phase === 'countdown') {
      this.view.countdown = Math.max(0, Math.ceil((this.startAt - now) / 1000));
      if (now >= this.startAt && this.foreground) {
        this.view.phase = 'playing'; this.lastTick = now; this.lastPublish = now; this.view.notice = '';
        if (this.view.isHost && this.pauseResumeRequester) {
          this.pauseCooldown.set(this.pauseResumeRequester, now + PAUSE_RULES.cooldownMs); this.pauseResumeRequester = undefined;
        }
      }
      this.changed();
    } else if (this.view.phase === 'playing' && this.view.snapshot) {
      if ((delta > 1500 || !this.foreground) && (this.view.isHost || this.operating(this.view.selfId))) { this.beginRecovery('游戏暂时挂起，等待选手恢复', [this.view.selfId]); return; }
      if (this.view.isHost) {
        const previous = this.view.snapshot; this.activeMs += gameDelta;
        const update = previous.mode === 'battle' ? applyBattleBatch(previous, [...this.queuedShots.values()].map(data => ({ playerId: data.playerId as string, seq: data.seq as number, boardRevision: data.boardRevision as number, angleMilliDeg: data.angleMilliDeg as number })), this.activeMs) : advanceWithEvents(previous, this.activeMs);
        this.queuedShots.clear(); this.view.snapshot = update.snapshot;
        if (previous.mode === 'battle') for (const outcome of (update as BattleBatchOutcome).outcomes) this.completeCommand(outcome.playerId, { ...outcome, epoch: this.epoch });
        const boardChanged = previous.playerIds.some(p => previous.players[p].boardRevision !== this.view.snapshot!.players[p].boardRevision);
        if (boardChanged || update.presentationEvents.length || now - this.lastPublish >= 1000 || update.snapshot.status === 'finished') this.publishSnapshot(update.presentationEvents);
        this.checkPauseMembers(); this.checkFinished();
      }
      this.changed();
    } else if (['paused', 'reconnecting'].includes(this.view.phase)) this.changed();
    if (this.view.phase === 'browsing') {
      if (this.scanDeadline && now >= this.scanDeadline && this.view.discovery.status === 'scanning') { this.scanDeadline = 0; this.view.discovery.status = 'completed'; void this.transport.request('stopDiscovery').catch(() => {}); }
      const before = this.view.rooms.length; this.view.rooms = this.view.rooms.filter(r => now - r.lastSeenAt < 30000);
      if (before !== this.view.rooms.length || now % 1000 < 60) this.changed();
    }
  }
  displayElapsed(): number {
    if (!this.view.snapshot) return 0;
    const extra = !this.view.isHost && this.view.phase === 'playing' ? Math.min(1200, Math.max(0, this.now() - this.lastPublish)) : 0;
    return Math.min(this.view.snapshot.durationMs, this.view.snapshot.elapsedMs + extra);
  }
  /** Absolute display-only time in the same coordinates as PresentationEvent.atMs. */
  presentationTime(): number {
    const snapshot = this.view.snapshot;
    if (!snapshot) { this.presentationClock.reset(); return 0; }
    return this.presentationClock.sample({ matchId: snapshot.matchId, epoch: this.view.isHost ? this.epoch : this.receivedEpoch,
      phase: this.view.phase, time: snapshot.startedAtMs + snapshot.elapsedMs, end: snapshot.startedAtMs + snapshot.durationMs,
      sampledAt: this.view.isHost ? this.lastTick : this.lastPublish }, this.now());
  }
  roomAgeMs(room: SessionRoom): number { return Math.max(0, this.now() - room.lastSeenAt); }
}
function rejectionMessage(reason: unknown): string {
  const messages: Record<string, string> = { STALE_STATE: '棋盘已下移，请重新瞄准', COOLDOWN: '正在完成上一发', PAUSED: '比赛已暂停，请恢复后重新发射', INVALID_LANDING: '这个角度没有合法落点', PLAYER_SEALED: '已触底，观看其他选手完成本局', MATCH_FINISHED: '本局已结束' };
  return messages[String(reason)] ?? '发射未确认，请重新瞄准';
}
