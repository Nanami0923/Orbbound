import { afterEach, expect, it, vi } from 'vitest';
import { copyRoomAddress, roomEndpoints } from '../src/ui/lan-address';

afterEach(() => vi.useRealTimers());

it('uses the actual listener port and deduplicates valid interface addresses', () => {
  expect(roomEndpoints({ addresses: ['192.168.1.8', '10.0.0.2', '192.168.1.8', 'bad', '999.1.1.1'], port: 51234, discoveryAvailable: false }))
    .toEqual(['192.168.1.8:51234', '10.0.0.2:51234']);
  expect(roomEndpoints(undefined)).toEqual([]);
  expect(roomEndpoints({ addresses: ['192.168.1.8'], port: 0, discoveryAvailable: true })).toEqual([]);
});

it('copies only the selected complete endpoint and reports success after the write', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  expect(await copyRoomAddress('10.0.0.2:51234', { writeText } as unknown as Clipboard)).toBe(true);
  expect(writeText).toHaveBeenCalledExactlyOnceWith('10.0.0.2:51234');
  expect(await copyRoomAddress('unavailable', { writeText } as unknown as Clipboard)).toBe(false);
  expect(writeText).toHaveBeenCalledTimes(1);
});

it('keeps permission rejection and a stalled clipboard recoverable', async () => {
  expect(await copyRoomAddress('10.0.0.2:51234', { writeText: () => Promise.reject(new Error('denied')) } as unknown as Clipboard)).toBe(false);
  vi.useFakeTimers();
  const pending = copyRoomAddress('10.0.0.2:51234', { writeText: () => new Promise(() => {}) } as unknown as Clipboard);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toBe(false);
});
