import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  platform: 'android',
  plugin: {
    addListener: vi.fn(), claim: vi.fn(), startHost: vi.fn(), dispose: vi.fn(),
  },
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => native.platform },
  registerPlugin: () => native.plugin,
}));
import { NativeLanTransport, type LanEvent } from '../src/lan/transport';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const transports: NativeLanTransport[] = [];
const create = () => { const transport = new NativeLanTransport(); transports.push(transport); return transport; };
const flush = () => vi.advanceTimersByTimeAsync(0);
let remove: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  native.platform = 'android';
  for (const method of Object.values(native.plugin)) method.mockReset();
  remove = vi.fn().mockResolvedValue(undefined);
  native.plugin.addListener.mockResolvedValue({ remove });
  native.plugin.claim.mockResolvedValue(undefined);
  native.plugin.startHost.mockResolvedValue({ addresses: ['127.0.0.1'], port: 42171 });
  native.plugin.dispose.mockResolvedValue(undefined);
});
afterEach(async () => {
  const closing = transports.splice(0).map(transport => transport.close());
  await vi.runAllTimersAsync();
  await Promise.all(closing);
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it('bounds a request waiting for listener initialization and removes a late subscription', async () => {
  const listener = deferred<{ remove(): Promise<void> }>();
  native.plugin.addListener.mockReturnValue(listener.promise);
  const transport = create();
  const result = transport.request('startHost').catch(error => error as Error);
  await vi.advanceTimersByTimeAsync(10000);
  expect(await result).toBeInstanceOf(Error);
  expect(native.plugin.startHost).not.toHaveBeenCalled();
  expect(native.plugin.dispose).toHaveBeenCalledOnce();
  listener.resolve({ remove });
  await flush();
  expect(remove).toHaveBeenCalledOnce();
  expect(native.plugin.claim).not.toHaveBeenCalled();
});

it('quarantines a hanging native ownership claim after three seconds', async () => {
  native.plugin.claim.mockImplementation(() => new Promise(() => {}));
  const transport = create();
  const result = transport.request('startHost').catch(error => error as Error);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await result).toBeInstanceOf(Error);
  expect(native.plugin.startHost).not.toHaveBeenCalled();
  expect(native.plugin.dispose).toHaveBeenCalledOnce();
  await expect(transport.request('startHost')).rejects.toThrow('已关闭');
});

it('ignores an operation resolving after timeout without cleaning up its replacement', async () => {
  const operation = deferred<unknown>();
  native.plugin.startHost.mockReturnValueOnce(operation.promise);
  const first = create();
  const result = first.request('startHost').catch(error => error as Error);
  await flush();
  const oldOwner = native.plugin.claim.mock.calls[0][0]._clientId;
  await vi.advanceTimersByTimeAsync(10000);
  expect((await result as Error).message).toContain('超时');
  const next = create();
  await expect(next.request('startHost')).resolves.toMatchObject({ port: 42171 });
  const newOwner = native.plugin.claim.mock.calls[1][0]._clientId;
  expect(newOwner).not.toBe(oldOwner);
  expect(native.plugin.dispose).toHaveBeenCalledExactlyOnceWith({ _clientId: oldOwner });
  operation.resolve({ port: 12345 });
  await flush();
  expect(native.plugin.dispose).toHaveBeenCalledTimes(1);
  expect(native.plugin.startHost.mock.calls[1][0]._clientId).toBe(newOwner);
  await expect(next.request('startHost')).resolves.toMatchObject({ port: 42171 });
});

it('preserves cleanup ownership when old cleanup finishes after a new session starts', async () => {
  const cleanup = deferred<void>();
  native.plugin.dispose.mockReturnValueOnce(cleanup.promise);
  const first = create();
  await first.request('startHost');
  const oldOwner = native.plugin.claim.mock.calls[0][0]._clientId;
  const closing = first.close();
  expect(first.close()).toBe(closing);
  const next = create();
  await next.request('startHost');
  const newOwner = native.plugin.claim.mock.calls[1][0]._clientId;
  expect(native.plugin.dispose).toHaveBeenCalledExactlyOnceWith({ _clientId: oldOwner });
  expect(newOwner).not.toBe(oldOwner);
  cleanup.resolve();
  await closing;
  await expect(next.request('startHost')).resolves.toMatchObject({ port: 42171 });
  expect(native.plugin.dispose).toHaveBeenCalledTimes(1);
});

it('closes immediately without waiting for initialization and rejects existing work', async () => {
  const listener = deferred<{ remove(): Promise<void> }>();
  native.plugin.addListener.mockReturnValue(listener.promise);
  const transport = create();
  const work = transport.request('startHost').catch(error => error as Error);
  await transport.close();
  expect((await work as Error).message).toContain('已关闭');
  expect(native.plugin.dispose).toHaveBeenCalledOnce();
  listener.resolve({ remove });
  await flush();
  expect(remove).toHaveBeenCalledOnce();
  expect(native.plugin.startHost).not.toHaveBeenCalled();
});

it('bounds native disposal and removes the listener even when cleanup never answers', async () => {
  native.plugin.dispose.mockImplementation(() => new Promise(() => {}));
  const transport = create();
  await transport.request('startHost');
  let closed = false;
  const closing = transport.close().then(() => { closed = true; });
  await flush(); expect(closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1500);
  await closing;
  expect(closed).toBe(true); expect(remove).toHaveBeenCalledOnce();
});

it('filters Android events by their captured native owner and ignores events after close', async () => {
  const callbacks: ((event: LanEvent) => void)[] = [];
  native.plugin.addListener.mockImplementation(async (_name, listener) => { callbacks.push(listener); return { remove }; });
  const first = create(), next = create();
  await flush();
  const firstOwner = native.plugin.claim.mock.calls[0][0]._clientId;
  const nextOwner = native.plugin.claim.mock.calls[1][0]._clientId;
  const listener = vi.fn(); next.subscribe(listener);
  callbacks[1]({ type: 'lan-event', event: 'connected', clientId: firstOwner, connectionId: 'old' });
  expect(listener).not.toHaveBeenCalled();
  callbacks[1]({ type: 'lan-event', event: 'connected', clientId: nextOwner, connectionId: 'new' });
  expect(listener).toHaveBeenCalledOnce();
  await next.close();
  callbacks[1]({ type: 'lan-event', event: 'disconnected', clientId: nextOwner, connectionId: 'new' });
  expect(listener).toHaveBeenCalledOnce();
  await first.close();
});

it('carries ownership through the Windows bridge and drops stale queued events', async () => {
  native.platform = 'web';
  const listeners = new Set<(event: { data: unknown }) => void>();
  const receive = (data: unknown) => listeners.forEach(listener => listener({ data }));
  const host = {
    addEventListener: vi.fn((_type: string, listener: (event: { data: unknown }) => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: (event: { data: unknown }) => void) => listeners.delete(listener)),
    postMessage: vi.fn((value: { requestId: string; action: string; payload: { _clientId: string } }) => {
      void Promise.resolve().then(() => receive({ type: 'lan-response', requestId: value.requestId, ok: true, result: value.action === 'startHost' ? { port: 42171 } : undefined }));
    }),
  };
  vi.stubGlobal('window', { chrome: { webview: host } });
  const first = create(); await first.request('startHost');
  const oldOwner = host.postMessage.mock.calls.find(([message]) => message.action === 'claim')![0].payload._clientId;
  await first.close();
  const next = create(); await next.request('startHost');
  const claims = host.postMessage.mock.calls.filter(([message]) => message.action === 'claim');
  const owner = claims[1][0].payload._clientId;
  expect(owner).not.toBe(oldOwner);
  const listener = vi.fn(); next.subscribe(listener);
  receive({ type: 'lan-event', event: 'message', clientId: oldOwner, message: 'stale' });
  receive({ type: 'lan-event', event: 'message', clientId: owner, message: 'current' });
  expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'current' }));
  await next.close();
  expect(listeners.size).toBe(0);
});
