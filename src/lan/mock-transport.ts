import type { DiscoveredRoom, HostInfo, LanEvent, LanTransport } from './transport';

/** Development-only browser simulation. No native sockets or LAN guarantees. */
export class MockLanTransport implements LanTransport {
  readonly available = true;
  private channel = new BroadcastChannel('orbbound-lan-development-v3');
  private identity = crypto.randomUUID();
  private listeners = new Set<(event: LanEvent) => void>();
  private links = new Map<string, string>();
  private room?: DiscoveredRoom;
  private scan?: ReturnType<typeof setInterval>;
  private scanId = '';
  private scanEnd?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor() { this.channel.onmessage = event => this.receive(event.data); }
  private emit(event: Omit<LanEvent, 'type'>): void { for (const listener of this.listeners) listener({ type: 'lan-event', ...event }); }
  private post(data: Record<string, unknown>): void { this.channel.postMessage({ ...data, from: this.identity }); }
  subscribe(listener: (event: LanEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async request<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    let result: unknown = {};
    switch (action) {
      case 'startHost': {
        const port = Number(payload.port) || 43000 + Math.floor(Math.random() * 20000);
        this.room = { name: String(payload.name), address: '127.0.0.1', port, metadata: payload.metadata as DiscoveredRoom['metadata'] };
        result = { addresses: ['127.0.0.1'], port, discoveryAvailable: true } satisfies HostInfo; break;
      }
      case 'stopHost': this.room = undefined; break;
      case 'updateAdvertisement': if (this.room) { this.room.metadata = payload.metadata as DiscoveredRoom['metadata']; if (typeof payload.name === 'string') this.room.name = payload.name; } break;
      case 'discover':
        clearInterval(this.scan); clearTimeout(this.scanEnd); this.scanId = String(payload.scanId ?? crypto.randomUUID());
        this.emit({ event: 'discovery-status', scanId: this.scanId, status: 'scanning', paths: 1, sent: 1, received: 0, errors: 0 });
        this.post({ kind: 'query', scanId: this.scanId }); this.scan = setInterval(() => this.post({ kind: 'query', scanId: this.scanId }), 1500);
        this.scanEnd = setTimeout(() => { clearInterval(this.scan); this.scan = undefined; this.emit({ event: 'discovery-status', scanId: this.scanId, status: 'completed', paths: 1, sent: 5, errors: 0 }); }, 8000); break;
      case 'stopDiscovery': clearInterval(this.scan); clearTimeout(this.scanEnd); this.scan = undefined; this.emit({ event: 'discovery-status', scanId: this.scanId, status: 'cancelled' }); break;
      case 'connect': {
        const connectionId = crypto.randomUUID();
        result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { this.pending.delete(connectionId); reject(new Error('模拟连接超时')); }, 5000);
          this.pending.set(connectionId, { resolve, reject, timer });
          this.post({ kind: 'connect', port: payload.port, connectionId });
        }); break;
      }
      case 'send': {
        const connectionId = String(payload.connectionId), target = this.links.get(connectionId);
        if (!target) throw new Error('模拟连接已关闭');
        this.post({ kind: 'message', connectionId, target, message: payload.message }); break;
      }
      case 'disconnect': this.drop(String(payload.connectionId)); break;
      case 'dispose':
        for (const connectionId of [...this.links.keys()]) this.drop(connectionId);
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('模拟连接已取消')); }
        this.pending.clear(); this.room = undefined; clearInterval(this.scan); clearTimeout(this.scanEnd); this.scan = undefined; break;
      default: throw new Error(`未知模拟操作：${action}`);
    }
    return result as T;
  }
  private drop(connectionId: string): void {
    const target = this.links.get(connectionId); if (!target) return;
    this.links.delete(connectionId); this.post({ kind: 'disconnect', connectionId, target }); this.emit({ event: 'disconnected', connectionId });
  }
  private receive(data: Record<string, unknown>): void {
    if (data.from === this.identity || (data.target && data.target !== this.identity)) return;
    const connectionId = String(data.connectionId ?? '');
    if (data.kind === 'query' && this.room) this.post({ kind: 'offer', target: data.from, scanId: data.scanId, room: this.room });
    if (data.kind === 'offer' && this.scan && data.scanId === this.scanId) this.emit({ event: 'discovered', scanId: this.scanId, room: data.room as DiscoveredRoom });
    if (data.kind === 'connect' && this.room?.port === data.port) {
      this.links.set(connectionId, String(data.from)); this.post({ kind: 'accepted', target: data.from, connectionId }); this.emit({ event: 'connected', connectionId });
    }
    if (data.kind === 'accepted') {
      const pending = this.pending.get(connectionId); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(connectionId); this.links.set(connectionId, String(data.from));
      pending.resolve({ connectionId }); this.emit({ event: 'connected', connectionId });
    }
    if (data.kind === 'message' && this.links.get(connectionId) === data.from) this.emit({ event: 'message', connectionId, message: String(data.message) });
    if (data.kind === 'disconnect' && this.links.get(connectionId) === data.from) { this.links.delete(connectionId); this.emit({ event: 'disconnected', connectionId }); }
  }
  async close(): Promise<void> { await this.request('dispose'); this.listeners.clear(); this.channel.close(); }
}
