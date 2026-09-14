import { DEFAULT_SETTINGS, type Settings } from '../storage/storage';
import { gameAudio } from '../game/audio';
import { haptic } from '../game/feedback';
import { fineRotationSpeed } from '../game/rotation';
import { bindSteeringControl } from '../game/steering-control';
import { DEFAULT_SHORTCUTS, SHORTCUT_LABELS, shortcutLabel, validShortcutCode, type ShortcutAction } from '../game/shortcuts';

export function settingsMarkup(settings: Settings, mobile: boolean): string {
  const range = (key: keyof Settings, title: string, min: number, max: number, unit: string, hint: string) => `<label class="setting-row range-setting" for="setting-${key}"><span><strong>${title}</strong><small>${hint}</small></span><output id="value-${key}">${settings[key]}${unit}</output><input id="setting-${key}" data-setting="${key}" data-unit="${unit}" type="range" min="${min}" max="${max}" value="${settings[key]}" aria-label="${title}"></label>`;
  const toggle = (key: keyof Settings, title: string, hint: string) => `<div class="setting-row"><div><strong>${title}</strong><small>${hint}</small></div><label class="switch"><input data-setting="${key}" type="checkbox" aria-label="${title}" ${settings[key] ? 'checked' : ''}><span></span></label></div>`;
  const shortcuts = `<section data-settings-page="shortcuts" hidden><h3 tabindex="-1">键盘快捷键</h3><p>点击按键后按下新键。支持字母、数字、方向键、空格、Enter 和 Esc；每个动作使用不同按键。F11 固定切换全屏。</p><div class="shortcut-settings">${(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map(action => `<div class="setting-row"><strong>${SHORTCUT_LABELS[action]}</strong><button type="button" class="quiet-button" data-shortcut-edit="${action}" aria-label="修改${SHORTCUT_LABELS[action]}快捷键">${shortcutLabel(settings.shortcuts[action])}</button></div>`).join('')}</div><p id="shortcut-status" role="status">鼠标左右键始终可以发射。</p></section>`;
  return `<button class="modal-close" data-close-modal>完成</button><p class="eyebrow">声音与操作</p><h2>调整手感，找到节奏</h2><p>设置自动保存，随时可以再调整。</p>
    <nav class="settings-categories" data-settings-page="root" aria-label="设置分类"><button class="quiet-button" data-settings-open="sound">声音与音乐 ›</button><button class="quiet-button" data-settings-open="aim">瞄准辅助 ›</button>${mobile ? '<button class="quiet-button" data-settings-open="control">操作与反馈 ›</button><button class="quiet-button" data-settings-open="layout">按键布局 ›</button>' : ''}${!mobile ? '<button class="quiet-button" data-settings-open="backup">存档备份与迁移 ›</button>' : ''}<button class="quiet-button" data-settings-open="reset">恢复默认设置 ›</button></nav>
    ${!mobile ? '<button class="quiet-button shortcut-category" data-settings-open="shortcuts" data-settings-page="root">键盘快捷键 ›</button>' : ''}
    <button class="quiet-button settings-back" data-settings-back hidden>‹ 返回设置</button>
    <section data-settings-page="sound" hidden><h3 tabindex="-1">声音与音乐</h3>
    ${range('volume', '音效音量', 0, 100, '%', '发射轻一点，消除更清楚；0 为静音。')}
    ${range('musicVolume', '音乐音量', 0, 100, '%', '调整背景音乐音量，0 为静音。')}
    ${toggle('adaptiveMusic', '局内音乐加速', '开启后随棋盘压力加快；关闭后始终使用原速，音高不变。')}
    <div class="sound-preview-actions"><button class="quiet-button" id="preview-menu">试听菜单曲</button><button class="quiet-button" id="preview-play">试听紧张节奏</button><button class="quiet-button" id="preview-sound">试听消除音效</button></div><p id="music-preview-status" class="mode-note" role="status">当前：菜单曲</p>
    </section><section data-settings-page="aim" hidden><h3 tabindex="-1">瞄准辅助</h3>
    ${toggle('aimAssist', '瞄准辅助', '显示反弹路线与空心落点圈。')}
    </section>${mobile ? `<section data-settings-page="control" hidden><h3 tabindex="-1">操作与反馈</h3>
      ${toggle('immersiveMode', '沉浸模式', '隐藏底部按钮；在整个棋盘（含发射区）按住拖动瞄准，松手发射。棋盘稍向下移。')}
      ${range('sensitivity', '微调灵敏度', 50, 150, '%', '中间慢，两侧快；松手立即停止。')}
      <div class="control-preview"><div class="preview-cannon" aria-hidden="true"><span id="preview-barrel">↑</span></div><output id="preview-angle">0.0°</output><label for="preview-fine">按住滑条，试试微调</label><input id="preview-fine" type="range" min="-100" max="100" value="0" aria-label="体验微调"><button class="quiet-button" id="preview-fire">试试发射反馈</button></div>
      ${toggle('hapticShoot', '发射轻震', '只在发射成功时轻震。')}
      ${toggle('hapticMatch', '消除轻震', '同色消除或悬空掉落时轻震。')}
      </section><section data-settings-page="layout" hidden><h3 tabindex="-1">按键布局</h3>
      <div class="setting-row"><div><strong>左右调换</strong><small>交换发射键和双滑条。</small></div><button id="setting-swap" class="quiet-button">${settings.controlsSwapped ? '发射在右 ⇄' : '发射在左 ⇄'}</button></div>
      ${range('fireSize', '发射键宽度', 76, 120, 'px', '按手指大小调整。')}
      ${range('controlOffset', '控制区下移', 0, 48, 'px', '小屏会自动限制下移距离。')}
      <div class="grip-preview" aria-label="按键位置预览"><span class="grip-fire">发射</span><span class="grip-sliders">方向 ━━━<br>微调 ━━━</span></div></section>` : ''}
    ${!mobile ? '<section data-settings-page="backup" hidden><h3 tabindex="-1">存档备份与迁移</h3><p>导出记录、对局和设置，或从旧版 Electron 读取本机存档。原存档不会删除。</p><div class="settings-categories"><button class="quiet-button" data-backup="export">导出备份</button><button class="quiet-button" data-backup="import">导入备份</button><button class="quiet-button" data-backup="legacy">导入旧 Windows 版存档</button></div></section>' : ''}
    ${!mobile ? shortcuts : ''}
    <section data-settings-page="reset" hidden><h3 tabindex="-1">恢复默认设置</h3><p>恢复音量、操作、快捷键和显示设置。存档、得分和排行榜不会改变。</p><button class="primary-button" id="settings-reset">恢复默认设置</button><p id="settings-reset-status" role="status"></p></section>
    <div class="modal-footer"><button class="primary-button" data-close-modal>完成设置 ✓</button></div>`;
}

export function bindSettingsPanel(root: HTMLElement, settings: Settings, onChange: (commit: boolean) => void): () => void {
  const abort = new AbortController();
  const listen = (element: Element | null, event: string, fn: EventListener) => element?.addEventListener(event, fn, { signal: abort.signal });
  let editing: ShortcutAction | null = null;
  const refreshShortcuts = () => root.querySelectorAll<HTMLElement>('[data-shortcut-edit]').forEach(button => {
    const action = button.dataset.shortcutEdit as ShortcutAction;
    button.textContent = editing === action ? '请按键…' : shortcutLabel(settings.shortcuts[action]);
    button.classList.toggle('listening', editing === action);
  });
  root.querySelectorAll<HTMLElement>('[data-shortcut-edit]').forEach(button => listen(button, 'click', () => { editing = button.dataset.shortcutEdit as ShortcutAction; refreshShortcuts(); }));
  root.addEventListener('keydown', event => {
    if (!editing || event.key === 'Tab') return;
    event.preventDefault(); event.stopPropagation();
    if (event.repeat) return;
    const status = root.querySelector('#shortcut-status')!;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !validShortcutCode(event.code)) { status.textContent = '请选择单个字母、数字、方向键、空格、Enter 或 Esc。'; return; }
    const conflict = (Object.keys(settings.shortcuts) as ShortcutAction[]).find(action => action !== editing && settings.shortcuts[action] === event.code);
    if (conflict) { status.textContent = `该按键已用于「${SHORTCUT_LABELS[conflict]}」，请换一个。`; return; }
    settings.shortcuts = { ...settings.shortcuts, [editing]: event.code }; editing = null;
    onChange(true); refreshShortcuts(); status.textContent = '快捷键已保存';
  }, { signal: abort.signal });
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
    root.querySelector('#music-preview-status')!.textContent = `正在试听：${scene === 'menu' || !settings.adaptiveMusic ? '原速' : '紧张节奏'}`;
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
    editing = null; refreshShortcuts();
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
    settings.shortcuts = { ...DEFAULT_SHORTCUTS }; editing = null; refreshShortcuts();
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
