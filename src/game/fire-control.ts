/** Pointer down works for the second finger even while a slider owns the first. */
export function bindFireButton(button: HTMLButtonElement, fire: () => void): void {
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0 || button.disabled) return;
    event.preventDefault(); // Keep slider focus and prevent a compatibility click.
    fire();
  });
  button.addEventListener('click', event => {
    if (event.detail === 0 && !button.disabled) fire(); // Keyboard / accessibility activation.
  });
}
