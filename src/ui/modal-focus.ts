/** Keep one modal reachable by keyboard while the game behind it is paused. */
export function bindModalFocus(dialog: HTMLElement, backgrounds: HTMLElement[]): () => void {
  const previous = backgrounds.map(element => ({element, inert: element.inert}));
  for (const {element} of previous) element.inert = true;
  const title = dialog.querySelector<HTMLElement>('h2');
  if (title) {
    title.id ||= 'orbbound-dialog-title';
    title.tabIndex = -1;
    dialog.setAttribute('aria-labelledby', title.id);
  }
  const abort = new AbortController();
  const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]')]
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[hidden]') && element.getClientRects().length > 0);
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = focusable(), current = document.activeElement;
    const first = controls[0], last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); title?.focus(); return; }
    if (event.shiftKey && (current === first || !controls.includes(current as HTMLElement))) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && (current === last || !controls.includes(current as HTMLElement))) {
      event.preventDefault(); first.focus();
    }
  }, {signal:abort.signal});
  queueMicrotask(() => { if (!abort.signal.aborted && dialog.isConnected) (dialog.querySelector<HTMLElement>('[data-autofocus]') ?? title ?? focusable()[0])?.focus({preventScroll:true}); });
  return () => { abort.abort(); for (const {element,inert} of previous) element.inert = inert; };
}
