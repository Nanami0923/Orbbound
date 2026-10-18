/** Keep semantic phrases intact; long comma-separated titles get intentional breaks. */
export function headingLines(text: string): string[] {
  return text.length > 8 && /[，,]/.test(text) ? text.match(/[^，,]+[，,]?/g) ?? [text] : [text];
}
export function formatHeadings(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('h1, h2').forEach(heading => {
    if (heading.children.length) return;
    const text = heading.textContent ?? '';
    const lines = headingLines(text);
    if (lines.length < 2) return;
    heading.replaceChildren(...lines.map(line => {
      const span = document.createElement('span'); span.className = 'heading-clause'; span.textContent = line; return span;
    }));
  });
}

/** Keep the title centered in the whole dialog, with independent action slots. */
export function prepareModalHeader(card: HTMLElement): void {
  if (card.querySelector('.modal-heading')) return;
  const title = card.querySelector<HTMLElement>('h2');
  if (!title) return;
  const document = card.ownerDocument;
  const parent = title.parentElement;
  const header = parent !== card && parent?.parentElement === card ? parent : document.createElement('header');
  if (header !== parent) card.prepend(header);
  header.classList.add('modal-heading'); header.setAttribute('data-page-fixed', '');
  const start = document.createElement('div'), center = document.createElement('div'), end = document.createElement('div');
  start.className = 'modal-heading-start'; center.className = 'modal-heading-title'; end.className = 'modal-heading-end';
  const close = card.querySelector<HTMLElement>('.modal-close,.history-close,[data-close-modal]');
  for (const child of [...header.children]) {
    if (child === title || child === close) continue;
    if (child.tagName === 'BUTTON') start.append(child);
    else center.append(child);
  }
  center.append(title);
  if (close) end.append(close);
  header.replaceChildren(start, center, end);
}
