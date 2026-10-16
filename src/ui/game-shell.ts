export interface GameShellOptions { touch: boolean; immersive: boolean; mode: string }
/** Both renderers keep their lifecycle while sharing the same platform layout contract. */
export function syncGameShell(root: HTMLElement, options: GameShellOptions): void {
  root.classList.add('game-shell');
  root.classList.toggle('game-shell--touch', options.touch);
  root.classList.toggle('game-shell--desktop', !options.touch);
  root.classList.toggle('game-shell--immersive', options.touch && options.immersive);
  root.dataset.mode = options.mode;
}
