import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanSession, LAN_WIRE_TARGET_BYTES, type RoomConfig } from '../src/lan/session';
import { LAN_CONTENT_HASH, LAN_PROTOCOL_VERSION, LAN_RULES_HASH, PAUSE_RULES } from '../src/lan/protocol';
import type { HostInfo, LanEvent, LanTransport } from '../src/lan/transport';

type WirePacket = { v: number; type: string; roomId: string; matchId?: string; data: Record<string, unknown> };
interface WireMessage { sender: MemoryTransport; connectionId: string; message: string; packet: WirePacket }
class MemoryNetwork {
  host?: MemoryTransport;
  nextConnection = 0;
  online = true;
  messages: WireMessage[] = [];
  links = new Map<string, { source: MemoryTransport; target: MemoryTransport; targetId: string }>();
  blockedTypes = new Set<string>();
  connect(client: MemoryTransport): { connectionId: string } {
    if (!this.online || !this.host) throw new Error('Network unavailable');
    const guestId = `guest-${++this.nextConnection}`, hostId = `host-${this.nextConnection}`;
    this.links.set(guestId, { source: client, target: this.host, targetId: hostId });
    this.links.set(hostId, { source: this.host, target: client, targetId: guestId });
    this.host.emit({ type: 'lan-event', event: 'connected', connectionId: hostId });
    client.emit({ type: 'lan-event', event: 'connected', connectionId: guestId });
    return { connectionId: guestId };
  }
  send(sender: MemoryTransport, connectionId: string, message: string): void {
    const link = this.links.get(connectionId); if (!link || link.source !== sender) throw new Error('Disconnected');
    const packet = JSON.parse(message) as WirePacket;
    this.messages.push({ sender, connectionId, message, packet });
    if (!this.online || this.blockedTypes.has(packet.type)) return;
    // Native transports deliver asynchronously after serializing the wire payload.
    void Promise.resolve().then(() => {
      if (this.links.get(connectionId) !== link) return;
      link.target.emit({ type: 'lan-event', event: 'message', connectionId: link.targetId, message });
    });
  }
  disconnect(connectionId: string): void {
    const link = this.links.get(connectionId); if (!link) return;
    this.links.delete(connectionId); this.links.delete(link.targetId);
    link.source.emit({ type: 'lan-event', event: 'disconnected', connectionId });
    link.target.emit({ type: 'lan-event', event: 'disconnected', connectionId: link.targetId });
  }
  disconnectAll(): void { for (const id of this.links.keys()) this.disconnect(id); }
  replay(message: WireMessage, replacement?: WirePacket): void {
    const link = this.links.get(message.connectionId); if (!link) throw new Error('Replay link missing');
    link.target.emit({ type: 'lan-event', event: 'message', connectionId: link.targetId,
      message: replacement ? JSON.stringify(replacement) : message.message });
  }
  last(type: string, sender?: MemoryTransport): WireMessage {
    const message = [...this.messages].reverse().find(item => item.packet.type === type && (!sender || sender === item.sender));
    if (!message) throw new Error(`Missing ${type}`); return message;
  }
}
class MemoryTransport implements LanTransport {
  readonly available = true;
  readonly listeners = new Set<(event: LanEvent) => void>();
  constructor(readonly network: MemoryNetwork) {}
  emit(event: LanEvent): void { for (const listener of this.listeners) listener(event); }
  subscribe(listener: (event: LanEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async request<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    let result: unknown = {};
    switch (action) {
      case 'startHost': this.network.host = this; result = { addresses: ['127.0.0.1'], port: 42171, discoveryAvailable: true } satisfies HostInfo; break;
      case 'connect': result = this.network.connect(this); break;
      case 'send': this.network.send(this, String(payload.connectionId), String(payload.message)); break;
      case 'disconnect': this.network.disconnect(String(payload.connectionId)); break;
      case 'stopHost': case 'dispose':
        for (const [id, link] of this.network.links) if (link.source === this) this.network.disconnect(id);
        if (this.network.host === this) this.network.host = undefined;
        break;
    }
    return result as T;
  }
  async close(): Promise<void> { await this.request('dispose'); this.listeners.clear(); }
}
const config = { difficultyId: 'normal' as const, durationMs: 180000 as const };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function pair(guestOffset = 0) {
  const network = new MemoryNetwork();
  const hostTransport = new MemoryTransport(network), guestTransport = new MemoryTransport(network);
  const host = new LanSession(hostTransport, () => Date.now());
  const guest = new LanSession(guestTransport, () => Date.now() + guestOffset);
  return { network, hostTransport, guestTransport, host, guest };
}
type Pair = ReturnType<typeof pair>;
async function lobby(game = pair(), roomConfig: RoomConfig = config): Promise<Pair> {
  await game.host.host('房主', '测试房间', roomConfig);
  await game.guest.join('客人', '127.0.0.1', 42171); await flush();
  expect(game.host.view.phase).toBe('lobby'); expect(game.guest.view.phase).toBe('lobby'); return game;
}
async function start(game = pair(), roomConfig: RoomConfig = config): Promise<Pair> {
  await lobby(game, roomConfig); game.host.ready(); game.guest.ready(); await flush(); game.host.start(); await flush();
  expect(game.host.view.phase).toBe('countdown'); expect(game.guest.view.phase).toBe('countdown');
  await vi.advanceTimersByTimeAsync(3050);
  expect(game.host.view.phase).toBe('playing'); expect(game.guest.view.phase).toBe('playing'); return game;
}
async function finish(game: Pair): Promise<void> {
  await vi.advanceTimersByTimeAsync(181000);
  expect(game.host.view.phase).toBe('finished'); expect(game.guest.view.phase).toBe('finished');
}
async function rematch(game: Pair): Promise<void> {
  game.host.rematch(); await flush(); game.host.ready(); game.guest.ready(); await flush(); game.host.start(); await flush();
  await vi.advanceTimersByTimeAsync(3050);
  expect(game.host.view.phase).toBe('playing'); expect(game.guest.view.phase).toBe('playing');
}
async function group(count = 4, mode: 'score' | 'battle' = 'score', startNow = true) {
  const game = await lobby(pair(), { ...config, mode });
  const sessions = [game.host, game.guest], transports = [game.hostTransport, game.guestTransport];
  for (let index = 2; index < count; index++) {
    const transport = new MemoryTransport(game.network), session = new LanSession(transport, () => Date.now() + index * 17000);
    transports.push(transport); sessions.push(session); await session.join(`选手${index}🙂`, '127.0.0.1', 42171); await flush();
  }
  if (startNow) {
    for (const session of sessions) session.ready(); await flush(); game.host.start(); await flush();
    expect(sessions.every(session => session.view.phase === 'countdown')).toBe(true);
    await vi.advanceTimersByTimeAsync(3050); expect(sessions.every(session => session.view.phase === 'playing')).toBe(true);
  }
  return { ...game, sessions, transports };
}
async function unanimousPause(sessions: LanSession[], requester = 0, reason: 'pause' | 'settings' = 'pause') {
  sessions[requester].requestPause(reason); await flush();
  const requestId = sessions[0].view.pauseRequest!.requestId;
  for (let index = 0; index < sessions.length; index++) if (index !== requester) sessions[index].decidePause(true, requestId);
  await flush(); expect(sessions.every(session => session.view.phase === 'paused')).toBe(true); return requestId;
}

describe('LAN two-session integration over an asynchronous serialized transport', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
    vi.stubGlobal('window', { dispatchEvent: () => true, localStorage });
    vi.stubGlobal('localStorage', localStorage);
    vi.useFakeTimers(); vi.setSystemTime(100000);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('requires both ready and loaded, then starts independent boards despite different local clock origins', async () => {
    const game = await lobby(pair(80000));
    game.host.ready(); game.host.start(); expect(game.host.view.phase).toBe('lobby');
    game.guest.ready(); await flush(); game.network.blockedTypes.add('LOADED'); game.host.start(); await flush();
    expect(game.host.view.phase).toBe('preparing'); expect(game.guest.view.phase).toBe('preparing');
    game.network.blockedTypes.delete('LOADED'); game.network.replay(game.network.last('LOADED')); await flush();
    expect(game.host.view.phase).toBe('countdown'); expect(game.guest.view.phase).toBe('countdown');
    await vi.advanceTimersByTimeAsync(2999);
    expect(game.host.view.phase).toBe('countdown'); expect(game.guest.view.phase).toBe('countdown');
    await vi.advanceTimersByTimeAsync(51);
    expect(game.host.view.phase).toBe('playing'); expect(game.guest.view.phase).toBe('playing');
    expect(game.host.view.snapshot!.players.host.state).toEqual(game.guest.view.snapshot!.players.host.state);
    expect(game.host.view.snapshot!.players.guest.state).toEqual(game.guest.view.snapshot!.players.guest.state);
    expect(game.host.view.snapshot!.players.host.state).not.toEqual(game.host.view.snapshot!.players.guest.state);
  });

  it('applies both local and guest shots authoritatively, deduplicates retransmitted shots, and clears pending confirmation', async () => {
    const game = await start();
    game.guest.shoot(23000); expect(game.guest.view.pendingShot).toBe(true); await flush();
    expect(game.guest.view.pendingShot).toBe(false);
    expect(game.host.view.snapshot!.players.guest.totalShots).toBe(1);
    const shot = game.network.last('SHOT'); game.network.replay(shot); await flush();
    expect(game.host.view.snapshot!.players.guest.totalShots).toBe(1);
    game.host.shoot(-23000); await flush();
    expect(game.host.view.snapshot!.players.host.totalShots).toBe(1);
    expect(game.guest.view.snapshot).toEqual(game.host.view.snapshot);
  });

  it('resets readiness after a host changes settings and rejects a third player', async () => {
    const game = await lobby(); game.host.ready(); game.guest.ready(); await flush();
    game.host.setConfig({ difficultyId: 'hard', durationMs: 300000, capacity: 2 }); await flush();
    expect(game.guest.view.config).toEqual({ difficultyId: 'hard', durationMs: 300000, capacity: 2 });
    expect(game.guest.view.players.every(player => !player.ready)).toBe(true);
    const stranger = new MemoryTransport(game.network); const third = new LanSession(stranger, () => Date.now());
    await third.join('第三人', '127.0.0.1', 42171); await flush();
    expect(third.view.phase).toBe('closed'); expect(third.view.error).toContain('已满');
    expect(game.host.view.players).toHaveLength(2);
  });

  it('freezes on foreground loss, waits for both confirmations, and does not charge paused time', async () => {
    const game = await start(); await vi.advanceTimersByTimeAsync(1000);
    game.guest.foregroundChanged(false); await flush();
    expect(game.host.view.phase).toBe('reconnecting'); expect(game.guest.view.phase).toBe('reconnecting');
    const elapsed = game.host.view.snapshot!.elapsedMs;
    await vi.advanceTimersByTimeAsync(3000);
    expect(game.host.view.snapshot!.elapsedMs).toBe(elapsed);
    game.host.resume(); await flush(); expect(game.host.view.phase).toBe('reconnecting');
    game.guest.foregroundChanged(true); game.guest.resume(); await flush();
    expect(game.host.view.phase).toBe('countdown'); expect(game.guest.view.phase).toBe('countdown');
    await vi.advanceTimersByTimeAsync(3050);
    expect(game.host.view.snapshot!.elapsedMs).toBeLessThanOrEqual(elapsed + 100);
    expect(game.guest.view.phase).toBe('playing');
  });

  it('pauses only after consent and automatically resumes after the bounded pause', async () => {
    const game = await start(); game.guest.requestPause(); await flush();
    expect(game.host.view.phase).toBe('playing'); expect(game.host.view.pauseRequester).toBe('guest');
    game.host.decidePause(true); await flush(); expect(game.host.view.phase).toBe('paused');
    const elapsed = game.host.view.snapshot!.elapsedMs;
    await vi.advanceTimersByTimeAsync(60000);
    expect(game.host.view.phase).toBe('countdown'); expect(game.host.view.snapshot!.elapsedMs).toBe(elapsed);
    await vi.advanceTimersByTimeAsync(3050); game.guest.requestPause(); await flush();
    expect(game.host.view.pauseRequester).toBeUndefined(); expect(game.guest.view.notice).toContain('15 秒');
  });

  it('reconnects with the same identity and confirmed board, then discards commands from the old connection epoch', async () => {
    const game = await start(); game.guest.shoot(0); await flush();
    const oldShot = game.network.last('SHOT').packet;
    const oldId = game.host.view.snapshot!.matchId, oldShots = game.host.view.snapshot!.players.guest.totalShots;
    const confirmedState = structuredClone(game.host.view.snapshot!.players.guest.state);
    game.network.disconnectAll(); expect(game.host.view.phase).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1600); await flush();
    expect(game.guest.view.snapshot!.matchId).toBe(oldId);
    expect(game.guest.view.snapshot!.players.guest.totalShots).toBe(oldShots);
    expect(game.guest.view.snapshot!.players.guest.state).toEqual(confirmedState);
    game.host.resume(); game.guest.resume(); await flush(); await vi.advanceTimersByTimeAsync(3050);
    const hello = game.network.last('HELLO', game.guestTransport);
    game.network.replay(hello, oldShot); await flush();
    expect(game.host.view.snapshot!.players.guest.totalShots).toBe(oldShots);
    expect(game.host.view.snapshot!.players.guest.state).toEqual(confirmedState);
    await vi.advanceTimersByTimeAsync(1600); // Logical shot cooldown also freezes during recovery.
    game.guest.shoot(-23000); await flush();
    expect(game.host.view.snapshot!.players.guest.totalShots).toBe(oldShots + 1);
    expect(game.guest.view.snapshot).toEqual(game.host.view.snapshot);
  });

  it('forfeits a missing guest authoritatively while the disconnected guest keeps an unsynchronized interrupted record', async () => {
    const game = await start(); game.network.online = false; game.network.disconnectAll();
    await vi.advanceTimersByTimeAsync(20500);
    expect(game.host.view.snapshot!.result?.reason).toBe('forfeit');
    expect(game.host.view.snapshot!.result?.winnerId).toBe('host');
    expect(game.guest.view.snapshot!.result?.winnerId).toBeNull();
    expect(game.host.view.phase).toBe('finished'); expect(game.guest.view.phase).toBe('finished');
  });

  it('keeps one authoritative result under duplicates and uses a new match identity on rematch', async () => {
    const game = await start(); await finish(game);
    expect(game.guest.view.snapshot?.result).toEqual(game.host.view.snapshot?.result);
    const result = game.network.last('STATE', game.hostTransport), oldId = game.host.view.snapshot!.matchId;
    game.network.replay(result); await flush(); expect(game.guest.view.snapshot?.result).toEqual(game.host.view.snapshot?.result);
    await rematch(game); expect(game.host.view.snapshot!.matchId).not.toBe(oldId);
    const newSnapshot = game.guest.view.snapshot; game.network.replay(result); await flush();
    expect(game.guest.view.snapshot).toEqual(newSnapshot); expect(game.guest.view.phase).toBe('playing');
  });

  it('rejects an old match START packet after rematch rather than rolling the board back', async () => {
    const game = await start(); const oldStart = game.network.last('START', game.hostTransport);
    await finish(game); await rematch(game); const matchId = game.guest.view.snapshot!.matchId;
    game.network.replay(oldStart); await flush();
    expect(game.guest.view.snapshot!.matchId).toBe(matchId);
    expect(game.guest.view.phase).toBe('playing');
  });

  it('does not let an old match COMMAND clear an unconfirmed shot in the new match', async () => {
    const game = await start(); game.guest.shoot(0); await flush(); const oldCommand = game.network.last('COMMAND', game.hostTransport);
    await finish(game); await rematch(game); game.network.blockedTypes.add('COMMAND'); game.network.blockedTypes.add('STATE');
    game.guest.shoot(0); await flush(); expect(game.guest.view.pendingShot).toBe(true);
    game.network.replay(oldCommand); await flush(); expect(game.guest.view.pendingShot).toBe(true);
  });

  it('rejects an old match PREPARE packet during a later match', async () => {
    const game = await start(); const oldPrepare = game.network.last('PREPARE', game.hostTransport);
    await finish(game); await rematch(game); const matchId = game.guest.view.snapshot!.matchId;
    game.network.replay(oldPrepare); await flush();
    expect(game.guest.view.snapshot!.matchId).toBe(matchId); expect(game.guest.view.phase).toBe('playing');
  });

  it('rejects incompatible rules before granting a player identity', async () => {
    const game = pair(); await game.host.host('房主', '测试', config);
    game.network.blockedTypes.add('HELLO'); await game.guest.join('客人', '127.0.0.1', 42171); await flush();
    const hello = game.network.last('HELLO');
    game.network.replay(hello, { ...hello.packet, data: { ...hello.packet.data, rulesHash: 'older-rules' } }); await flush();
    expect(game.guest.view.phase).toBe('closed'); expect(game.guest.view.error).toContain('不兼容');
    expect(game.host.view.players).toHaveLength(1);
  });

  it('does not start a match while a prepared guest is in the background', async () => {
    const game = await lobby(); game.host.ready(); game.guest.ready(); await flush();
    game.guest.foregroundChanged(false); await flush(); game.host.start(); await flush();
    await vi.advanceTimersByTimeAsync(3050);
    expect(game.host.view.phase).not.toBe('playing');
    expect(game.host.view.snapshot?.elapsedMs ?? 0).toBe(0);
  });

  it('does not enter play if the guest backgrounds during the initial loading barrier', async () => {
    const game = await lobby(); game.host.ready(); game.guest.ready(); await flush();
    game.network.blockedTypes.add('LOADED'); game.host.start(); await flush();
    game.guest.foregroundChanged(false); await flush();
    game.network.replay(game.network.last('LOADED')); await flush(); await vi.advanceTimersByTimeAsync(3050);
    expect(game.host.view.phase).not.toBe('playing');
    expect(game.host.view.snapshot?.elapsedMs ?? 0).toBe(0);
  });

  it('ignores a delayed startHost completion after leaving the room', async () => {
    const game = pair(); const original = game.hostTransport.request.bind(game.hostTransport);
    let resolveHost!: (value: HostInfo) => void;
    vi.spyOn(game.hostTransport, 'request').mockImplementation(async <T>(action: string, payload?: Record<string, unknown>) => {
      if (action === 'startHost') return await new Promise<HostInfo>(resolve => { resolveHost = resolve; }) as T;
      return await original<T>(action, payload);
    });
    const hosting = game.host.host('房主', '延迟房间', config); await flush();
    expect(game.host.view.phase).toBe('joining'); await game.host.leave(); expect(game.host.view.phase).toBe('idle');
    resolveHost({ addresses: ['127.0.0.1'], port: 42171, discoveryAvailable: true }); await hosting; await flush();
    expect(game.host.view.phase).toBe('idle'); expect(game.host.view.hostInfo).toBeUndefined();
  });

  it('keeps the guest clock frozen through a resumed countdown', async () => {
    const game = await start(); await vi.advanceTimersByTimeAsync(1000);
    game.guest.foregroundChanged(false); await flush(); await vi.advanceTimersByTimeAsync(3000);
    game.guest.foregroundChanged(true); game.host.resume(); game.guest.resume(); await flush();
    const elapsed = game.guest.view.snapshot!.elapsedMs;
    expect(game.guest.displayElapsed()).toBe(elapsed);
    await vi.advanceTimersByTimeAsync(3000);
    expect(game.guest.displayElapsed()).toBeLessThanOrEqual(elapsed + 100);
  });

  it('allows a new join attempt after cancelling an earlier in-flight connect', async () => {
    const game = pair(); await game.host.host('房主', '测试', config);
    const original = game.guestTransport.request.bind(game.guestTransport);
    let resolveOld!: (value: { connectionId: string }) => void; let connects = 0;
    vi.spyOn(game.guestTransport, 'request').mockImplementation(async <T>(action: string, payload?: Record<string, unknown>) => {
      if (action === 'connect' && ++connects === 1) return await new Promise<{ connectionId: string }>(resolve => { resolveOld = resolve; }) as T;
      return await original<T>(action, payload);
    });
    const firstJoin = game.guest.join('客人', '127.0.0.2', 42171); await flush();
    await game.guest.leave(); await game.guest.join('客人', '127.0.0.1', 42171); await flush();
    resolveOld({ connectionId: 'stale-connection' }); await firstJoin; await flush();
    expect(game.guest.view.phase).toBe('lobby'); expect(game.guest.view.players).toHaveLength(2);
  });

  it('publishes an interrupted result without winners when the host closes the room', async () => {
    const game = await start(); const leaving = game.host.leave(); await vi.advanceTimersByTimeAsync(150); await leaving; await flush();
    expect(game.host.view.phase).toBe('idle'); expect(game.guest.view.phase).toBe('finished');
    expect(game.guest.view.snapshot?.result?.reason).toBe('interrupted');
    expect(game.guest.view.snapshot?.result?.winnerId).toBeNull();
  });

  it('awards a forfeit only for an explicit guest leave', async () => {
    const game = await start(); const leaving = game.guest.leave(); await vi.advanceTimersByTimeAsync(150); await leaving; await flush();
    expect(game.guest.view.phase).toBe('idle'); expect(game.host.view.phase).toBe('finished');
    expect(game.host.view.snapshot?.result?.reason).toBe('forfeit');
    expect(game.host.view.snapshot?.result?.winnerId).toBe('host');
  });

  it('bounds repeated recoveries instead of allowing indefinite background pauses', async () => {
    const game = await start();
    for (let i = 0; i < 3; i++) {
      game.guest.foregroundChanged(false); await flush(); game.guest.foregroundChanged(true);
      game.host.resume(); game.guest.resume(); await flush(); await vi.advanceTimersByTimeAsync(3050);
      expect(game.host.view.phase).toBe('playing');
    }
    game.guest.foregroundChanged(false); await flush();
    expect(game.host.view.phase).toBe('finished'); expect(game.host.view.snapshot?.result?.reason).toBe('forfeit');
    expect(game.guest.view.phase).toBe('finished'); expect(game.guest.view.snapshot?.result?.winnerId).toBe('host');
  });

  it('freezes the host on duplicate native background events and resumes once without charging sleep time', async () => {
    const game = await start(); await vi.advanceTimersByTimeAsync(1000);
    game.hostTransport.emit({ type: 'lan-event', event: 'background' });
    game.hostTransport.emit({ type: 'lan-event', event: 'background' }); await flush();
    const elapsed = game.host.view.snapshot!.elapsedMs;
    await vi.advanceTimersByTimeAsync(5000);
    expect(game.host.view.phase).toBe('reconnecting'); expect(game.guest.view.phase).toBe('reconnecting');
    expect(game.host.view.snapshot!.elapsedMs).toBe(elapsed);
    game.guest.resume(); game.hostTransport.emit({ type: 'lan-event', event: 'foreground' });
    game.hostTransport.emit({ type: 'lan-event', event: 'foreground' }); game.host.resume(); await flush();
    await vi.advanceTimersByTimeAsync(3050);
    expect(game.host.view.phase).toBe('playing'); expect(game.guest.view.phase).toBe('playing');
    expect(game.host.view.snapshot!.elapsedMs).toBeLessThanOrEqual(elapsed + 100);
  });

  it('does not let a duplicated native connected event expire an authenticated peer', async () => {
    const game = await start(); const hello = game.network.last('HELLO', game.guestTransport);
    const hostId = game.network.links.get(hello.connectionId)!.targetId;
    game.hostTransport.emit({ type: 'lan-event', event: 'connected', connectionId: hostId });
    await vi.advanceTimersByTimeAsync(5100);
    expect(game.host.view.phase).toBe('playing'); expect(game.guest.view.phase).toBe('playing');
    expect(game.network.links.has(hostId)).toBe(true);
  });

  it('ignores an already accepted WELCOME replay during play', async () => {
    const game = await start(); const matchId = game.guest.view.snapshot!.matchId;
    game.network.replay(game.network.last('WELCOME', game.hostTransport)); await flush();
    expect(game.guest.view.phase).toBe('playing'); expect(game.guest.view.snapshot!.matchId).toBe(matchId);
  });

  it('keeps a completed result when the peer disconnects after result delivery', async () => {
    const game = await start(); await finish(game); const hostResult = game.host.view.snapshot!.result;
    game.network.disconnectAll(); await vi.advanceTimersByTimeAsync(25000);
    expect(game.host.view.phase).toBe('finished'); expect(game.guest.view.phase).toBe('finished');
    expect(game.host.view.snapshot!.result).toEqual(hostResult); expect(game.guest.view.snapshot!.result).toEqual(hostResult);
    expect(game.host.view.players.find(player => player.id === 'guest')?.connected).toBe(false);
    expect(game.guest.view.players.find(player => player.id === 'host')?.connected).toBe(false);
  });

  it('rejects a new client without the recovery token while a finished room retains its result', async () => {
    const game = await start(); await finish(game); game.network.disconnectAll();
    const stranger = new MemoryTransport(game.network), freshGuest = new LanSession(stranger, () => Date.now());
    await freshGuest.join('新窗口', '127.0.0.1', 42171); await flush();
    expect(freshGuest.view.phase).toBe('closed'); expect(freshGuest.view.error).toContain('恢复身份');
    expect(game.host.view.phase).toBe('finished');
  });

  it('drops malformed JSON from an unknown candidate without disturbing the authenticated match', async () => {
    const game = await start(), stranger = new MemoryTransport(game.network); const result = game.network.connect(stranger);
    const hostId = game.network.links.get(result.connectionId)!.targetId;
    game.hostTransport.emit({ type: 'lan-event', event: 'message', connectionId: hostId, message: '{broken' }); await flush();
    expect(game.network.links.has(result.connectionId)).toBe(false);
    expect(game.host.view.phase).toBe('playing'); expect(game.guest.view.phase).toBe('playing');
  });

  it('freezes instead of catching up gameplay after a scheduler stall with no lifecycle event', async () => {
    const game = await start(); await vi.advanceTimersByTimeAsync(1000);
    const elapsed = game.host.view.snapshot!.elapsedMs, revisions = game.host.view.snapshot!.players.host.boardRevision;
    vi.setSystemTime(Date.now() + 5000); await vi.advanceTimersByTimeAsync(50); await flush();
    expect(game.host.view.phase).toBe('reconnecting');
    expect(game.host.view.snapshot!.elapsedMs).toBe(elapsed);
    expect(game.host.view.snapshot!.players.host.boardRevision).toBe(revisions);
  });

  it('batches both battle inputs at one authoritative tick and delivers their committed presentation once', async () => {
    const game = await start(pair(), { ...config, mode: 'battle' });
    game.guest.shoot(0); game.host.shoot(0); await flush();
    expect(game.host.view.pendingShot).toBe(true); expect(game.guest.view.pendingShot).toBe(true);
    expect(game.host.view.snapshot!.players.host.totalShots).toBe(0);
    expect(game.host.view.snapshot!.players.guest.totalShots).toBe(0);
    const shot = game.network.last('SHOT', game.guestTransport); game.network.replay(shot); await flush();
    await vi.advanceTimersByTimeAsync(50);
    expect(game.host.view.pendingShot).toBe(false); expect(game.guest.view.pendingShot).toBe(false);
    expect(game.host.view.snapshot!.players.host.totalShots).toBe(1);
    expect(game.host.view.snapshot!.players.guest.totalShots).toBe(1);
    const events = game.host.view.presentationEvents.filter(event => event.type === 'shot-resolved');
    expect(events).toHaveLength(2); expect(events[0].atMs).toBe(events[1].atMs);
    expect(game.guest.view.presentationEvents).toEqual(game.host.view.presentationEvents);
    expect(game.guest.view.snapshot).toEqual(game.host.view.snapshot);
    const state = game.network.last('STATE', game.hostTransport), sequences = game.guest.view.presentationEvents.map(event => event.eventSeq);
    game.network.replay(shot); game.network.replay(state); await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(game.host.view.snapshot!.players.guest.totalShots).toBe(1);
    expect(game.guest.view.presentationEvents.map(event => event.eventSeq)).toEqual(sequences);
  });

  it('discards uncommitted battle inputs on background freeze rather than replaying them after recovery', async () => {
    const game = await start(pair(), { ...config, mode: 'battle' });
    game.host.shoot(0); game.guest.shoot(0); await flush();
    game.guest.foregroundChanged(false); await flush(); await vi.advanceTimersByTimeAsync(1000);
    expect(game.host.view.phase).toBe('reconnecting');
    expect(game.host.view.snapshot!.players.host.totalShots).toBe(0); expect(game.host.view.snapshot!.players.guest.totalShots).toBe(0);
    game.guest.foregroundChanged(true); game.host.resume(); game.guest.resume(); await flush(); await vi.advanceTimersByTimeAsync(3100);
    expect(game.host.view.snapshot!.players.host.totalShots).toBe(0); expect(game.host.view.snapshot!.players.guest.totalShots).toBe(0);
    expect(game.host.view.presentationEvents).toEqual([]); expect(game.guest.view.presentationEvents).toEqual([]);
    game.host.shoot(0); game.guest.shoot(0); await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(game.host.view.snapshot!.players.host.totalShots).toBe(1); expect(game.host.view.snapshot!.players.guest.totalShots).toBe(1);
    expect(game.guest.view.snapshot).toEqual(game.host.view.snapshot);
  });

  it('resumes battle at the snapshot event watermark without replaying old shots or presentation effects', async () => {
    const game = await start(pair(), { ...config, mode: 'battle' });
    game.guest.shoot(0); await flush(); await vi.advanceTimersByTimeAsync(50);
    const watermark = game.guest.view.snapshot!.eventSeq, oldState = game.network.last('STATE', game.hostTransport).packet;
    expect(watermark).toBeGreaterThan(0); expect(game.guest.view.presentationEvents.length).toBeGreaterThan(0);
    game.network.disconnectAll(); await vi.advanceTimersByTimeAsync(1600); await flush();
    expect(game.guest.view.presentationEvents).toEqual([]); expect(game.guest.view.snapshot!.eventSeq).toBe(watermark);
    game.network.replay(game.network.last('WELCOME', game.hostTransport), oldState); await flush();
    expect(game.guest.view.presentationEvents).toEqual([]);
    game.host.resume(); game.guest.resume(); await flush(); await vi.advanceTimersByTimeAsync(4700);
    game.guest.shoot(23000); await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(game.host.view.snapshot!.players.guest.totalShots).toBe(2);
    expect(game.guest.view.presentationEvents.length).toBeGreaterThan(0);
    expect(game.guest.view.presentationEvents.every(event => event.eventSeq > watermark)).toBe(true);
    expect(game.guest.view.snapshot).toEqual(game.host.view.snapshot);
  });

  it.each(['score', 'battle'] as const)('starts four independent %s players with stable identities and synchronized boards', async mode => {
    const game = await group(4, mode), ids = game.sessions.map(session => session.view.selfId);
    expect(new Set(ids).size).toBe(4); expect(game.host.view.config.capacity).toBe(4);
    expect(game.host.view.snapshot!.playerIds).toEqual(ids);
    for (const session of game.sessions) session.shoot(0); await flush(); await vi.advanceTimersByTimeAsync(50);
    for (const playerId of ids) expect(game.host.view.snapshot!.players[playerId].totalShots).toBe(1);
    for (const session of game.sessions.slice(1)) {
      expect(session.view.snapshot!.players).toEqual(game.host.view.snapshot!.players);
      expect(Math.abs(session.view.snapshot!.elapsedMs - game.host.view.snapshot!.elapsedMs)).toBeLessThanOrEqual(50);
    }
    expect(game.network.messages.every(message => new TextEncoder().encode(message.message).length <= LAN_WIRE_TARGET_BYTES)).toBe(true);
  });

  it('starts three players without waiting for the fourth seat and rejects a fifth lobby member', async () => {
    const game = await group(4, 'score', false);
    const fifth = new LanSession(new MemoryTransport(game.network), () => Date.now());
    await fifth.join('第五人', '127.0.0.1', 42171); await flush(); expect(fifth.view.error).toContain('已满');
    const fourthId = game.sessions[3].view.selfId; game.host.kick(fourthId); await flush();
    expect(game.host.view.players).toHaveLength(3);
    for (const session of game.sessions.slice(0, 3)) session.ready(); await flush(); game.host.start(); await flush();
    expect(game.sessions.slice(0, 3).every(session => session.view.phase === 'countdown')).toBe(true);
  });

  it('requires every joined player to load before starting a four-person room', async () => {
    const game = await group(4, 'score', false); for (const session of game.sessions) session.ready(); await flush();
    game.network.blockedTypes.add('LOADED'); game.host.start(); await flush();
    const loaded = game.network.messages.filter(message => message.packet.type === 'LOADED'); expect(loaded).toHaveLength(3);
    game.network.replay(loaded[0]); game.network.replay(loaded[1]); await flush(); expect(game.host.view.phase).toBe('preparing');
    game.network.replay(loaded[2]); await flush(); expect(game.host.view.phase).toBe('countdown');
  });

  it.each([0, 1, 2, 3])('accepts a pause from seat %i only after every remaining vote', async requester => {
    const game = await group(); game.sessions[requester].requestPause('settings');
    expect(game.sessions[requester].view.notice).toContain('申请'); await flush();
    const request = game.host.view.pauseRequest!; expect(request.participantIds).toHaveLength(4);
    const voters = game.sessions.filter((_, index) => index !== requester);
    voters[0].decidePause(true); voters[1].decidePause(true); await flush(); expect(game.host.view.phase).toBe('playing');
    voters[2].decidePause(true); await flush();
    expect(game.sessions.every(session => session.view.phase === 'paused')).toBe(true);
    expect(game.sessions[requester].view.autoOpenSettings).toBe(true);
    expect(game.sessions.filter((_, index) => index !== requester).every(session => !session.view.autoOpenSettings)).toBe(true);
  });

  it('keeps rejection and cancellation terminal and ignores late or duplicate votes', async () => {
    const game = await group(); game.guest.requestPause(); await flush(); const requestId = game.host.view.pauseRequest!.requestId;
    game.sessions[2].decidePause(false); await flush();
    expect(game.sessions.every(session => session.view.pauseOutcome?.status === 'rejected')).toBe(true);
    game.sessions[3].decidePause(true, requestId); game.host.decidePause(true, requestId); await flush();
    expect(game.host.view.phase).toBe('playing'); expect(game.host.view.pauseRequest).toBeUndefined();
    game.guest.requestPause(); await flush(); expect(game.guest.view.notice).toContain('15 秒');
    await vi.advanceTimersByTimeAsync(15000); game.guest.requestPause(); await flush(); game.guest.cancelPause(); await flush();
    expect(game.host.view.pauseOutcome?.status).toBe('cancelled'); expect(game.host.view.phase).toBe('playing');
  });

  it('expires unvoted requests, gives lost-ack feedback, and does not auto-open stale settings intentions', async () => {
    const game = await group(); game.host.requestPause(); await flush();
    await vi.advanceTimersByTimeAsync(10000); expect(game.host.view.pauseOutcome?.status).toBe('expired');
    game.network.blockedTypes.add('ROOM'); game.network.blockedTypes.add('PAUSE_OUTCOME');
    game.guest.requestPause('settings'); await vi.advanceTimersByTimeAsync(2100);
    expect(game.guest.view.notice).toContain('尚未确认');
    const request = game.host.view.pauseRequest!;
    game.host.decidePause(true); game.sessions[2].decidePause(true, request.requestId); // Those clients never saw ROOM, so this vote does not count.
    await vi.advanceTimersByTimeAsync(8000);
    expect(game.guest.view.pauseOutcome?.status).toBe('failed'); expect(game.guest.view.autoOpenSettings).toBe(false);
    expect(game.guest.view.pauseRequest).toBeUndefined();
    const attempts = game.network.messages.filter(message => message.sender === game.guestTransport && message.packet.type === 'PAUSE_REQUEST').length;
    game.guest.requestPause(); await flush();
    expect(game.guest.view.notice).toContain('15 秒');
    expect(game.network.messages.filter(message => message.sender === game.guestTransport && message.packet.type === 'PAUSE_REQUEST')).toHaveLength(attempts);
  });

  it('keeps each client paused while its settings are open and requires a separate resume readiness step', async () => {
    const game = await group(); await unanimousPause(game.sessions, 2, 'settings');
    game.sessions[2].settingsChanged(true); await flush();
    for (const session of game.sessions) session.resume(); await flush(); expect(game.host.view.phase).toBe('paused');
    game.sessions[2].settingsChanged(false); await flush(); expect(game.host.view.phase).toBe('paused');
    game.sessions[2].resume(); await flush(); expect(game.sessions.every(session => session.view.phase === 'countdown')).toBe(true);
    expect(game.sessions.every(session => session.view.settingsOpen.length === 0)).toBe(true);
    const elapsed = game.host.view.snapshot!.elapsedMs; await vi.advanceTimersByTimeAsync(3050);
    expect(game.sessions.every(session => session.view.phase === 'playing')).toBe(true);
    expect(game.host.view.snapshot!.elapsedMs).toBeLessThanOrEqual(elapsed + 100);
  });

  it('withdraws ready when settings reopen and closes spectator settings during normal resume', async () => {
    const game = await group(); game.sessions[3].forfeit(); await flush(); await vi.advanceTimersByTimeAsync(50);
    await unanimousPause(game.sessions.slice(0, 3)); game.sessions[3].settingsChanged(true); await flush();
    game.guest.resume(); await flush(); game.guest.settingsChanged(true); await flush();
    expect(game.host.view.resumeReady).not.toContain(game.guest.view.selfId);
    game.guest.settingsChanged(false); for (const session of game.sessions.slice(0, 3)) session.resume(); await flush();
    expect(game.host.view.phase).toBe('countdown'); expect(game.sessions[3].view.forceCloseSettings).toBe(true);
    game.sessions[3].settingsChanged(false); await flush();
  });

  it('closes settings before a pause timeout and never starts behind a still-open settings panel', async () => {
    const game = await group(); await unanimousPause(game.sessions, 1, 'settings'); game.guest.settingsChanged(true); await flush();
    const elapsed = game.host.view.snapshot!.elapsedMs; await vi.advanceTimersByTimeAsync(60000);
    expect(game.host.view.phase).toBe('paused'); expect(game.guest.view.forceCloseSettings).toBe(true);
    expect(game.host.view.snapshot!.elapsedMs).toBe(elapsed);
    game.guest.settingsChanged(false); await flush(); expect(game.host.view.phase).toBe('countdown');
  });

  it('grants a full third pause after more than 120 seconds of previous pauses', async () => {
    const game = await group(); await unanimousPause(game.sessions, 0); await vi.advanceTimersByTimeAsync(63050);
    await unanimousPause(game.sessions, 1); await vi.advanceTimersByTimeAsync(63050);
    await unanimousPause(game.sessions, 2);
    expect(game.host.view.pauseRemainingMs).toBeGreaterThanOrEqual(59950);
    await vi.advanceTimersByTimeAsync(60000);
    expect(game.host.view.phase).toBe('countdown');
  });

  it('reconnects one of three guests to the same identity without replacing or exposing another token', async () => {
    const game = await group(), playerId = game.sessions[2].view.selfId;
    const hello = game.network.last('HELLO', game.transports[2]), oldToken = game.network.messages.find(message => message.packet.type === 'WELCOME' && message.packet.data.selfId === playerId)!.packet.data.token;
    game.network.disconnect(hello.connectionId); await vi.advanceTimersByTimeAsync(1600); await flush();
    expect(game.sessions[2].view.selfId).toBe(playerId); expect(game.host.view.players).toHaveLength(4);
    expect(game.network.last('HELLO', game.transports[2]).packet.data.token).toBe(oldToken);
    for (const session of game.sessions) session.resume(); await flush(); await vi.advanceTimersByTimeAsync(3050);
    expect(game.sessions.every(session => session.view.phase === 'playing')).toBe(true);
    expect(game.sessions.every(session => session.view.snapshot?.matchId === game.host.view.snapshot?.matchId)).toBe(true);
    const welcomes = game.network.messages.filter(message => message.packet.type === 'WELCOME');
    expect(new Set(welcomes.map(message => message.packet.data.token)).size).toBe(3);
  });

  it('keeps non-host eliminated spectators from freezing or voting in the ongoing match', async () => {
    const game = await group(4, 'battle'); game.sessions[3].forfeit(); await flush(); await vi.advanceTimersByTimeAsync(50);
    const spectatorId = game.sessions[3].view.selfId, player = game.host.view.snapshot!.players[spectatorId]; expect(player.sealed).toBe(true);
    game.sessions[3].requestPause(); await flush(); expect(game.host.view.pauseRequest).toBeUndefined();
    game.sessions[3].foregroundChanged(false); await flush(); expect(game.host.view.phase).toBe('playing');
    game.network.disconnect(game.network.last('HELLO', game.transports[3]).connectionId); await flush();
    expect(game.host.view.phase).toBe('playing'); expect(game.host.view.snapshot!.players[spectatorId]).toEqual(player);
    await unanimousPause(game.sessions.slice(0, 3)); expect(game.host.view.phase).toBe('paused');
  });

  it('lets a forfeiting host continue serving the other three players', async () => {
    const game = await group(4, 'battle'); game.host.forfeit(); await vi.advanceTimersByTimeAsync(50); await flush();
    expect(game.host.view.phase).toBe('playing'); expect(game.host.view.snapshot!.players.host.forfeited).toBe(true);
    game.sessions[2].shoot(0); await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(game.host.view.snapshot!.players[game.sessions[2].view.selfId].totalShots).toBe(1);
    expect(game.sessions[1].view.snapshot).toEqual(game.host.view.snapshot);
  });

  it('keeps an active pause vote intact when a non-host spectator backgrounds and disconnects', async () => {
    const game = await group(4, 'battle'); game.sessions[3].forfeit(); await flush(); await vi.advanceTimersByTimeAsync(50);
    game.host.requestPause(); await flush(); const request = game.host.view.pauseRequest!;
    expect(request.participantIds).toHaveLength(3);
    game.guest.decidePause(true, request.requestId); await flush();
    const votes = { ...game.host.view.pauseRequest!.votes };
    game.sessions[3].foregroundChanged(false); await flush();
    expect(game.host.view.pauseRequest?.requestId).toBe(request.requestId); expect(game.host.view.pauseRequest?.votes).toEqual(votes);
    expect(game.host.view.pauseOutcome).toBeUndefined(); expect(game.host.view.phase).toBe('playing');
    game.network.disconnect(game.network.last('HELLO', game.transports[3]).connectionId); await flush();
    expect(game.host.view.pauseRequest?.requestId).toBe(request.requestId); expect(game.host.view.pauseRequest?.votes).toEqual(votes);
    game.sessions[2].decidePause(true, request.requestId); await flush();
    expect(game.sessions.slice(0, 3).every(session => session.view.phase === 'paused')).toBe(true);
    expect(game.host.view.pauseOutcome?.status).toBe('approved');
  });

  it('commits simultaneous forfeits in one control batch without creating a transient winner', async () => {
    const game = await group(3, 'battle'); for (const session of game.sessions) session.forfeit(); await flush();
    await vi.advanceTimersByTimeAsync(50); expect(game.host.view.snapshot!.result?.winnerIds).toEqual([]);
    expect(game.sessions.every(session => session.view.snapshot?.result?.winnerIds.length === 0)).toBe(true);
  });

  it('forfeits only a timed-out guest and lets remaining players continue', async () => {
    const game = await group(), missing = game.sessions[3]; missing.foregroundChanged(false); await flush();
    await vi.advanceTimersByTimeAsync(23500);
    expect(game.host.view.snapshot!.players[missing.view.selfId].forfeited).toBe(true);
    expect(game.host.view.phase).toBe('playing'); expect(game.sessions[1].view.phase).toBe('playing');
    expect(game.host.view.snapshot!.status).toBe('playing');
  });

  it('serializes oversized UTF-8 control envelopes into bounded frames and reassembles atomically', async () => {
    const game = await lobby(); game.host.view.roomName = '中文🙂'.repeat(18000); game.host.setConfig({ ...config, capacity: 4 }); await flush();
    const chunks = game.network.messages.filter(message => message.packet.type === 'CHUNK'); expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(message => new TextEncoder().encode(message.message).length <= LAN_WIRE_TARGET_BYTES)).toBe(true);
    expect(game.guest.view.roomName).toBe(Array.from(game.host.view.roomName).slice(0, 24).join(''));
    expect(game.guest.view.phase).toBe('lobby');
  });

  it('preserves all four large-clear animations and fits every real wire message within 60 KiB', async () => {
    const game = await group(4, 'battle'), snapshot = game.host.view.snapshot!;
    for (const playerId of snapshot.playerIds) { const player = snapshot.players[playerId]; player.state = { ...player.state,
      board: Array.from({ length: 19 }, (_, row) => Array(14).fill(row < 17 ? 0 : null)), currentColor: 0, nextColor: 0 }; }
    // Publish through the real session resync path before issuing one shot per seat.
    game.network.replay(game.network.last('HELLO', game.guestTransport), { ...game.network.last('HELLO', game.guestTransport).packet, type: 'RESYNC', matchId: snapshot.matchId, roomId: game.host.view.roomId, data: {} }); await flush();
    for (const session of game.sessions) session.shoot(0); await flush(); await vi.advanceTimersByTimeAsync(50);
    for (const session of game.sessions) expect(new Set(session.view.presentationEvents.filter(event => event.type === 'shot-resolved').map(event => event.playerId)).size).toBe(4);
    expect(game.network.messages.every(message => new TextEncoder().encode(message.message).length <= LAN_WIRE_TARGET_BYTES)).toBe(true);
    for (const session of game.sessions.slice(1)) expect(session.view.snapshot).toEqual(game.host.view.snapshot);
  });

  it('will not start a prepared room while any joined player is editing settings', async () => {
    const game = await group(3, 'score', false); for (const session of game.sessions) session.ready(); await flush();
    game.guest.settingsChanged(true); await flush(); game.host.start(); await flush();
    expect(game.host.view.phase).toBe('lobby'); expect(game.host.view.notice).toContain('关闭');
    game.guest.settingsChanged(false); await flush(); game.host.start(); await flush(); expect(game.host.view.phase).toBe('countdown');
  });

  it('does not reset the pause deadline when a participant reconnects from settings', async () => {
    const game = await group(); await unanimousPause(game.sessions); await vi.advanceTimersByTimeAsync(45000);
    game.guest.foregroundChanged(false); await flush(); await vi.advanceTimersByTimeAsync(5000);
    game.guest.foregroundChanged(true); await flush();
    expect(game.host.view.pauseRemainingMs).toBeLessThanOrEqual(10000);
    await vi.advanceTimersByTimeAsync(10000); expect(game.host.view.phase).toBe('countdown');
  });

  it('keeps gameplay frozen if settings-close acknowledgements are missing and forfeits only that guest', async () => {
    const game = await group(); await unanimousPause(game.sessions);
    const target = game.transports[3], original = target.request.bind(target);
    vi.spyOn(target, 'request').mockImplementation(async <T>(action: string, payload?: Record<string, unknown>) => {
      if (action === 'send' && JSON.parse(String(payload?.message)).type === 'SETTINGS') return {} as T;
      return await original<T>(action, payload);
    });
    await vi.advanceTimersByTimeAsync(63050); expect(game.host.view.phase).toBe('reconnecting');
    const elapsed = game.host.view.snapshot!.elapsedMs; await vi.advanceTimersByTimeAsync(10000);
    expect(game.host.view.snapshot!.elapsedMs).toBe(elapsed);
    await vi.advanceTimersByTimeAsync(14000);
    expect(game.host.view.snapshot!.players[game.sessions[3].view.selfId].forfeited).toBe(true);
    expect(game.host.view.phase).toBe('playing');
  });

  it('gives healthy peers the full closing acknowledgement window after another player times out', async () => {
    const game = await group(); const transport = game.transports[2], original = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation(async <T>(action: string, payload?: Record<string, unknown>) => {
      if (action === 'send' && JSON.parse(String(payload?.message)).type === 'SETTINGS') await new Promise(resolve => setTimeout(resolve, 180));
      return await original<T>(action, payload);
    });
    game.sessions[3].foregroundChanged(false); await flush(); await vi.advanceTimersByTimeAsync(20100);
    expect(game.host.view.snapshot!.players[game.sessions[2].view.selfId].forfeited).toBe(false);
    expect(game.sessions[2].view.snapshot!.status).toBe('playing');
    await vi.advanceTimersByTimeAsync(3300);
    expect(game.host.view.phase).toBe('playing'); expect(game.sessions[2].view.phase).toBe('playing');
    expect(game.host.view.snapshot!.players[game.sessions[2].view.selfId].forfeited).toBe(false);
    expect(game.host.view.snapshot!.players[game.sessions[3].view.selfId].forfeited).toBe(true);
  });

  it('deduplicates a repeated HELLO on an authenticated connection without allocating another seat', async () => {
    const game = await lobby(); const hello = game.network.last('HELLO', game.guestTransport);
    game.network.replay(hello); game.network.replay(hello); await flush();
    expect(game.host.view.players).toHaveLength(2); expect(game.guest.view.selfId).toBe('guest');
  });

  it('resets presentation watermarks for a rematch with the same stable player ids', async () => {
    const game = await start(); game.host.shoot(0); game.guest.shoot(0); await flush();
    expect(game.host.view.presentationEvents.length).toBeGreaterThan(0);
    await finish(game); await rematch(game); game.host.shoot(0); game.guest.shoot(0); await flush();
    expect(game.host.view.presentationEvents.filter(event => event.type === 'shot-resolved')).toHaveLength(2);
    expect(game.guest.view.presentationEvents.filter(event => event.type === 'shot-resolved')).toHaveLength(2);
  });

  it('keeps a terminal result when old same-epoch pause and settings-close packets are replayed', async () => {
    const game = await start(); await unanimousPause([game.host, game.guest]);
    const frozen = game.network.last('FREEZE', game.hostTransport);
    game.network.blockedTypes.add('SETTINGS'); game.host.resume(); game.guest.resume(); await flush();
    const close = game.network.last('CLOSE_SETTINGS', game.hostTransport);
    game.host.forfeit(); await vi.advanceTimersByTimeAsync(50); await flush();
    expect(game.guest.view.phase).toBe('finished'); const result = game.guest.view.snapshot!.result;
    game.network.replay(frozen); game.network.replay(close); await flush();
    expect(game.guest.view.phase).toBe('finished'); expect(game.guest.view.snapshot!.result).toEqual(result);
    expect(game.guest.view.autoOpenSettings).toBe(false);
  });

  it('does not restart an active countdown from a replayed START after play has begun', async () => {
    const game = await start(); const started = game.network.last('START', game.hostTransport);
    await vi.advanceTimersByTimeAsync(1000); game.network.replay(started); await flush(); expect(game.guest.view.phase).toBe('playing');
  });

  it('cancels uncommitted shots for host and guest forfeits while the other players keep playing', async () => {
    const game = await group(4, 'battle'); game.host.shoot(0); game.guest.shoot(0); await flush();
    expect(game.host.view.pendingShot).toBe(true); expect(game.guest.view.pendingShot).toBe(true);
    game.host.forfeit(); game.guest.forfeit(); await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(game.host.view.phase).toBe('playing'); expect(game.host.view.pendingShot).toBe(false); expect(game.guest.view.pendingShot).toBe(false);
    expect(game.host.view.snapshot!.players.host.totalShots).toBe(0); expect(game.host.view.snapshot!.players.guest.totalShots).toBe(0);
  });

  it('can enter address browsing without starting discovery, while preserving opt-in and default scans', async () => {
    const game = pair(), request = vi.spyOn(game.guestTransport, 'request');
    await game.guest.browse({ discover: false });
    expect(game.guest.view.phase).toBe('browsing');
    expect(game.guest.view.discovery.status).toBe('cancelled');
    expect(request.mock.calls.filter(([action]) => action === 'discover')).toHaveLength(0);
    game.guest.foregroundChanged(false); game.guest.foregroundChanged(true); await flush();
    expect(request.mock.calls.filter(([action]) => action === 'discover')).toHaveLength(0);
    await game.guest.refreshDiscovery();
    expect(request.mock.calls.filter(([action]) => action === 'discover')).toHaveLength(1);
    game.guest.foregroundChanged(false); game.guest.foregroundChanged(true); await flush();
    expect(request.mock.calls.filter(([action]) => action === 'discover')).toHaveLength(2);
    await game.guest.browse();
    expect(request.mock.calls.filter(([action]) => action === 'discover')).toHaveLength(3);
  });

  it('resumes default browsing discovery once and clears its intent on a new address-only browse', async () => {
    const game = pair(), request = vi.spyOn(game.guestTransport, 'request');
    await game.guest.browse();
    expect(request.mock.calls.filter(([action]) => action === 'discover')).toHaveLength(1);
    game.guest.foregroundChanged(false); game.guest.foregroundChanged(true); game.guest.foregroundChanged(true); await flush();
    expect(request.mock.calls.filter(([action]) => action === 'discover')).toHaveLength(2);
    await game.guest.browse({ discover: false });
    game.guest.foregroundChanged(false); game.guest.foregroundChanged(true); await flush();
    expect(request.mock.calls.filter(([action]) => action === 'discover')).toHaveLength(2);
  });

  it.each([true, false])('remembers a browsing discovery request made in the background (default: %s)', async defaultDiscovery => {
    const game = pair(), request = vi.spyOn(game.guestTransport, 'request');
    game.guest.foregroundChanged(false);
    await game.guest.browse({ discover: defaultDiscovery });
    if (!defaultDiscovery) await game.guest.refreshDiscovery();
    expect(request.mock.calls.filter(([action]) => action === 'discover')).toHaveLength(0);
    game.guest.foregroundChanged(true); await flush();
    expect(request.mock.calls.filter(([action]) => action === 'discover')).toHaveLength(1);
  });

  it.each(['pause', 'settings'] as const)('lets the same guest complete three %s pauses with a fresh full single-pause limit', async reason => {
    const game = await start();
    for (let attempt = 0; attempt < 3; attempt++) {
      await unanimousPause([game.host, game.guest], 1, reason);
      await vi.advanceTimersByTimeAsync(PAUSE_RULES.maxPauseMs - 50);
      expect(game.host.view.phase).toBe('paused');
      await vi.advanceTimersByTimeAsync(3050);
      expect(game.host.view.phase).toBe('playing');
      game.guest.requestPause(reason === 'pause' ? 'settings' : 'pause'); await flush();
      expect(game.host.view.pauseRequest).toBeUndefined(); expect(game.guest.view.notice).toContain('15 秒');
      if (attempt < 2) {
        await vi.advanceTimersByTimeAsync(PAUSE_RULES.cooldownMs - 1);
        game.guest.requestPause(reason); await flush();
        expect(game.host.view.pauseRequest).toBeUndefined(); expect(game.guest.view.notice).toContain('1 秒');
        await vi.advanceTimersByTimeAsync(1);
      }
    }
  });

  it.each(['rejected', 'cancelled', 'expired'] as const)('starts one shared cooldown at a %s outcome and does not extend it on retries', async status => {
    const game = await start(); game.guest.requestPause(); await flush();
    const original = game.network.last('PAUSE_REQUEST', game.guestTransport);
    if (status === 'rejected') game.host.decidePause(false);
    else if (status === 'cancelled') game.guest.cancelPause();
    else await vi.advanceTimersByTimeAsync(PAUSE_RULES.voteMs);
    await flush(); expect(game.host.view.pauseOutcome?.status).toBe(status);
    await vi.advanceTimersByTimeAsync(5000);
    for (let index = 0; index < 70; index++) { game.guest.requestPause(index % 2 ? 'pause' : 'settings'); await flush(); }
    expect(game.guest.view.notice).toContain('10 秒');
    await vi.advanceTimersByTimeAsync(5000);
    game.network.replay(original); await flush();
    expect(game.host.view.pauseRequest).toBeUndefined();
    await vi.advanceTimersByTimeAsync(4999);
    game.guest.requestPause('settings'); await flush();
    expect(game.host.view.pauseRequest).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    game.network.replay(original); await flush();
    expect(game.host.view.pauseRequest).toBeUndefined();
    game.guest.requestPause('settings'); await flush();
    expect(game.host.view.pauseRequest?.reason).toBe('settings');
  });

  it('preserves the successful requester cooldown across a same-identity reconnect', async () => {
    const game = await start(); await unanimousPause([game.host, game.guest], 1);
    game.host.resume(); game.guest.resume(); await flush(); await vi.advanceTimersByTimeAsync(3000);
    const playerId = game.guest.view.selfId;
    game.network.disconnectAll(); await vi.advanceTimersByTimeAsync(1600); await flush();
    expect(game.guest.view.selfId).toBe(playerId);
    game.host.resume(); game.guest.resume(); await flush(); await vi.advanceTimersByTimeAsync(3050);
    expect(game.host.view.phase).toBe('playing');
    game.guest.requestPause('settings'); await flush();
    expect(game.host.view.pauseRequest).toBeUndefined(); expect(game.guest.view.notice).toMatch(/等待 \d+ 秒/);
    await vi.advanceTimersByTimeAsync(11000);
    game.guest.requestPause('settings'); await flush();
    expect(game.host.view.pauseRequest?.requesterId).toBe(playerId);
  });

  it('does not charge another player a cooldown merely for arriving during an existing vote', async () => {
    const game = await group(3); game.guest.requestPause(); await flush();
    const original = game.network.last('PAUSE_REQUEST', game.guestTransport);
    const second = game.sessions[2], transport = game.transports[2];
    const secondConnection = game.network.last('HELLO', transport).connectionId;
    await transport.request('send', { connectionId: secondConnection, message: JSON.stringify({ ...original.packet,
      data: { ...original.packet.data, requestId: crypto.randomUUID(), reason: 'settings' } }) });
    await flush();
    expect(game.host.view.pauseRequest?.requestId).toBe(original.packet.data.requestId);
    game.guest.cancelPause(); await flush();
    second.requestPause('settings'); await flush();
    expect(game.host.view.pauseRequest?.requesterId).toBe(second.view.selfId);
  });

  it('clears the previous match pause cooldown when the same stable players start a rematch', async () => {
    const game = await start(); await finish(game); await rematch(game);
    await unanimousPause([game.host, game.guest], 1);
    game.host.resume(); game.guest.resume(); await flush(); await vi.advanceTimersByTimeAsync(3000);
    game.host.forfeit(); await vi.advanceTimersByTimeAsync(50); await flush();
    expect(game.host.view.phase).toBe('finished');
    await rematch(game);
    game.guest.requestPause('settings'); await flush();
    expect(game.host.view.pauseRequest?.requesterId).toBe(game.guest.view.selfId);
  });

  it('advances host and guest presentation smoothly between rule ticks without changing their authority or fire gates', async () => {
    const game = await start(pair(73000));
    const hostSnapshot = game.host.view.snapshot, guestSnapshot = game.guest.view.snapshot;
    const hostGate = game.host.displayElapsed(), guestGate = game.guest.displayElapsed();
    const host = game.host.presentationTime(), guest = game.guest.presentationTime();
    await vi.advanceTimersByTimeAsync(8);
    expect(game.host.presentationTime()).toBe(host + 8); expect(game.guest.presentationTime()).toBe(guest + 8);
    await vi.advanceTimersByTimeAsync(9);
    expect(game.host.presentationTime()).toBe(host + 17); expect(game.guest.presentationTime()).toBe(guest + 17);
    expect(game.host.view.snapshot).toBe(hostSnapshot); expect(game.guest.view.snapshot).toBe(guestSnapshot);
    expect(game.host.displayElapsed()).toBe(hostGate);
    expect(game.guest.displayElapsed()).toBe(guestGate + 17);
  });

  it('freezes presentation during pause, recovery and countdown and rebases before resuming play', async () => {
    const game = await start(); await unanimousPause([game.host, game.guest]);
    const frozen = game.host.presentationTime();
    await vi.advanceTimersByTimeAsync(1000);
    expect(game.host.presentationTime()).toBe(frozen); expect(game.guest.presentationTime()).toBe(frozen);
    game.host.resume(); game.guest.resume(); await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(game.host.presentationTime()).toBe(frozen); expect(game.guest.presentationTime()).toBe(frozen);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(17);
    expect(game.host.presentationTime()).toBe(frozen + 17);
    game.guest.foregroundChanged(false); await flush();
    const recovering = game.host.presentationTime();
    await vi.advanceTimersByTimeAsync(1000);
    expect(game.host.presentationTime()).toBe(recovering); expect(game.guest.presentationTime()).toBe(recovering);
    game.guest.foregroundChanged(true); await flush(); game.host.resume(); game.guest.resume(); await flush();
    await vi.advanceTimersByTimeAsync(3050);
    expect(game.host.presentationTime()).toBeLessThanOrEqual(recovering + 100);
  });

  it('limits finished presentation to two seconds and rebases it for the next match', async () => {
    const game = await start();
    await finish(game);
    const before = game.host.presentationTime();
    expect(before).toBeGreaterThan(game.host.view.snapshot!.elapsedMs);
    await vi.advanceTimersByTimeAsync(3000);
    const end = game.host.view.snapshot!.startedAtMs + game.host.view.snapshot!.elapsedMs;
    expect(game.host.presentationTime()).toBe(end + 2000); expect(game.guest.presentationTime()).toBe(end + 2000);
    await vi.advanceTimersByTimeAsync(1000); expect(game.host.presentationTime()).toBe(end + 2000);
    await rematch(game);
    expect(game.host.presentationTime()).toBeLessThan(100); expect(game.guest.presentationTime()).toBeLessThan(100);
  });

  it('rejects the concrete 5.1 rules fingerprint on the unchanged v3 wire before allocating a seat', async () => {
    expect(LAN_PROTOCOL_VERSION).toBe(3); expect(LAN_CONTENT_HASH).toBe('f942c2f9'); expect(LAN_RULES_HASH).not.toBe('4e2a4139');
    const game = pair(); await game.host.host('房主', '测试', config);
    game.network.blockedTypes.add('HELLO'); await game.guest.join('客人', '127.0.0.1', 42171); await flush();
    const hello = game.network.last('HELLO');
    game.network.replay(hello, { ...hello.packet, data: { ...hello.packet.data, rulesHash: '4e2a4139' } }); await flush();
    expect(game.host.view.players).toHaveLength(1);
    expect(game.guest.view.phase).toBe('closed'); expect(game.guest.view.error).toContain('不兼容');
  });

  it('refuses a 5.1 host welcome instead of accepting its old pause and random rules', async () => {
    const game = pair(); await game.host.host('房主', '测试', config);
    game.network.blockedTypes.add('WELCOME'); await game.guest.join('客人', '127.0.0.1', 42171); await flush();
    const welcome = game.network.last('WELCOME', game.hostTransport);
    game.network.replay(welcome, { ...welcome.packet, data: { ...welcome.packet.data, rulesHash: '4e2a4139' } }); await flush();
    expect(game.guest.view.phase).toBe('closed'); expect(game.guest.view.error).toContain('不兼容');
    expect(game.guest.view.snapshot).toBeUndefined();
  });
});
