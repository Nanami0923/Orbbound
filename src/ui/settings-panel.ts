import { DEFAULT_SETTINGS, type Settings } from '../storage/storage';
import { gameAudio } from '../game/audio';
import { haptic } from '../game/feedback';
import { fineRotationSpeed } from '../game/rotation';
import { bindSteeringControl } from '../game/steering-control';
import { DEFAULT_SHORTCUTS, SHORTCUT_LABELS, shortcutLabel, validShortcutCode, type ShortcutAction } from '../game/shortcuts';
import { getHapticsCapability } from './platform-services';
import { readStorage } from '../storage/safe-storage';

export const SETTINGS_CATEGORIES = {
  sound: ['volume', 'musicVolume', 'adaptiveMusic'],
  control: ['aimAssist', 'immersiveMode', 'sensitivity', 'hapticShoot', 'hapticMatch', 'controlsSwapped', 'fireSize', 'controlOffset', 'shortcuts'],
  display: ['frameRate', 'quality', 'reducedMotion', 'showPerformance'],
} satisfies Record<string, (keyof Settings)[]>;

export function settingsMarkup(settings: Settings, mobile: boolean, inGame = false): string {
  const supportsHaptics = getHapticsCapability();
  const restoreBackup = readStorage('orbbound-backup-before-import')
    ? '<button class="quiet-button" data-backup="restore">恢复导入前备份</button>'
    : '<button class="quiet-button" data-backup="restore" disabled aria-describedby="backup-restore-hint">恢复导入前备份</button><p id="backup-restore-hint">暂无导入前备份</p>';
  const range = (key: keyof Settings, title: string, min: number, max: number, unit: string, hint: string) => `<label class="setting-row range-setting" for="setting-${key}"><span><strong>${title}</strong><small>${hint}</small></span><output id="value-${key}">${settings[key]}${unit}</output><input id="setting-${key}" data-setting="${key}" data-unit="${unit}" type="range" min="${min}" max="${max}" value="${settings[key]}" aria-label="${title}"></label>`;
  const toggle = (key: keyof Settings, title: string, hint: string, disabled = false) => `<div class="setting-row"><div><strong>${title}</strong><small>${hint}</small></div><label class="switch"><input data-setting="${key}" type="checkbox" aria-label="${title}" ${settings[key] ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span></span></label></div>`;
  const select = (key: keyof Settings, title: string, options: [string,string][], hint:string) => `<label class="setting-row" for="setting-${key}"><span><strong>${title}</strong><small>${hint}</small></span><select id="setting-${key}" data-setting="${key}" aria-label="${title}">${options.map(([value,label])=>`<option value="${value}" ${String(settings[key]) === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
  const reset = (page: string) => `<button class="quiet-button category-reset" data-category-reset="${page}">恢复此分类默认</button>`;
  return `<header class="settings-heading"><button class="quiet-button settings-back" data-settings-back hidden>‹ 分类</button><h2>设置</h2><button class="quiet-button" data-close-modal>完成</button></header><p class="settings-context">${inGame ? '本局已暂停 · 只调整本机体验' : '自动保存 · 所有玩法共用'}</p><div class="settings-workspace">
    <nav class="settings-categories" data-settings-page="root" aria-label="设置分类">${[['sound','声音与音乐'],['control','操作与辅助'],['display','画面与性能'],['backup','数据与维护']].map(([id,label]) => `<button class="quiet-button" data-settings-open="${id}">${label} ›</button>`).join('')}</nav>
    <div class="settings-detail" tabindex="-1">
    <section data-settings-page="sound" hidden><h3 tabindex="-1">声音与音乐</h3>
      ${range('volume','音效音量',0,100,'%','0 为静音。')}${range('musicVolume','音乐音量',0,100,'%','不影响发射和消除音效。')}
      ${toggle('adaptiveMusic','局内音乐加速','随自己棋盘压力加快，音高保持不变。静音时保留此偏好。')}
      <div class="sound-preview-actions"><button class="quiet-button" id="preview-menu">试听原速</button><button class="quiet-button" id="preview-play">试听紧张节奏</button><button class="quiet-button" id="preview-sound">试听消除</button></div><p id="music-preview-status" role="status">当前：菜单曲</p>${reset('sound')}
    </section>
    <section data-settings-page="control" hidden><h3 tabindex="-1">操作与辅助</h3>${toggle('aimAssist','瞄准辅助','显示反弹路线和空心落点圈。')}
    ${mobile ? `${toggle('immersiveMode','沉浸操作','隐藏底部按键；按住棋盘瞄准，松手发射，移出取消。')}
      <div data-button-settings ${settings.immersiveMode ? 'hidden' : ''}><h4>按钮操作</h4>${range('sensitivity','微调灵敏度',50,150,'%','中间慢，两侧快；松手立即停止。')}
      <div class="control-preview"><div class="preview-cannon" aria-hidden="true"><span id="preview-barrel">↑</span></div><output id="preview-angle">0.0°</output><label for="preview-fine">按住滑条，试试微调</label><input id="preview-fine" type="range" min="-100" max="100" value="0" aria-label="体验微调"><button class="quiet-button" id="preview-fire">试试发射</button></div>
      <div class="setting-row"><span><strong>左右调换</strong><small>交换发射键和双滑杆。</small></span><button id="setting-swap" class="quiet-button">${settings.controlsSwapped ? '发射在右 ⇄' : '发射在左 ⇄'}</button></div>
      ${range('fireSize','发射键宽度',76,120,'px','不压缩微调区域。')}${range('controlOffset','控制区下移',0,48,'px','按可用空间自动限制。')}
      <div class="grip-preview"><span class="grip-fire">发射</span><span class="grip-sliders">方向 ━━━<br>微调 ━━━</span></div></div>
      <h4>触觉反馈</h4><p id="settings-haptics-status" role="status" ${supportsHaptics === true ? 'hidden' : ''}>${supportsHaptics === false ? '此设备不支持震动反馈。' : '设备能力待确认'}</p><div data-haptics-controls ${supportsHaptics === true ? '' : 'hidden'}>${toggle('hapticShoot','发射轻震','发射成功后轻震。',supportsHaptics !== true)}${toggle('hapticMatch','消除轻震','同色消除或掉落后轻震。',supportsHaptics !== true)}</div>`
      : `<p>鼠标左、右键按住瞄准，松开发射。F11 切换全屏。</p><h4>键盘快捷键</h4><p>点击按键后按下新键，每个动作使用不同按键。</p><div class="shortcut-settings">${(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map(action => `<div class="setting-row"><strong>${SHORTCUT_LABELS[action]}</strong><button class="quiet-button" data-shortcut-edit="${action}" aria-label="修改${SHORTCUT_LABELS[action]}快捷键">${shortcutLabel(settings.shortcuts[action])}</button></div>`).join('')}</div><p id="shortcut-status" role="status"></p>`}${reset('control')}
    </section>
    <section data-settings-page="display" hidden><h3 tabindex="-1">画面与性能</h3>
      ${select('frameRate','帧率上限',[['30','30 FPS · 省电'],['60','60 FPS · 默认'],['90','90 FPS'],['120','120 FPS']],'选择活动绘制上限；实际帧率受屏幕、系统和设备性能限制。')}
      ${select('quality','画面清晰度',[['auto','自动'],['1','标准'],['1.5','清晰'],['2','精细']],'与帧率独立，不改变棋盘规则。')}
      ${toggle('reducedMotion','减少动态效果','简化位移与闪光，保持相同发射节奏。')}${toggle('showPerformance','显示帧率','显示实际绘制帧率和当前目标。')}<p id="settings-performance-status" role="status">请求 ${settings.frameRate} FPS · 等待实际绘制数据</p>${reset('display')}
    </section>
    <section data-settings-page="backup" hidden><h3 tabindex="-1">数据与维护</h3><p>导出存档、记录和设置。导入前预览并保留恢复副本。</p><p id="backup-last-export"></p><div class="settings-categories"><button class="quiet-button" data-backup="export">导出备份</button>${inGame ? '<p>导入、恢复备份及全部恢复默认，请返回首页后操作。</p>' : '<button class="quiet-button" data-backup="import">导入备份</button>' + restoreBackup + (!mobile ? '<button class="quiet-button" data-backup="legacy">导入旧 Windows 存档</button>' : '')}</div><p id="backup-status" role="status"></p>${inGame ? '' : '<h4>恢复设置</h4><p>只恢复声音、操作和显示偏好，存档及成绩不变。</p><button class="quiet-button" id="settings-reset">恢复全部默认设置</button>'}<p id="settings-reset-status" role="status"></p></section>
    </div></div><p class="settings-save-status" role="status" aria-live="polite"></p>`;
}

export function bindSettingsPanel(root: HTMLElement, settings: Settings, onChange: (commit: boolean) => void): () => void {
  const abort = new AbortController();
  const listen = (element: Element | null, event: string, fn: EventListener) => element?.addEventListener(event, fn, { signal: abort.signal });
  const refreshHaptics = () => {
    const capability = getHapticsCapability();
    const controls = root.querySelector<HTMLElement>('[data-haptics-controls]');
    const status = root.querySelector<HTMLElement>('#settings-haptics-status');
    if (controls) {
      controls.hidden = capability !== true;
      controls.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.disabled = capability !== true; });
    }
    if (status) {
      status.hidden = capability === true;
      status.textContent = capability === false ? '此设备不支持震动反馈。' : '设备能力待确认';
    }
  };
  window.addEventListener('orbbound-performance-capabilities', refreshHaptics, { signal: abort.signal });
  refreshHaptics();
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
    const buttonSettings = root.querySelector<HTMLElement>('[data-button-settings]');
    if (buttonSettings) buttonSettings.hidden = settings.immersiveMode;
    if (!grip) return;
    grip.classList.toggle('swapped', settings.controlsSwapped);
    grip.style.setProperty('--preview-width', `${settings.fireSize * 0.6}px`);
    grip.style.marginTop = `${8 + settings.controlOffset * 0.4}px`;
  };
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]').forEach(input => {
    const key = input.dataset.setting as keyof Settings;
    listen(input, 'input', () => {
      Object.assign(settings, { [key]: input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.value === 'auto' ? 'auto' : Number(input.value) });
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
    if (!settings.reducedMotion) barrel?.animate([{ translate: '0 0' }, { translate: '0 5px' }, { translate: '0 0' }], { duration: 160 });
  });
  window.addEventListener('blur', () => binding?.reset(), { signal: abort.signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) binding?.reset(); }, { signal: abort.signal });
  const navigate = (page: string) => {
    editing = null; refreshShortcuts();
    binding?.reset(); cancelAnimationFrame(raf); raf = 0;
    gameAudio.stopEffects(); gameAudio.setScene('menu');
    root.querySelector('#music-preview-status')!.textContent = '当前：菜单曲';
    root.querySelectorAll<HTMLElement>('[data-settings-page]').forEach(section => { section.hidden = section.dataset.settingsPage !== page && !(section.dataset.settingsPage === 'root' && root.classList.contains('settings-desktop')); });
    root.querySelector<HTMLElement>('.settings-detail')!.hidden = page === 'root';
    root.querySelectorAll<HTMLElement>('[data-settings-open]').forEach(button => button.setAttribute('aria-current', String(button.dataset.settingsOpen === page)));
    root.querySelector<HTMLButtonElement>('[data-settings-back]')!.hidden = page === 'root';
    root.querySelector<HTMLElement>('.settings-detail')?.scrollTo(0, 0);
    root.querySelector<HTMLElement>(`[data-settings-page="${page}"] ${page === 'root' ? 'button' : 'h3'}`)?.focus({ preventScroll: true });
  };
  root.querySelectorAll<HTMLElement>('[data-settings-open]').forEach(button => listen(button, 'click', () => navigate(button.dataset.settingsOpen!)));
  listen(root.querySelector('[data-settings-back]'), 'click', () => navigate('root'));
  const resetValues = (category?: keyof typeof SETTINGS_CATEGORIES) => {
    binding?.reset(); gameAudio.stopEffects();
    const keys: (keyof Settings)[] = category ? SETTINGS_CATEGORIES[category] : Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
    for (const key of keys) Object.assign(settings, { [key]: key === 'shortcuts' ? { ...DEFAULT_SHORTCUTS } : DEFAULT_SETTINGS[key] });
    onChange(true); editing = null; refreshShortcuts();
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]').forEach(input => {
      const key = input.dataset.setting as keyof Settings;
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(settings[key]);
      else input.value = String(settings[key]);
      const output = root.querySelector(`#value-${key}`);
      if (output) output.textContent = `${settings[key]}${input.dataset.unit ?? ''}`;
    });
    const swap = root.querySelector('#setting-swap'); if (swap) swap.textContent = settings.controlsSwapped ? '发射在右 ⇄' : '发射在左 ⇄';
    angle = 0; if (barrel) barrel.style.transform = 'rotate(0deg)';
    const angleOutput = root.querySelector('#preview-angle'); if (angleOutput) angleOutput.textContent = '0.0°';
    updateGrip(); root.querySelector('.settings-save-status')!.textContent = category ? '已恢复此分类默认设置' : '已恢复全部默认设置';
  };
  listen(root.querySelector('#settings-reset'), 'click', () => resetValues());
  root.querySelectorAll<HTMLElement>('[data-category-reset]').forEach(button => listen(button, 'click', () => resetValues(button.dataset.categoryReset as keyof typeof SETTINGS_CATEGORIES)));
  root.classList.toggle('settings-desktop', document.documentElement.classList.contains('desktop-ui'));
  navigate('root'); updateGrip();
  return () => { binding?.dispose(); cancelAnimationFrame(raf); abort.abort(); onChange(true); gameAudio.stopEffects(); gameAudio.setScene('menu'); };
}

export function settingsBack(root: HTMLElement): boolean {
  const back = root.querySelector<HTMLButtonElement>('[data-settings-back]');
  if (!back || back.hidden) return false;
  back.click(); return true;
}
