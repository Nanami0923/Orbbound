import { DEFAULT_SETTINGS, type Settings } from '../storage/storage';
import { gameAudio } from '../game/audio';
import { haptic } from '../game/feedback';
import { fineRotationSpeed } from '../game/rotation';
import { bindSteeringControl } from '../game/steering-control';

export function settingsMarkup(settings: Settings, mobile: boolean): string {
  const range = (key: keyof Settings, title: string, min: number, max: number, unit: string, hint: string) => `<label class="setting-row range-setting" for="setting-${key}"><span><strong>${title}</strong><small>${hint}</small></span><output id="value-${key}">${settings[key]}${unit}</output><input id="setting-${key}" data-setting="${key}" data-unit="${unit}" type="range" min="${min}" max="${max}" value="${settings[key]}" aria-label="${title}"></label>`;
  const toggle = (key: keyof Settings, title: string, hint: string) => `<div class="setting-row"><div><strong>${title}</strong><small>${hint}</small></div><label class="switch"><input data-setting="${key}" type="checkbox" aria-label="${title}" ${settings[key] ? 'checked' : ''}><span></span></label></div>`;
  return `<button class="modal-close" data-close-modal>完成</button><p class="eyebrow">声音与操作</p><h2>调整手感，找到节奏</h2><p>设置自动保存，随时可以再调整。</p>
    <nav class="settings-categories" data-settings-page="root" aria-label="设置分类"><button class="quiet-button" data-settings-open="sound">声音与音乐 ›</button><button class="quiet-button" data-settings-open="aim">瞄准辅助 ›</button>${mobile ? '<button class="quiet-button" data-settings-open="control">操作与反馈 ›</button><button class="quiet-button" data-settings-open="layout">按键布局 ›</button>' : ''}<button class="quiet-button" data-settings-open="reset">恢复默认设置 ›</button></nav>
    <button class="quiet-button settings-back" data-settings-back hidden>‹ 返回设置</button>
    <section data-settings-page="sound" hidden><h3 tabindex="-1">声音与音乐</h3>
    ${range('volume', '音效音量', 0, 100, '%', '发射轻一点，消除更清楚；0 为静音。')}
    ${range('musicVolume', '音乐音量', 0, 100, '%', '全局使用原曲，棋盘越接近底部，节奏越快。')}
    <div class="sound-preview-actions"><button class="quiet-button" id="preview-menu">试听菜单曲</button><button class="quiet-button" id="preview-play">试听紧张节奏</button><button class="quiet-button" id="preview-sound">试听消除音效</button></div><p id="music-preview-status" class="mode-note" role="status">当前：菜单曲</p>
    </section><section data-settings-page="aim" hidden><h3 tabindex="-1">瞄准辅助</h3>
    ${toggle('aimAssist', '瞄准辅助', '显示反弹路线与空心落点圈。')}
    </section>${mobile ? `<section data-settings-page="control" hidden><h3 tabindex="-1">操作与反馈</h3>
      ${range('sensitivity', '微调灵敏度', 50, 150, '%', '中间慢，两侧快；松手立即停止。')}
      <div class="control-preview"><div class="preview-cannon" aria-hidden="true"><span id="preview-barrel">↑</span></div><output id="preview-angle">0.0°</output><label for="preview-fine">按住滑条，试试微调</label><input id="preview-fine" type="range" min="-100" max="100" value="0" aria-label="体验微调"><button class="quiet-button" id="preview-fire">试试发射反馈</button></div>
      ${toggle('hapticShoot', '发射轻震', '只在发射成功时轻震。')}
      ${toggle('hapticMatch', '消除轻震', '同色消除或悬空掉落时轻震。')}
      </section><section data-settings-page="layout" hidden><h3 tabindex="-1">按键布局</h3>
      <div class="setting-row"><div><strong>左右调换</strong><small>交换发射键和双滑条。</small></div><button id="setting-swap" class="quiet-button">${settings.controlsSwapped ? '发射在右 ⇄' : '发射在左 ⇄'}</button></div>
      ${range('fireSize', '发射键宽度', 76, 120, 'px', '按手指大小调整。')}
      ${range('controlOffset', '控制区下移', 0, 48, 'px', '小屏会自动限制下移距离。')}
      <div class="grip-preview" aria-label="按键位置预览"><span class="grip-fire">发射</span><span class="grip-sliders">方向 ━━━<br>微调 ━━━</span></div></section>` : ''}
    <section data-settings-page="reset" hidden><h3 tabindex="-1">恢复默认设置</h3><p>恢复音量、操作和显示设置。存档、得分和排行榜不会改变。</p><button class="primary-button" id="settings-reset">恢复默认设置</button><p id="settings-reset-status" role="status"></p></section>
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
    gameAudio.unlock(); gameAudio.setPressure(scene === 'play' ? 1 : 0); gameAudio.setScene(scene);
    root.querySelector('#music-preview-status')!.textContent = `正在试听：${scene === 'menu' ? '原速' : '紧张节奏'}`;
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
  const navigate = (page: string) => {
    binding?.reset(); cancelAnimationFrame(raf); raf = 0;
    gameAudio.stopEffects(); gameAudio.setScene('menu');
    root.querySelector('#music-preview-status')!.textContent = '当前：菜单曲';
    root.querySelectorAll<HTMLElement>('[data-settings-page]').forEach(section => { section.hidden = section.dataset.settingsPage !== page; });
    root.querySelector<HTMLButtonElement>('[data-settings-back]')!.hidden = page === 'root';
    root.querySelectorAll<HTMLElement>('.settings-card > h2, .settings-card > p').forEach(element => { element.hidden = page !== 'root'; });
    root.querySelector<HTMLElement>('.modal-card')?.scrollTo(0, 0);
    root.querySelector<HTMLElement>(`[data-settings-page="${page}"] ${page === 'root' ? 'button' : 'h3'}`)?.focus({ preventScroll: true });
  };
  root.querySelectorAll<HTMLElement>('[data-settings-open]').forEach(button => listen(button, 'click', () => navigate(button.dataset.settingsOpen!)));
  listen(root.querySelector('[data-settings-back]'), 'click', () => navigate('root'));
  listen(root.querySelector('#settings-reset'), 'click', () => {
    binding?.reset(); gameAudio.stopEffects();
    Object.assign(settings, DEFAULT_SETTINGS); onChange(true);
    root.querySelectorAll<HTMLInputElement>('[data-setting]').forEach(input => {
      const key = input.dataset.setting as keyof Settings;
      if (input.type === 'checkbox') input.checked = Boolean(settings[key]);
      else input.value = String(settings[key]);
      const output = root.querySelector(`#value-${key}`);
      if (output) output.textContent = `${settings[key]}${input.dataset.unit ?? ''}`;
    });
    const swap = root.querySelector('#setting-swap'); if (swap) swap.textContent = '发射在左 ⇄';
    angle = 0; if (barrel) barrel.style.transform = 'rotate(0deg)';
    const angleOutput = root.querySelector('#preview-angle'); if (angleOutput) angleOutput.textContent = '0.0°';
    updateGrip(); root.querySelector('#settings-reset-status')!.textContent = '已恢复默认设置';
  });
  updateGrip();
  return () => { binding?.dispose(); cancelAnimationFrame(raf); abort.abort(); onChange(true); gameAudio.stopEffects(); gameAudio.setScene('menu'); };
}

export function settingsBack(root: HTMLElement): boolean {
  const back = root.querySelector<HTMLButtonElement>('[data-settings-back]');
  if (!back || back.hidden) return false;
  back.click(); return true;
}
