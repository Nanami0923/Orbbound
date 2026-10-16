/** Shared pointer policy for desktop game renderers and touch adapters. */
export function isFirePointerButton(button: number, touch = false): boolean {
  return button === 0 || !touch && button === 2;
}
export function insideInputSurface(x: number, y: number, rect: { left: number; top: number; right: number; bottom: number }): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
