export function v5CountdownParts(label: string): readonly [string, string] | null {
  const parts = /^(?:再发射\s*|剩余\s*)?(\d+)\s*(次|发)$/.exec(label);
  return parts ? [parts[1], parts[2]] : null;
}

/** Keep the full countdown sentence available to assistive technology. */
export function setV5CountdownValue(element: HTMLElement, label: string, displayLabel = label): void {
  const token = `${label}\n${displayLabel}`;
  if (element.dataset.countdownToken === token) return;
  element.dataset.countdownToken = token;
  element.setAttribute('aria-label', label);
  const parts = v5CountdownParts(displayLabel);
  const value = element.ownerDocument.createElement('span');
  value.className = parts ? 'value-number' : 'value-number value-word';
  value.textContent = parts ? parts[0] : displayLabel;
  if (!parts) { element.replaceChildren(value); return; }
  const unit = element.ownerDocument.createElement('small');
  unit.className = 'unit'; unit.textContent = parts[1];
  element.replaceChildren(value, unit);
}

/** P is an optional convenience binding; existing user bindings always win. */
export function availablePauseShortcut(shortcuts: Readonly<Record<string, string>>): 'KeyP' | undefined {
  return Object.values(shortcuts).includes('KeyP') ? undefined : 'KeyP';
}
