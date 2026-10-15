import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanSession } from '../src/lan/session';
import { LAN_CONTENT_HASH, LAN_PROTOCOL_VERSION, LAN_RULES_HASH } from '../src/lan/protocol';
import type { DiscoveredRoom, LanEvent, LanTransport } from '../src/lan/transport';

class DiscoveryTransport implements LanTransport {
  readonly available = true;
  listeners = new Set<(event: LanEvent) => void>();
  calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
  discovery?: () => Promise<void>;
  subscribe(listener: (event: LanEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: LanEvent): void { for (const listener of this.listeners) listener(event); }
  async request<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ action, payload });
    if (action === 'discover') await this.discovery?.();
    return {} as T;
  }
  async close(): Promise<void> { this.listeners.clear(); }
}
function browser() {
  const transport = new DiscoveryTransport(), session = new LanSession(transport, () => Date.now());
  return { transport, session };
}
function room(overrides: Partial<DiscoveredRoom> = {}): DiscoveredRoom {
  return { name: '测试房间', address: '192.168.8.2', port: 42171,
    metadata: { roomId: 'room-one', protocolVersion: LAN_PROTOCOL_VERSION, rulesHash: LAN_RULES_HASH, contentHash: LAN_CONTENT_HASH,
      mode: 'battle', platform: 'Windows', players: 1, phase: 'lobby' }, ...overrides };
}
const discovered = (scanId: string, value = room()): LanEvent => ({ type: 'lan-event', event: 'discovered', scanId, room: value });
const status = (scanId: string, value: LanEvent['status'], extra: Partial<LanEvent> = {}): LanEvent => ({ type: 'lan-event', event: 'discovery-status', scanId, status: value, ...extra });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('LAN discovery session lifecycle and untrusted advertisements', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('keeps a scan running after native startup acknowledgement until an explicit terminal event', async () => {
    const { transport, session } = browser(); await session.browse();
    const scanId = session.view.discovery.scanId;
    expect(session.view.phase).toBe('browsing'); expect(session.view.discovery.status).toBe('scanning');
    expect(transport.calls.at(-1)).toEqual({ action: 'discover', payload: { scanId, recentAddresses: [] } });
    transport.emit(status(scanId, 'scanning', { paths: 2, sent: 6, received: 3, errors: 1, diagnostics: ['bound:192.168.8.3'] }));
    expect(session.view.discovery).toMatchObject({ paths: 2, sent: 6, received: 3, errors: 1 });
    transport.emit(status(scanId, 'completed')); expect(session.view.discovery.status).toBe('completed');
    transport.emit(status(scanId, 'scanning', { sent: 99 }));
    expect(session.view.discovery.status).toBe('completed'); expect(session.view.discovery.sent).toBe(6);
  });

  it('preserves old rooms on refresh and ignores every stale-scan callback', async () => {
    const { transport, session } = browser(); await session.browse(); const old = session.view.discovery.scanId;
    transport.emit(discovered(old)); await session.refreshDiscovery(); const current = session.view.discovery.scanId;
    expect(current).not.toBe(old); expect(session.view.rooms).toHaveLength(1); expect(session.view.rooms[0].seenScanId).toBe(old);
    transport.emit(status(old, 'failed', { error: 'late failure', sent: 99 }));
    transport.emit(discovered(old, room({ name: '过期回应' })));
    expect(session.view.discovery.status).toBe('scanning'); expect(session.view.error).toBe('');
    expect(session.view.rooms[0].name).toBe('测试房间');
    transport.emit(discovered(current, room({ name: '本轮确认' })));
    expect(session.view.rooms[0].seenScanId).toBe(current); expect(session.view.rooms[0].name).toBe('本轮确认');
  });

  it('cancels normally and rejects late results and terminal errors from that scan', async () => {
    const { transport, session } = browser(); await session.browse(); const scanId = session.view.discovery.scanId;
    await session.stopDiscovery(); expect(transport.calls.at(-1)?.action).toBe('stopDiscovery');
    transport.emit(discovered(scanId)); transport.emit(status(scanId, 'failed', { error: 'socket closed' }));
    expect(session.view.discovery.status).toBe('cancelled'); expect(session.view.rooms).toEqual([]); expect(session.view.error).toBe('');
  });

  it('ignores a delayed rejected discover acknowledgement after the player has cancelled', async () => {
    const { transport, session } = browser(); let reject!: (reason: Error) => void;
    transport.discovery = () => new Promise<void>((_, fail) => { reject = fail; });
    const browsing = session.browse(); await flush(); await session.stopDiscovery();
    reject(new Error('delayed startup failure')); await browsing;
    expect(session.view.discovery.status).toBe('cancelled'); expect(session.view.error).toBe('');
  });

  it('bounds a missing native terminal callback with the frontend watchdog and rejects later rooms', async () => {
    const { transport, session } = browser(); await session.browse(); const scanId = session.view.discovery.scanId;
    await vi.advanceTimersByTimeAsync(8500);
    expect(session.view.discovery.status).toBe('completed'); expect(transport.calls.at(-1)?.action).toBe('stopDiscovery');
    transport.emit(discovered(scanId)); expect(session.view.rooms).toEqual([]);
  });

  it('cancels in the background and creates exactly one fresh scan when foreground returns', async () => {
    const { transport, session } = browser(); await session.browse(); const old = session.view.discovery.scanId;
    transport.emit({ type: 'lan-event', event: 'background' }); await flush();
    expect(session.view.discovery.status).toBe('cancelled');
    transport.emit({ type: 'lan-event', event: 'foreground' });
    transport.emit({ type: 'lan-event', event: 'foreground' }); await flush();
    expect(session.view.discovery.scanId).not.toBe(old);
    expect(transport.calls.filter(call => call.action === 'discover')).toHaveLength(2);
  });

  it('aggregates interfaces under a room identity while retaining separate rooms on one endpoint', async () => {
    const { transport, session } = browser(); await session.browse(); const scanId = session.view.discovery.scanId;
    transport.emit(discovered(scanId)); transport.emit(discovered(scanId, room({ address: '192.168.9.2', port: 53000 })));
    transport.emit(discovered(scanId, room({ address: '192.168.9.2', port: 53000 })));
    expect(session.view.rooms).toHaveLength(1);
    expect(session.view.rooms[0].endpoints).toEqual([{ address: '192.168.8.2', port: 42171 }, { address: '192.168.9.2', port: 53000 }]);
    const other = room(); other.metadata.roomId = 'room-two'; transport.emit(discovered(scanId, other));
    expect(session.view.rooms).toHaveLength(2);
  });

  it('expires an unconfirmed room after 30 seconds even after scanning has ended', async () => {
    const { transport, session } = browser(); await session.browse(); const scanId = session.view.discovery.scanId;
    transport.emit(discovered(scanId)); transport.emit(status(scanId, 'completed'));
    await vi.advanceTimersByTimeAsync(12000); expect(session.roomAgeMs(session.view.rooms[0])).toBe(12000);
    await vi.advanceTimersByTimeAsync(17950); expect(session.view.rooms).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50); expect(session.view.rooms).toEqual([]);
  });

  it('caps rooms, per-room endpoints and diagnostic text received from native discovery', async () => {
    const { transport, session } = browser(); await session.browse(); const scanId = session.view.discovery.scanId;
    for (let i = 1; i <= 40; i++) { const value = room(); value.metadata.roomId = `room-${i}`; transport.emit(discovered(scanId, value)); }
    expect(session.view.rooms).toHaveLength(30);
    for (let i = 1; i <= 12; i++) { const value = room({ address: `192.168.8.${i}` }); value.metadata.roomId = 'room-40'; transport.emit(discovered(scanId, value)); }
    expect(session.view.rooms.find(value => value.metadata.roomId === 'room-40')!.endpoints).toHaveLength(8);
    transport.emit(status(scanId, 'scanning', { paths: -1, sent: Infinity, diagnostics: Array.from({ length: 250 }, () => 'x'.repeat(600)) }));
    expect(session.view.discovery.paths).toBe(0); expect(session.view.discovery.sent).toBe(0);
    expect(session.view.discovery.diagnostics).toHaveLength(200); expect(session.view.discovery.diagnostics.every(value => value.length <= 300)).toBe(true);
  });

  it('sanitizes display metadata while preserving compatibility fingerprints', async () => {
    const { transport, session } = browser(); await session.browse(); const scanId = session.view.discovery.scanId;
    const value = room({ name: '\0测试\n房间' });
    Object.assign(value.metadata, { platform: '\0Windows\n', players: 99, phase: 'lobby\n', untrusted: '<img>' });
    transport.emit(discovered(scanId, value));
    expect(session.view.rooms[0]).toMatchObject({ name: '测试房间', metadata: { platform: 'Windows', phase: 'lobby', protocolVersion: LAN_PROTOCOL_VERSION, contentHash: LAN_CONTENT_HASH } });
    expect(session.view.rooms[0].metadata.players).toBeUndefined(); expect(session.view.rooms[0].metadata).not.toHaveProperty('untrusted');
  });

  it('ignores invalid endpoints and identities before adding a room', async () => {
    const { transport, session } = browser(); await session.browse(); const scanId = session.view.discovery.scanId;
    transport.emit(discovered(scanId, room({ address: '999.1.1.1' }))); transport.emit(discovered(scanId, room({ port: 0 })));
    const invalid = room(); invalid.metadata.roomId = 'room/<script>'; transport.emit(discovered(scanId, invalid));
    expect(session.view.rooms).toEqual([]);
  });

  it('ignores discovery callbacks after leaving the browser', async () => {
    const { transport, session } = browser(); await session.browse(); const scanId = session.view.discovery.scanId;
    await session.leave(); transport.emit(discovered(scanId)); transport.emit(status(scanId, 'failed', { error: 'late' }));
    expect(session.view.phase).toBe('idle'); expect(session.view.rooms).toEqual([]); expect(session.view.error).toBe('');
  });
});
