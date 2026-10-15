import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanSession, type RoomConfig } from '../src/lan/session';
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

describe('LAN two-session integration over an asynchronous serialized transport', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
    vi.stubGlobal('window', { dispatchEvent: () => true, localStorage });
    vi.stubGlobal('localStorage', localStorage);
    vi.useFakeTimers(); vi.setSystemTime(100000);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('requires both ready and loaded, then starts equal boards despite different local clock origins', async () => {
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
    expect(game.host.view.snapshot!.players.host.state).toEqual(game.guest.view.snapshot!.players.guest.state);
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
    game.host.setConfig({ difficultyId: 'hard', durationMs: 300000 }); await flush();
    expect(game.guest.view.config).toEqual({ difficultyId: 'hard', durationMs: 300000 });
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
    await vi.advanceTimersByTimeAsync(30000);
    expect(game.host.view.phase).toBe('countdown'); expect(game.host.view.snapshot!.elapsedMs).toBe(elapsed);
    await vi.advanceTimersByTimeAsync(3050); game.guest.requestPause(); await flush();
    expect(game.host.view.pauseRequester).toBeUndefined(); expect(game.guest.view.notice).toContain('一次暂停');
  });

  it('reconnects with the same identity and confirmed board, then discards commands from the old connection epoch', async () => {
    const game = await start(); game.guest.shoot(0); await flush();
    const oldShot = game.network.last('SHOT').packet;
    const oldId = game.host.view.snapshot!.matchId, oldShots = game.host.view.snapshot!.players.guest.totalShots;
    game.network.disconnectAll(); expect(game.host.view.phase).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1600); await flush();
    expect(game.guest.view.snapshot!.matchId).toBe(oldId);
    expect(game.guest.view.snapshot!.players.guest.totalShots).toBe(oldShots);
    game.host.resume(); game.guest.resume(); await flush(); await vi.advanceTimersByTimeAsync(3050);
    const hello = game.network.last('HELLO', game.guestTransport);
    game.network.replay(hello, oldShot); await flush();
    expect(game.host.view.snapshot!.players.guest.totalShots).toBe(oldShots);
    await vi.advanceTimersByTimeAsync(1600); // Logical shot cooldown also freezes during recovery.
    game.guest.shoot(-23000); await flush();
    expect(game.host.view.snapshot!.players.guest.totalShots).toBe(oldShots + 1);
    expect(game.guest.view.snapshot).toEqual(game.host.view.snapshot);
  });

  it('marks an unrecoverable connection as interrupted without guessing a winner', async () => {
    const game = await start(); game.network.online = false; game.network.disconnectAll();
    await vi.advanceTimersByTimeAsync(20500);
    expect(game.host.view.snapshot!.result?.reason).toBe('interrupted');
    expect(game.host.view.snapshot!.result?.winnerId).toBeNull();
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

  it('preserves the host-confirmed forfeit result when the host explicitly leaves', async () => {
    const game = await start(); const leaving = game.host.leave(); await vi.advanceTimersByTimeAsync(150); await leaving; await flush();
    expect(game.host.view.phase).toBe('idle'); expect(game.guest.view.phase).toBe('finished');
    expect(game.guest.view.snapshot?.result?.reason).toBe('forfeit');
    expect(game.guest.view.snapshot?.result?.winnerId).toBe('guest');
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
    expect(game.host.view.phase).toBe('finished'); expect(game.host.view.snapshot?.result?.reason).toBe('interrupted');
    expect(game.guest.view.phase).toBe('finished'); expect(game.guest.view.snapshot?.result?.winnerId).toBeNull();
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
});
