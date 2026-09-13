import type { Settings } from '../storage/storage';
import { gameAudio } from '../game/audio';
import { haptic } from '../game/feedback';
import { fineRotationSpeed } from '../game/rotation';
import { bindSteeringControl } from '../game/steering-control';

export function settingsMarkup(settings: Settings, mobile: boolean): string {
  const range = (key: keyof Settings, title: string, min: number, max: number, unit: string, hint: string) => `<label class="setting-row range-setting" for="setting-${key}"><span><strong>${title}</strong><small>${hint}</small></span><output id="value-${key}">${settings[key]}${unit}</output><input id="setting-${key}" data-setting="${key}" data-unit="${unit}" type="range" min="${min}" max="${max}" value="${settings[key]}" aria-label="${title}"></label>`;
  const toggle = (key: keyof Settings, title: string, hint: string) => `<div class="setting-row"><div><strong>${title}</strong><small>${hint}</small></div><label class="switch"><input data-setting="${key}" type="checkbox" aria-label="${title}" ${settings[key] ? 'checked' : ''}><span></span></label></div>`;
  return `<button class="modal-close" data-close-modal>完成</button><p class="eyebrow">声音与操作</p><h2>调整手感，找到节奏</h2><p>设置自动保存，随时可以再调整。</p>
    <h3>声音</h3>
    ${range('volume', '音效音量', 0, 100, '%', '发射轻一点，消除更清楚；0 为静音。')}
    ${range('musicVolume', '音乐音量', 0, 100, '%', '菜单保留原曲，对局使用稍快的新曲。')}
    <div class="sound-preview-actions"><button class="quiet-button" id="preview-menu">试听菜单曲</button><button class="quiet-button" id="preview-play">试听对局曲</button><button class="quiet-button" id="preview-sound">试听消除音效</button></div><p id="music-preview-status" class="mode-note" role="status">当前：菜单曲</p>
    ${toggle('aimAssist', '瞄准辅助', '显示反弹路线与空心落点圈。')}
    ${mobile ? `<h3>操作手感</h3>
      ${range('sensitivity', '微调灵敏度', 50, 150, '%', '中间慢，两侧快；松手立即停止。')}
      ${toggle('centerSnap', '中点吸附', '上滑条靠近正中时，轻轻吸附到竖直方向。')}
      <div class="control-preview"><div class="preview-cannon" aria-hidden="true"><span id="preview-barrel">↑</span></div><output id="preview-angle">0.0°</output><label for="preview-fine">按住滑条，试试微调</label><input id="preview-fine" type="range" min="-100" max="100" value="0" aria-label="体验微调"><button class="quiet-button" id="preview-fire">试试发射反馈</button></div>
      ${toggle('hapticShoot', '发射轻震', '只在发射成功时轻震。')}
      ${toggle('hapticMatch', '消除轻震', '同色消除或悬空掉落时轻震。')}
      <h3>握持位置</h3>
      <div class="setting-row"><div><strong>左右调换</strong><small>交换发射键和双滑条。</small></div><button id="setting-swap" class="quiet-button">${settings.controlsSwapped ? '发射在右 ⇄' : '发射在左 ⇄'}</button></div>
      ${range('fireSize', '发射键宽度', 76, 120, 'px', '按手指大小调整。')}
      ${range('controlOffset', '控制区下移', 0, 48, 'px', '小屏会自动限制下移距离。')}
      <div class="grip-preview" aria-label="按键位置预览"><span class="grip-fire">发射</span><span class="grip-sliders">方向 ━━━<br>微调 ━━━</span></div>` : ''}
    <div class="modal-footer"><button class="primary-button" data-close-modal>完成设置 ✓</button></div>`;
}

export function bindSettingsPanel(root: HTMLElement, settings: Settings, onChange: (commit: boolean) => void): () => void {
  const abort = new AbortController();
  const listen = (element: Element | null, event: string, fn: EventListener) => element?.addEventListener(event, fn, { signal: abort.signal });
  const updateGrip = () => {
    const grip = root.querySelector<HTMLElement>('.grip-preview');
    if (!grip) return;
    grip.classList.toggle('swapped', settings.controlsSwapped);
    grip.style.setProperty('--preview-width', `${settings.fireSize * 0.6}px`);
    grip.style.marginTop = `${8 + settings.controlOffset * 0.4}px`;
  };
  root.querySelectorAll<HTMLInputElement>('[data-setting]').forEach(input => {
    const key = input.dataset.setting as keyof Settings;
    listen(input, 'input', () => {
      Object.assign(settings, { [key]: input.type === 'checkbox' ? input.checked : Number(input.value) });
      const output = root.querySelector(`#value-${key}`);
      if (output) output.textContent = `${input.value}${input.dataset.unit ?? ''}`;
      onChange(false); updateGrip();
    });
    listen(input, 'change', () => onChange(true));
  });
  listen(root.querySelector('#setting-swap'), 'click', event => {
    settings.controlsSwapped = !settings.controlsSwapped; onChange(true); updateGrip();
    (event.currentTarget as HTMLElement).textContent = settings.controlsSwapped ? '发射在右 ⇄' : '发射在左 ⇄';
  });
  for (const scene of ['menu', 'play'] as const) listen(root.querySelector(`#preview-${scene}`), 'click', () => {
    gameAudio.unlock(); gameAudio.setScene(scene);
    root.querySelector('#music-preview-status')!.textContent = `正在试听：${scene === 'menu' ? '菜单曲' : '对局曲'}`;
  });
  listen(root.querySelector('#preview-sound'), 'click', () => gameAudio.blip('match'));
  let raf = 0, lastTime = 0, velocity = 0, angle = 0;
  const barrel = root.querySelector<HTMLElement>('#preview-barrel');
  const tick = (time: number) => {
    if (!velocity || !root.isConnected || document.hidden) { raf = 0; return; }
    angle = Math.max(-78, Math.min(78, angle + fineRotationSpeed(velocity, settings.sensitivity) * Math.min(50, time - lastTime) / 1000));
    lastTime = time;
    if (barrel) barrel.style.transform = `rotate(${angle}deg)`;
    root.querySelector('#preview-angle')!.textContent = `${angle.toFixed(1)}°`;
    raf = requestAnimationFrame(tick);
  };
  const fine = root.querySelector<HTMLInputElement>('#preview-fine');
  const binding = fine ? bindSteeringControl(fine, { fine: true, active: () => !document.hidden,
    onValue: value => { velocity = value; if (!value) { cancelAnimationFrame(raf); raf = 0; }
      else if (!raf) { lastTime = performance.now(); raf = requestAnimationFrame(tick); } } }) : null;
  listen(root.querySelector('#preview-fire'), 'click', () => {
    gameAudio.blip('shoot'); haptic('shoot', settings);
    barrel?.animate([{ translate: '0 0' }, { translate: '0 5px' }, { translate: '0 0' }], { duration: 160 });
  });
  window.addEventListener('blur', () => binding?.reset(), { signal: abort.signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) binding?.reset(); }, { signal: abort.signal });
  updateGrip();
  return () => { binding?.dispose(); cancelAnimationFrame(raf); abort.abort(); onChange(true); gameAudio.setScene('menu'); };
}
