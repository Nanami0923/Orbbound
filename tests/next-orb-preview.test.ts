import { expect, it, vi } from 'vitest';
import { ORB_THEMES, ORB_THEMES_V5 } from '../src/content/theme';
import { nextOrbPreviewMarkup, updateOrbPreview } from '../src/ui/next-orb-preview';

it('provides the same labeled preview structure for single-player and LAN slots', () => {
  for (const id of ['next-orb-preview', 'lan-next-orb-preview']) {
    const markup = nextOrbPreviewMarkup(id);
    expect(markup).toContain('class="next-card orb-preview-card"'); expect(markup).toContain('class="card-kicker">下一球');
    expect(markup).toContain('class="next-preview"'); expect(markup).toContain(`id="${id}" class="dom-orb" aria-label="下一球"`);
  }
  expect(nextOrbPreviewMarkup('a"b')).toContain('id="a&quot;b"');
});

it('updates every theme consistently and performs no writes for an unchanged color', () => {
  const writes = vi.fn(), style = new Proxy({ backgroundColor: '', setProperty: writes }, { set(target, key, value) { writes(key, value); return Reflect.set(target, key, value); } });
  const element = { dataset: new Proxy<Record<string, string>>({}, { set(target, key, value) { writes(key, value); return Reflect.set(target, key, value); } }), style } as unknown as HTMLElement;
  for (const theme of ORB_THEMES) {
    updateOrbPreview(element, theme.id);
    expect(element.dataset).toMatchObject({ colorId: String(theme.id), symbol: theme.symbol });
    expect(style.backgroundColor).toBe(theme.cssColor); expect(writes).toHaveBeenLastCalledWith('--orb-ink', theme.ink);
    const count = writes.mock.calls.length; updateOrbPreview(element, theme.id); expect(writes).toHaveBeenCalledTimes(count);
  }
  expect(() => updateOrbPreview(null, 0)).not.toThrow();
});

it('updates the DOM preview with the shared V5 vector artwork and refreshes when the theme key changes', () => {
  const writes = vi.fn(), style = new Proxy({ backgroundColor: '', setProperty: writes }, { set(target, key, value) { writes(key, value); return Reflect.set(target, key, value); } });
  const element = { dataset: {}, style, innerHTML: '' } as unknown as HTMLElement;
  const classes = new Set<string>();
  vi.stubGlobal('document', { documentElement: { classList: { contains: (name: string) => classes.has(name) } } });
  try {
    updateOrbPreview(element, 2);
    expect(element.dataset.themeVariant).toBe('legacy');
    expect(element.innerHTML).toBe('');
    classes.add('android-v5');
    updateOrbPreview(element, 2);
    expect(element.dataset).toMatchObject({ colorId: '2', symbol: '✦', themeVariant: 'v5' });
    expect(element.innerHTML).toContain('class="orb-symbol-vector" viewBox="6.5 6.5 35 35"');
    expect(element.innerHTML).toContain('M18.102 25Q');
    expect(element.innerHTML).toContain('cx="18" cy="32" r="1.7"');
    expect(element.innerHTML).toContain(ORB_THEMES_V5[2].cssColor);
    expect(style.backgroundColor).toBe('transparent');
    const count = writes.mock.calls.length;
    updateOrbPreview(element, 2);
    expect(writes).toHaveBeenCalledTimes(count);
  } finally {
    vi.unstubAllGlobals();
  }
});
