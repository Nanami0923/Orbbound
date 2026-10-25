import { bindModalFocus } from './modal-focus';

/** A local information dialog; match time remains owned by the LAN session. */
export function bindLanInfoPopover(root: HTMLElement): { close: (restoreFocus?: boolean) => boolean; dispose: () => void } | undefined {
  const toggle = root.querySelector<HTMLElement>('#lan-info-toggle');
  const layer = root.querySelector<HTMLElement>('#lan-info-layer');
  const panel = root.querySelector<HTMLElement>('#lan-info-panel');
  if (!toggle || !layer || !panel) return;

  const abort = new AbortController();
  let opened = false, disposed = false, releaseFocus: (() => void) | undefined;
  layer.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  toggle.setAttribute('aria-controls', panel.id);
  toggle.setAttribute('aria-expanded', 'false');
  root.classList.remove('lan-info-open');

  const notify = () => root.dispatchEvent(new Event('orbbound-lan-info-toggle'));
  const close = (restoreFocus = true): boolean => {
    if (!opened) return false;
    opened = false;
    layer.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    root.classList.remove('lan-info-open');
    releaseFocus?.(); releaseFocus = undefined;
    notify();
    if (restoreFocus && toggle.isConnected && !toggle.closest('[hidden]')) toggle.focus({ preventScroll: true });
    return true;
  };
  toggle.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    if (disposed || close()) return;
    opened = true;
    layer.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    root.classList.add('lan-info-open');
    const backgrounds = [root.querySelector<HTMLElement>('.lan-top'), root.querySelector<HTMLElement>('.lan-body')]
      .filter((element): element is HTMLElement => !!element);
    releaseFocus = bindModalFocus(panel, backgrounds);
    notify();
  }, { signal: abort.signal });

  // Keep the layer present until click so both ends of a dismissing gesture stay here.
  for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
    layer.addEventListener(type, event => { if (opened) event.stopPropagation(); }, { signal: abort.signal });
  }
  layer.addEventListener('click', event => {
    if (!opened) return;
    event.stopPropagation();
    if ((event.target as Element | null)?.closest('[data-lan-info-dismiss]')) {
      event.preventDefault(); close();
    }
  }, { signal: abort.signal });
  root.ownerDocument.addEventListener('keydown', event => {
    if (!opened || event.key !== 'Escape') return;
    event.preventDefault(); event.stopImmediatePropagation(); close();
  }, { capture: true, signal: abort.signal });

  return {
    close,
    dispose: () => {
      if (disposed) return;
      close(false); disposed = true; abort.abort();
      layer.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      root.classList.remove('lan-info-open');
    },
  };
}
