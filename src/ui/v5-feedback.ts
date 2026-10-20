export function createRoundFeedback(board: HTMLElement, output: HTMLElement, reducedMotion: () => boolean) {
  const clock = board.ownerDocument.defaultView!;
  let comboTimer: number | undefined;
  let outcomeTimer: number | undefined;
  const hideCombo = () => {
    clock.clearTimeout(comboTimer); comboTimer = undefined;
    output.hidden = true; output.classList.remove('v5-combo-active');
  };
  const cancelOutcome = () => {
    clock.clearTimeout(outcomeTimer); outcomeTimer = undefined;
    board.classList.remove('v5-failure-wave');
  };
  return {
    combo(count: number): void {
      hideCombo();
      if (!Number.isFinite(count) || count < 2) return;
      output.textContent = `连击 ${Math.floor(count)}`;
      output.hidden = false;
      // Restart once per actual clearing shot, never from the frame loop.
      void output.offsetWidth;
      output.classList.add('v5-combo-active');
      comboTimer = clock.setTimeout(hideCombo, 1250);
    },
    finish(floorLoss: boolean, complete: () => void): void {
      hideCombo(); cancelOutcome();
      if (!floorLoss || reducedMotion()) { complete(); return; }
      board.classList.add('v5-failure-wave');
      outcomeTimer = clock.setTimeout(() => {
        outcomeTimer = undefined;
        board.classList.remove('v5-failure-wave'); complete();
      }, 280);
    },
    reset(): void { hideCombo(); cancelOutcome(); },
  };
}
