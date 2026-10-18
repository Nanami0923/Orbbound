import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface RoomMetadata { roomId: string; protocolVersion: number; rulesHash: string; mode?: 'score' | 'battle'; platform?: string; players?: number; capacity?: number; phase?: string; contentHash?: string }
export interface DiscoveredRoom { name: string; address: string; port: number; metadata: RoomMetadata }
export type DiscoveryStatus = 'scanning' | 'completed' | 'cancelled' | 'failed';
export interface LanEvent {
  type: 'lan-event';
  event: 'connected' | 'message' | 'disconnected' | 'discovered' | 'discovery-status' | 'advertisement-status' | 'error' | 'background' | 'foreground';
  connectionId?: string; message?: string; room?: DiscoveredRoom; error?: string;
  scanId?: string; status?: DiscoveryStatus; paths?: number; sent?: number; received?: number; errors?: number; diagnostics?: string[]; discoveryAvailable?: boolean;
  clientId?: string;
}
export interface HostInfo { addresses: string[]; port: number; discoveryAvailable: boolean }
export interface LanTransport {
  readonly available: boolean;
  request<T = unknown>(action: string, payload?: Record<string, unknown>): Promise<T>;
  subscribe(listener: (event: LanEvent) => void): () => void;
  close(): Promise<void>;
}
interface WebViewHost {
  postMessage(value: unknown): void;
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { data: unknown }) => void): void;
}
interface NativeLan {
  [key: string]: unknown;
  addListener(name: 'lanEvent', listener: (event: LanEvent) => void): Promise<PluginListenerHandle>;
}
const plugin = registerPlugin<NativeLan>('LanMultiplayer');
const webview = () => typeof window === 'undefined' ? undefined : (window as unknown as { chrome?: { webview?: WebViewHost } }).chrome?.webview;
export const lanPlatform = () => Capacitor.getPlatform() === 'android' ? 'Android' : webview() ? 'Windows' : '预览';

export class NativeLanTransport implements LanTransport {
  readonly available = Capacitor.getPlatform() === 'android' || !!webview();
  private readonly android = Capacitor.getPlatform() === 'android';
  private readonly clientId = `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private listeners = new Set<(event: LanEvent) => void>();
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private handle?: PluginListenerHandle;
  private initialized: Promise<void>;
  private sequence = 0;
  private disposed = false;
  private closing?: Promise<void>;
  private receive = (event: { data: unknown }) => {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'lan-event') this.emit(data as unknown as LanEvent);
    if (data.type !== 'lan-response' || typeof data.requestId !== 'string') return;
    const pending = this.pending.get(data.requestId);
    if (!pending) return;
    this.pending.delete(data.requestId); clearTimeout(pending.timer);
    if (data.ok === true) pending.resolve(data.result);
    else pending.reject(new Error(typeof data.error === 'string' ? data.error : '原生网络请求失败'));
  };
  constructor() {
    this.initialized = (this.android
      ? plugin.addListener('lanEvent', event => this.emit(event)).then(handle => {
        if (this.disposed) { void handle.remove().catch(() => {}); throw new Error('网络会话已关闭'); }
        this.handle = handle;
      })
      : Promise.resolve().then(() => { webview()?.addEventListener('message', this.receive); }))
      .then(() => {
        if (this.disposed) throw new Error('网络会话已关闭');
        return this.invoke('claim', {}, 3000, false);
      });
    // A missing native plugin is reported on the first explicit action, not as an unhandled promise.
    void this.initialized.catch(() => {});
  }
  private emit(event: LanEvent): void {
    if (!this.disposed && (!event.clientId || event.clientId === this.clientId)) for (const listener of this.listeners) listener(event);
  }
  subscribe(listener: (event: LanEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async request<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (!this.available) throw new Error('局域网联机需要 Windows 或 Android 安装版');
    if (this.disposed) throw new Error('网络会话已关闭');
    return this.invoke<T>(action, payload, 10000, true);
  }
  private invoke<T = unknown>(action: string, payload: Record<string, unknown>, timeout: number, waitForInit: boolean, shutdown = false): Promise<T> {
    const requestId = `${this.clientId}-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('网络操作超时，请返回首页后重试'));
        // Quarantine this transport. Native ownership prevents a late operation from affecting its replacement.
        if (!shutdown) void this.close();
      }, timeout);
      this.pending.set(requestId, { resolve: value => resolve(value as T), reject, timer });
      const settle = (value?: unknown, error?: unknown) => {
        const pending = this.pending.get(requestId); if (!pending) return;
        this.pending.delete(requestId); clearTimeout(pending.timer);
        if (error !== undefined) pending.reject(error instanceof Error ? error : new Error(String(error)));
        else pending.resolve(value);
      };
      void (async () => {
        if (waitForInit) await this.initialized;
        if (!this.pending.has(requestId) || this.disposed && !shutdown) return;
        const options = { ...payload, _clientId: this.clientId };
        if (this.android) {
          const method = plugin[action];
          if (typeof method !== 'function') throw new Error('原生联机插件不可用，请更新安装版');
          settle(await (method as (options: Record<string, unknown>) => Promise<T>)(options));
        } else webview()!.postMessage({ type: 'lan', requestId, action, payload: options });
      })().catch(error => settle(undefined, error));
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.listeners.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('网络会话已关闭')); }
    this.pending.clear();
    this.closing = (this.available ? this.invoke('dispose', {}, 1500, false, true).catch(() => {}) : Promise.resolve()).then(() => {
      webview()?.removeEventListener('message', this.receive);
      void this.handle?.remove().catch(() => {});
    });
    return this.closing;
  }
}

export function parseAddress(value: string): { address: string; port: number } | null {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(value.trim());
  if (!match || match[1].split('.').some(part => Number(part) > 255)) return null;
  const port = Number(match[2] ?? 42171);
  return port >= 1 && port <= 65535 ? { address: match[1], port } : null;
}
