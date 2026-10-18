import { fittingTextEnd, graphemeBoundaries, partitionModalUnits, semanticTextEnd } from './modal-pagination';

export function pageCapacity(height: number, reserved: number, itemHeight: number, maximum: number, columns = 1): number {
  return Math.max(columns, Math.min(maximum, Math.floor(Math.max(0, height - reserved) / itemHeight) * columns));
}
export function viewportHeight(): number {
  return typeof window === 'undefined' ? 720 : window.visualViewport?.height ?? window.innerHeight;
}

export const VIEWPORT_CHANGE_EVENT = 'orbbound-viewport-change';
export function bindViewportShell(): () => void {
  let frame = 0, previous = '', disposed = false;
  const update = () => {
    frame = 0;
    if (disposed) return;
    const viewport = window.visualViewport, height = viewport?.height ?? window.innerHeight, width = viewport?.width ?? window.innerWidth;
    const next = `${width}:${height}`;
    if (next === previous) return;
    previous = next;
    document.documentElement.style.setProperty('--app-height', `${height}px`);
    document.documentElement.style.setProperty('--app-width', `${width}px`);
    window.dispatchEvent(new CustomEvent(VIEWPORT_CHANGE_EVENT, { detail: { width, height } }));
  };
  const resize = () => { if (!disposed && !frame) frame = requestAnimationFrame(update); };
  update(); window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize);
  return () => { disposed = true; cancelAnimationFrame(frame); window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); };
}

export type ModalLayout = 'compact' | 'paged' | 'custom';
interface ModalUnit { node: HTMLElement; anchor: HTMLElement }
const interactive = 'button,input,select,textarea,a[href],[contenteditable="true"]';
const numeric = (value: string) => Number.parseFloat(value) || 0;

/** Keep the original node tree: every reflow starts from it, never from prior text fragments. */
export function bindModalPages(card: HTMLElement, layout: ModalLayout = 'paged'): () => void {
  card.dataset.modalLayout = layout;
  if (layout === 'custom') return () => {};
  card.classList.add('paged-modal');
  const document = card.ownerDocument, view = document.defaultView!;
  const children = [...card.children] as HTMLElement[];
  const fixed = children.filter(node => node.matches('.modal-close,.history-close,h2,.modal-footer,[data-page-fixed]'));
  const items = children.filter(node => !fixed.includes(node));
  if (!items.length) return () => card.classList.remove('paged-modal');
  const footer = fixed.find(node => node.matches('.modal-footer'));
  const slots = new Map<HTMLElement, Comment>();
  const styles = new Map<HTMLElement, string | null>();
  const remember = (node: HTMLElement) => {
    if (!slots.has(node)) { const slot = document.createComment('modal-content'); node.before(slot); slots.set(node, slot); }
    return node;
  };
  items.forEach(remember);
  const originals = items.flatMap(node => node.matches('.tutorial-steps,.mobile-menu-actions,[data-page-group]')
    ? [...node.children].map(child => remember(child as HTMLElement)) : [node]);
  if (footer) remember(footer);
  const body = document.createElement('div'); body.className = 'modal-pages'; body.style.position = 'relative';
  const nav = document.createElement('nav'); nav.className = 'page-navigation modal-page-navigation'; nav.setAttribute('aria-label', '内容分页');
  const previous = document.createElement('button'), label = document.createElement('span'), next = document.createElement('button');
  previous.type = next.type = 'button'; previous.className = next.className = 'quiet-button';
  previous.textContent = '‹'; previous.setAttribute('aria-label', '上一页'); next.textContent = '›'; next.setAttribute('aria-label', '下一页');
  label.setAttribute('aria-live', 'polite'); nav.append(previous, label, next); nav.hidden = true;
  // Fixed headings always precede the body, even when an eyebrow originally came first.
  card.insertBefore(body, footer ?? null);
  card.insertBefore(nav, footer ?? null);
  let page = 0, pages: HTMLElement[] = [], pageAnchors: HTMLElement[][] = [], disposed = false, frame = 0;
  let lastAnchor: HTMLElement | undefined;
  const restore = () => {
    // Restore ancestors first; descendant slots travel with their original parents.
    for (const [node, slot] of slots) if (slot.parentNode) slot.after(node);
    for (const [node, style] of styles) { if (style === null) node.removeAttribute('style'); else node.setAttribute('style', style); }
    styles.clear();
  };
  const focusFirst = () => (pages[page]?.querySelector<HTMLElement>(interactive) ?? card.querySelector<HTMLElement>('h2'))?.focus({ preventScroll: true });
  const show = (index: number, focus = false) => {
    page = Math.max(0, Math.min(index, pages.length - 1));
    pages.forEach((node, i) => { node.hidden = i !== page; });
    lastAnchor = pageAnchors[page]?.[0] ?? lastAnchor;
    previous.disabled = page === 0; next.disabled = page >= pages.length - 1;
    label.textContent = `${page + 1} / ${Math.max(1, pages.length)}`;
    nav.hidden = pages.length <= 1;
    card.dataset.pageCount = String(Math.max(1, pages.length));
    if (focus) focusFirst();
  };
  const measureHeight = (node: HTMLElement) => {
    const css = view.getComputedStyle(node);
    return node.getBoundingClientRect().height + numeric(css.marginTop) + numeric(css.marginBottom);
  };
  const availableHeight = () => {
    const parent = card.parentElement!, parentCss = view.getComputedStyle(parent), css = view.getComputedStyle(card);
    const parentHeight = parent.clientHeight - numeric(parentCss.paddingTop) - numeric(parentCss.paddingBottom);
    const limit = numeric(css.getPropertyValue('--modal-max-height')) || 720;
    const outer = Math.min(parentHeight, limit) - numeric(css.paddingTop) - numeric(css.paddingBottom) - numeric(css.borderTopWidth) - numeric(css.borderBottomWidth);
    const fixedInFlow = fixed.filter(node => node.parentElement === card && !['absolute', 'fixed'].includes(view.getComputedStyle(node).position));
    const gap = numeric(css.rowGap);
    // Reserve navigation even for a single page; removing it then only makes the card shorter.
    return Math.floor(outer - fixedInFlow.reduce((height, node) => height + measureHeight(node), 0) - 44 - gap * (fixedInFlow.length + 1));
  };
  const cloneText = (source: HTMLElement, region: HTMLElement, start: number, end: number) => {
    const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT), texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    const range = document.createRange(); let offset = 0, began = false;
    for (const node of texts) {
      const length = node.data.length;
      if (!began && start <= offset + length) { range.setStart(node, Math.max(0, start - offset)); began = true; }
      if (end <= offset + length) { range.setEnd(node, Math.max(0, end - offset)); break; }
      offset += length;
    }
    const copy = source.cloneNode(true) as HTMLElement;
    const target = region === source ? copy : copy.querySelector<HTMLElement>('[data-modal-text-region]')!;
    target.replaceChildren(range.cloneContents());
    copy.removeAttribute('id'); copy.removeAttribute('data-modal-text-region'); copy.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    copy.querySelectorAll('[data-modal-text-region]').forEach(node => node.removeAttribute('data-modal-text-region'));
    copy.classList.add('modal-fragment'); return copy;
  };
  const arrange = () => {
    frame = 0;
    if (disposed || !card.isConnected) return;
    const started = performance.now();
    const report = (available: number, measurements: number, pending = false) => {
      const durationMs = Math.max(0, performance.now() - started);
      card.dataset.layoutDuration = durationMs.toFixed(2); card.dataset.layoutMeasurements = String(measurements);
      card.dispatchEvent(new CustomEvent('orbbound-modal-layout', { bubbles: true, detail: { pages: pages.length, available, measurements, durationMs, pending, errorFallback: card.dataset.layoutError === 'true', overflow: card.dataset.pageOverflow === 'true' } }));
    };
    const active = document.activeElement instanceof HTMLElement && card.contains(document.activeElement) ? document.activeElement : null;
    const selection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] as const : null;
    let measure: HTMLElement | undefined, available = 0;
    try {
    delete card.dataset.layoutError; body.style.overflowY = ''; body.style.touchAction = '';
    const anchor = pageAnchors[page]?.find(node => active && node.contains(active)) ?? lastAnchor ?? originals[0];
    restore();
    // Its original restoration slot precedes the generated body; live layout keeps actions last.
    if (footer) card.append(footer);
    body.replaceChildren(); items.forEach(node => node.remove()); pages = []; pageAnchors = [];
    nav.hidden = false;
    available = availableHeight();
    // On very short views, actions become a final semantic step, leaving readable content space.
    const footerInPages = !!footer && available < 64;
    if (footerInPages) { footer!.remove(); available = availableHeight(); }
    if (available < 24 || body.getBoundingClientRect().width < 1) {
      items.forEach(node => body.append(node));
      if (footerInPages) body.append(footer!);
      nav.hidden = true; card.dataset.pagePending = 'true'; report(available, 0, true); return;
    }
    delete card.dataset.pagePending;
    body.style.maxHeight = `${available}px`;
    measure = document.createElement('section'); measure.className = 'modal-page modal-measure';
    measure.style.cssText = 'position:absolute;inset-inline:0;top:0;height:auto;visibility:hidden;pointer-events:none;';
    body.append(measure);
    const units: ModalUnit[] = originals.map(node => ({ node, anchor: node }));
    if (footerInPages) units.push({ node: footer!, anchor: footer! });
    units.forEach(unit => measure!.append(unit.node));
    const gap = numeric(view.getComputedStyle(measure).rowGap);
    const projected: { value: ModalUnit; height: number }[] = [];
    let measurements = 0;
    const project = (unit: ModalUnit) => {
      const projectedStart = projected.length;
      const source = unit.node, height = measureHeight(source);
      if (height <= available + 1) { projected.push({ value: unit, height }); return; }
      // Field/action groups retain the actual controls, their values and their event handlers.
      if (source.matches('.mode-tabs,.modal-footer,[data-page-split]') && source.children.length > 1) {
        for (const child of [...source.children] as HTMLElement[]) {
          remember(child);
          const shell = source.cloneNode(false) as HTMLElement; shell.removeAttribute('id'); shell.classList.add('modal-unit'); shell.append(child); measure!.append(shell);
          project({ node: shell, anchor: child });
        }
        return;
      }
      // A preview is scalable; text and controls never shrink below their readable size.
      if (source.matches('svg,img,canvas,.level-preview')) {
        styles.set(source, source.getAttribute('style'));
        source.style.maxHeight = `${Math.max(1, available)}px`; source.style.width = '100%'; source.style.objectFit = 'contain';
        projected.push({ value: unit, height: measureHeight(source) }); return;
      }
      const region = source.matches('.tutorial-step') ? source.querySelector<HTMLElement>('span') : source.matches('p,.result-meta,[data-page-text]') ? source : null;
      if (region && !source.matches(interactive) && !source.querySelector(interactive) && region.textContent?.length && measurements < 192) {
        region.setAttribute('data-modal-text-region', '');
        const text = region.textContent, boundaries = graphemeBoundaries(text);
        let offset = 0, count = 0;
        while (offset < text.length && count++ < 64 && measurements < 192) {
          let candidate: HTMLElement | undefined;
          const measuredEnd = fittingTextEnd(boundaries, offset, limit => {
            if (measurements >= 192) return false;
            measurements++; candidate?.remove(); candidate = cloneText(source, region, offset, limit); measure!.append(candidate);
            return measureHeight(candidate) <= available + 1;
          });
          candidate?.remove();
          if (measuredEnd === null) break;
          const end = semanticTextEnd(text, offset, measuredEnd);
          const fragment = cloneText(source, region, offset, end); measure!.append(fragment);
          projected.push({ value: { node: fragment, anchor: unit.anchor }, height: measureHeight(fragment) }); offset = end;
        }
        region.removeAttribute('data-modal-text-region');
        if (offset === text.length) return;
        // Discard partial projections if the complete semantic block cannot be represented.
        while (projected.length > projectedStart) projected.pop()!.value.node.remove();
        if (source.matches('.tutorial-step')) {
          const context = source.cloneNode(true) as HTMLElement; context.querySelector('span')?.remove(); context.removeAttribute('id');
          const description = document.createElement('p'); description.className = 'modal-tutorial-copy'; description.append(...region.cloneNode(true).childNodes);
          measure!.append(context, description);
          project({ node: context, anchor: unit.anchor }); project({ node: description, anchor: unit.anchor }); return;
        }
      }
      // Keep unexpected content intact and signal the dedicated layout fallback to callers.
      card.dataset.pageOverflow = 'true'; projected.push({ value: unit, height });
    };
    delete card.dataset.pageOverflow;
    units.forEach(project);
    const grouped = partitionModalUnits(projected, available, gap);
    for (const group of grouped) {
      const section = document.createElement('section'); section.className = 'modal-page'; section.setAttribute('aria-label', `第 ${pages.length + 1} 页`);
      group.forEach(unit => section.append(unit.node)); body.append(section); pages.push(section); pageAnchors.push(group.map(unit => unit.anchor));
    }
    measure.remove();
    const focusedPage = active ? pages.findIndex(node => node.contains(active)) : -1;
    const anchored = anchor ? pageAnchors.findIndex(nodes => nodes.some(node => node === anchor || node.contains(anchor) || anchor.contains(node))) : -1;
    show(focusedPage >= 0 ? focusedPage : anchored >= 0 ? anchored : page);
    if (active?.isConnected && card.contains(active) && !active.closest('[hidden]')) {
      active.focus({ preventScroll: true });
      if (selection && selection[0] !== null && selection[1] !== null) {
        try { (active as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(selection[0], selection[1]); } catch { /* Range inputs have no text selection. */ }
      }
    } else if (active?.closest('[hidden]')) focusFirst();
    report(available, measurements);
    } catch {
      // An exceptional browser/layout failure must not strand controls in the hidden measuring tree.
      restore(); body.replaceChildren(...items); if (footer) card.append(footer);
      pages = []; pageAnchors = []; nav.hidden = true;
      const fallbackHeight = Math.max(44, Number.isFinite(available) && available > 0 ? available : viewportHeight() - 160);
      body.style.maxHeight = `${fallbackHeight}px`; body.style.overflowY = 'auto'; body.style.touchAction = 'pan-y';
      card.dataset.layoutError = 'true'; card.dataset.pageOverflow = 'true'; card.dataset.pageCount = '1'; delete card.dataset.pagePending;
      if (active?.isConnected && card.contains(active) && !active.closest('[hidden]')) active.focus({ preventScroll: true });
      report(fallbackHeight, 0);
    } finally { measure?.remove(); }
  };
  const resize = () => { if (!disposed && !frame) frame = requestAnimationFrame(arrange); };
  previous.onclick = () => show(page - 1, true); next.onclick = () => show(page + 1, true);
  window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize); window.addEventListener(VIEWPORT_CHANGE_EVENT, resize); window.addEventListener('orbbound-keyboard-changed', resize);
  items.forEach(node => body.append(node)); resize();
  return () => {
    disposed = true; cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); window.removeEventListener(VIEWPORT_CHANGE_EVENT, resize); window.removeEventListener('orbbound-keyboard-changed', resize);
    restore(); body.remove(); nav.remove(); slots.forEach(slot => slot.remove());
    card.classList.remove('paged-modal'); delete card.dataset.pageCount; delete card.dataset.pagePending; delete card.dataset.pageOverflow; delete card.dataset.layoutDuration; delete card.dataset.layoutMeasurements; delete card.dataset.layoutError;
  };
}
