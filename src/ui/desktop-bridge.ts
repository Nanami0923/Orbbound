import { exportBackup, importBackup, validateBackup } from '../storage/backup';

interface Host { postMessage(value: unknown): void; addEventListener(type: string, listener: (event: { data: unknown }) => void): void }
const host = () => (window as unknown as { chrome?: { webview?: Host } }).chrome?.webview;
export function bindDesktopBridge(refresh: () => void, notify: (message: string) => void): void {
  window.addEventListener('keydown', event => { if (event.key === 'F11' && host()) { event.preventDefault(); if (!event.repeat) host()!.postMessage({type:'fullscreen'}); } });
  window.addEventListener('orbbound-ready', () => host()?.postMessage({ type:'ready' }));
  host()?.addEventListener('message', event => {
    const message = event.data as { type?: string; text?: string };
    if (message.type === 'import' && typeof message.text === 'string') {
      try {
        validateBackup(message.text);
        if (!window.confirm('导入存档、记录和设置？同名数据会被替换，导入前会保留恢复备份。')) return;
        importBackup(message.text); refresh(); notify('存档、记录和设置已导入');
      } catch (error) { notify(error instanceof Error ? error.message : '备份读取失败'); }
    } else if (message.type === 'notice' && message.text) notify(message.text);
  });
  document.addEventListener('click', event => {
    const action = (event.target as Element).closest<HTMLElement>('[data-backup]')?.dataset.backup;
    if (!action) return;
    if (action === 'export') {
      const text = exportBackup();
      if (host()) host()!.postMessage({type:'export', text});
      else { const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='Orbbound-save.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
    } else if (host()) host()!.postMessage({type:action});
    else notify('请在 Windows 轻量版中使用此功能');
  });
}
