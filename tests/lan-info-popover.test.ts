import { afterEach, expect, it, vi } from 'vitest';
import { bindLanInfoPopover } from '../src/ui/lan-info-popover';

class DocumentStub extends EventTarget { activeElement: ElementStub | null = null; }
class ElementStub extends EventTarget {
  hidden = false; inert = false; disabled = false; isConnected = true; tabIndex = 0;
  readonly attributes = new Map<string, string>();
  readonly children: ElementStub[] = [];
  readonly classes = new Set<string>();
  readonly classList = { add: (value: string) => this.classes.add(value), remove: (value: string) => this.classes.delete(value), contains: (value: string) => this.classes.has(value) };
  parentElement: ElementStub | null = null;
  constructor(readonly ownerDocument: DocumentStub, readonly tagName = 'DIV', public id = '') { super(); }
  append(...children: ElementStub[]) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const value = part.trim();
      if (value === '[hidden]') return this.hidden;
      if (value === ':disabled') return this.disabled;
      if (value.startsWith('#')) return this.id === value.slice(1);
      if (value.startsWith('.')) return this.classes.has(value.slice(1));
      if (value.startsWith('[')) return this.attributes.has(value.slice(1, -1));
      return this.tagName.toLowerCase() === value;
    });
  }
  closest(selector: string): ElementStub | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector: string): ElementStub[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  getClientRects() { return this.closest('[hidden]') ? [] : [{}]; }
  focus() { if (!this.inert && !this.closest('[hidden]')) this.ownerDocument.activeElement = this; }
  override dispatchEvent(event: Event): boolean {
    if (!Object.prototype.hasOwnProperty.call(event, 'target')) Object.defineProperty(event, 'target', { value: this });
    const result = super.dispatchEvent(event);
    if (event.bubbles && !event.cancelBubble) (this.parentElement ?? this.ownerDocument).dispatchEvent(event);
    return result;
  }
}

const disposals: Array<() => void> = [];
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); });

function setup() {
  const doc = new DocumentStub(); vi.stubGlobal('document', doc);
  const element = (tag = 'DIV', id = '') => new ElementStub(doc, tag, id);
  const root = element(), top = element(), body = element(), layer = element('DIV', 'lan-info-layer');
  const toggle = element('BUTTON', 'lan-info-toggle'), panel = element('SECTION', 'lan-info-panel');
  const title = element('H2'), dismiss = element('BUTTON'), backdrop = element('BUTTON'), nested = element('SPAN');
  top.classes.add('lan-top'); body.classes.add('lan-body');
  dismiss.setAttribute('data-lan-info-dismiss', ''); backdrop.setAttribute('data-lan-info-dismiss', '');
  dismiss.append(nested); top.append(toggle); panel.append(title, dismiss); layer.append(backdrop, panel); root.append(top, body, layer);
  const bind = () => {
    const controller = bindLanInfoPopover(root as unknown as HTMLElement)!;
    disposals.push(controller.dispose); return controller;
  };
  const controller = bind();
  return { root, top, body, layer, toggle, panel, title, dismiss, nested, backdrop, doc, controller, bind };
}

function send(target: EventTarget, type: string, values: Record<string, unknown> = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, values); target.dispatchEvent(event); return event;
}

it('does not bind unrelated LAN views with incomplete dialog markup', () => {
  const doc = new DocumentStub(), root = new ElementStub(doc);
  expect(bindLanInfoPopover(root as unknown as HTMLElement)).toBeUndefined();
  const toggle = new ElementStub(doc, 'BUTTON', 'lan-info-toggle'); root.append(toggle);
  expect(bindLanInfoPopover(root as unknown as HTMLElement)).toBeUndefined();
  expect(toggle.getAttribute('aria-expanded')).toBeNull();
});

it('synchronizes visibility, accessibility, focus and background inertness across repeated toggles', async () => {
  const game = setup(), changed = vi.fn(); game.root.addEventListener('orbbound-lan-info-toggle', changed);
  game.body.inert = true;
  expect(game.layer.hidden).toBe(true); expect(game.controller.close()).toBe(false);
  expect(game.toggle.getAttribute('aria-controls')).toBe(game.panel.id);
  expect(game.panel.getAttribute('role')).toBe('dialog'); expect(game.panel.getAttribute('aria-modal')).toBe('true');
  for (let index = 0; index < 2; index++) {
    send(game.toggle, 'click'); await Promise.resolve();
    expect(game.layer.hidden).toBe(false); expect(game.toggle.getAttribute('aria-expanded')).toBe('true');
    expect(game.root.classList.contains('lan-info-open')).toBe(true);
    expect(game.top.inert).toBe(true); expect(game.body.inert).toBe(true); expect(game.doc.activeElement).toBe(game.title);
    send(game.toggle, 'click');
    expect(game.layer.hidden).toBe(true); expect(game.toggle.getAttribute('aria-expanded')).toBe('false');
    expect(game.root.classList.contains('lan-info-open')).toBe(false);
    expect(game.top.inert).toBe(false); expect(game.body.inert).toBe(true); expect(game.doc.activeElement).toBe(game.toggle);
  }
  expect(changed).toHaveBeenCalledTimes(4);
});

it('swallows the entire backdrop gesture before dismissing on click', () => {
  const game = setup(), gameplay = vi.fn();
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click']) game.root.addEventListener(type, gameplay);
  send(game.toggle, 'click');
  send(game.backdrop, 'pointerdown'); expect(game.layer.hidden).toBe(false);
  send(game.backdrop, 'pointerup'); expect(game.layer.hidden).toBe(false);
  send(game.backdrop, 'pointercancel'); expect(game.layer.hidden).toBe(false);
  send(game.backdrop, 'click');
  expect(game.layer.hidden).toBe(true); expect(gameplay).not.toHaveBeenCalled();
});

it('keeps panel clicks open and accepts a close-button descendant', () => {
  const game = setup(); send(game.toggle, 'click');
  send(game.title, 'click'); expect(game.layer.hidden).toBe(false);
  send(game.nested, 'click'); expect(game.layer.hidden).toBe(true);
});

it('consumes Escape before leave-room handlers and makes native-back close idempotent', async () => {
  const game = setup(), leaveRoom = vi.fn(); game.doc.addEventListener('keydown', leaveRoom);
  send(game.toggle, 'click');
  const escape = send(game.doc, 'keydown', { key: 'Escape' });
  expect(escape.defaultPrevented).toBe(true); expect(leaveRoom).not.toHaveBeenCalled();
  expect(game.layer.hidden).toBe(true); expect(game.controller.close()).toBe(false);
  const closedEscape = send(game.doc, 'keydown', { key: 'Escape' });
  expect(closedEscape.defaultPrevented).toBe(false); expect(leaveRoom).toHaveBeenCalledOnce();
  send(game.toggle, 'click'); await Promise.resolve(); expect(game.doc.activeElement).toBe(game.title);
  expect(game.controller.close(false)).toBe(true); expect(game.controller.close(false)).toBe(false);
  expect(game.doc.activeElement).not.toBe(game.toggle);
});

it('cancels pending initial focus when the dialog closes immediately', async () => {
  const game = setup(); game.doc.activeElement = game.toggle;
  send(game.toggle, 'click'); expect(game.controller.close()).toBe(true); await Promise.resolve();
  expect(game.doc.activeElement).toBe(game.toggle); expect(game.layer.hidden).toBe(true);
});

it('releases open-dialog focus work and listeners before a replacement render binds', async () => {
  const game = setup(), changed = vi.fn(); game.root.addEventListener('orbbound-lan-info-toggle', changed);
  game.doc.activeElement = game.toggle;
  send(game.toggle, 'click'); game.controller.dispose(); game.controller.dispose(); await Promise.resolve();
  expect(game.layer.hidden).toBe(true); expect(game.top.inert).toBe(false); expect(game.body.inert).toBe(false);
  expect(game.doc.activeElement).toBe(game.toggle); expect(game.root.classList.contains('lan-info-open')).toBe(false);
  expect(game.toggle.getAttribute('aria-expanded')).toBe('false'); expect(changed).toHaveBeenCalledTimes(2);
  send(game.toggle, 'click'); expect(game.layer.hidden).toBe(true); expect(changed).toHaveBeenCalledTimes(2);
  const escape = send(game.doc, 'keydown', { key: 'Escape' }); expect(escape.defaultPrevented).toBe(false);
  const gameplay = vi.fn(); game.root.addEventListener('pointerup', gameplay); send(game.backdrop, 'pointerup'); expect(gameplay).toHaveBeenCalledOnce();
  const replacement = game.bind(); send(game.toggle, 'click'); await Promise.resolve();
  expect(game.layer.hidden).toBe(false); expect(game.doc.activeElement).toBe(game.title); expect(changed).toHaveBeenCalledTimes(3);
  expect(replacement.close()).toBe(true); expect(changed).toHaveBeenCalledTimes(4);
});
