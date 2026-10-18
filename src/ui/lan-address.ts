import { parseAddress, type HostInfo } from '../lan/transport';

/** Use the bound listener's actual port, including multi-interface hosts. */
export function roomEndpoints(info: HostInfo | undefined): string[] {
  if (!info || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535) return [];
  return [...new Set(info.addresses.map(address => `${address}:${info.port}`).filter(value => !!parseAddress(value)))];
}

/** A rejected/unavailable clipboard must never be reported as a successful copy. */
export async function copyRoomAddress(value: string, clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard): Promise<boolean> {
  if (!parseAddress(value) || !clipboard?.writeText) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => clipboard.writeText(value)).then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}
