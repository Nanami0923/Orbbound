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
