export function pageCapacity(height: number, reserved: number, itemHeight: number, maximum: number, columns = 1): number {
  return Math.max(columns, Math.min(maximum, Math.floor(Math.max(0, height - reserved) / itemHeight) * columns));
}
export function viewportHeight(): number {
  return typeof window === 'undefined' ? 720 : window.visualViewport?.height ?? window.innerHeight;
}
export function bindViewportShell(): () => void {
  const update = () => {
    const viewport = window.visualViewport;
    document.documentElement.style.setProperty('--app-height', `${viewport?.height ?? window.innerHeight}px`);
    document.documentElement.style.setProperty('--app-width', `${viewport?.width ?? window.innerWidth}px`);
  };
  update(); window.addEventListener('resize', update); window.visualViewport?.addEventListener('resize', update);
  return () => { window.removeEventListener('resize', update); window.visualViewport?.removeEventListener('resize', update); };
}

/** Move existing nodes into bounded pages so event bindings and form values survive paging. */
export function bindModalPages(card: HTMLElement): () => void {
  if (card.matches('.settings-card,.practice-card,.campaign-picker,.history-card')) return () => {};
  card.classList.add('paged-modal');
  const children = [...card.children] as HTMLElement[];
  const fixed = children.filter(node => node.matches('.modal-close,.history-close,h2,.modal-footer'));
  const items = children.filter(node => !fixed.includes(node));
  // These collections can be split at meaningful item boundaries.
  let units = items.flatMap(node => node.matches('.tutorial-steps,.mobile-menu-actions') ? [...node.children] as HTMLElement[] : [node]);
  for (const item of items) item.remove();
  const body = document.createElement('div'); body.className = 'modal-pages';
  const nav = document.createElement('nav'); nav.className = 'page-navigation'; nav.setAttribute('aria-label', '内容分页');
  nav.innerHTML = '<button class="quiet-button" aria-label="上一页">‹</button><span></span><button class="quiet-button" aria-label="下一页">›</button>';
  const footer = fixed.find(node => node.matches('.modal-footer'));
  card.insertBefore(body, footer ?? null); card.insertBefore(nav, footer ?? null);
  const previous = nav.children[0] as HTMLButtonElement, label = nav.children[1], next = nav.children[2] as HTMLButtonElement;
  let page = 0, pages: HTMLElement[] = [], disposed = false, frame = 0;
  const show = (index: number, focus = false) => {
    page = Math.max(0, Math.min(index, pages.length - 1));
    pages.forEach((node, i) => { node.hidden = i !== page; });
    previous.disabled = page === 0; next.disabled = page >= pages.length - 1;
    label.textContent = `${page + 1} / ${Math.max(1, pages.length)}`;
    nav.hidden = pages.length <= 1;
    if (focus) (pages[page]?.querySelector<HTMLElement>('button,input,select') ?? card.querySelector<HTMLElement>('h2'))?.focus({ preventScroll: true });
  };
  const arrange = () => {
    if (disposed || !card.isConnected) return;
    const anchor = pages[page]?.firstElementChild;
    nav.hidden = false;
    body.replaceChildren(); pages = [];
    const create = () => { const element = document.createElement('section'); element.className = 'modal-page'; body.append(element); pages.push(element); return element; };
    let current = create();
    const expanded: HTMLElement[] = [];
    for (const original of units) {
      current.append(original);
      if (original.scrollHeight > body.clientHeight && original.matches('p,.tutorial-step') && !original.querySelector('button,input,select,a')) {
        const content = original.textContent ?? ''; original.remove();
        let offset = 0;
        while (offset < content.length) {
          const part = document.createElement('p'); current.append(part);
          let end = offset + 1; part.textContent = content.slice(offset, end);
          while (end < content.length && part.scrollHeight <= body.clientHeight) { end++; part.textContent = content.slice(offset, end); }
          if (part.scrollHeight > body.clientHeight && end > offset + 1) end--;
          part.textContent = content.slice(offset,end); part.remove(); expanded.push(part); offset = end;
        }
      } else { original.remove(); expanded.push(original); }
    }
    units = expanded;
    for (const unit of units) {
      current.append(unit);
      if (current.children.length > 1 && current.scrollHeight > body.clientHeight + 1) {
        unit.remove(); current.hidden = true; current = create(); current.append(unit);
      }
    }
    const anchored = pages.findIndex(node => anchor && node.contains(anchor));
    show(anchored >= 0 ? anchored : page);
  };
  previous.onclick = () => show(page - 1, true); next.onclick = () => show(page + 1, true);
  const resize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(arrange); };
  window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize);
  resize();
  return () => { disposed = true; cancelAnimationFrame(frame); window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); };
}
