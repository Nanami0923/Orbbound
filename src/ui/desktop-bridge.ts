import { exportBackup, importBackup, validateBackup } from '../storage/backup';
import { readStorage, writeStorage } from '../storage/safe-storage';
import { applyDisplayInfo, exportAndroidBackup, importAndroidBackup, isAndroid, type DisplayInfo } from './platform-services';

interface Host { postMessage(value: unknown): void; addEventListener(type: string, listener: (event: { data: unknown }) => void): void }
const host = () => (window as unknown as { chrome?: { webview?: Host } }).chrome?.webview;
type ImportConfirmation = (text:string, commit:()=>void)=>void;
export function bindDesktopBridge(refresh: () => void, notify: (message: string) => void, confirmImport?:ImportConfirmation): void {
  const receiveImport = (text:string) => {
    try {
      validateBackup(text);
      const commit = () => { try { importBackup(text); refresh(); notify('存档、记录和设置已导入'); } catch(error) { notify(error instanceof Error ? error.message : '导入未完成'); } };
      if (confirmImport) confirmImport(text,commit);
      else if (window.confirm('导入存档、记录和设置？同名数据会替换，导入前保留恢复副本。')) commit();
    } catch(error) { notify(error instanceof Error ? error.message : '备份读取失败'); }
  };
  const markExport = () => { writeStorage('orbbound-last-export', String(Date.now())); updateExportTime(); notify('备份已导出'); };
  const updateExportTime = () => {
    const value = Number(readStorage('orbbound-last-export')), target = document.querySelector('#backup-last-export');
    if (target) target.textContent = value > 0 ? `上次导出：${new Date(value).toLocaleString('zh-CN')}` : '尚未导出备份';
  };
  window.addEventListener('keydown', event => { if (event.key === 'F11' && host()) { event.preventDefault(); if (!event.repeat) host()!.postMessage({type:'fullscreen'}); } });
  window.addEventListener('orbbound-ready', () => host()?.postMessage({type:'ready'}));
  window.addEventListener('orbbound-query-display', () => host()?.postMessage({type:'display-info'}));
  window.addEventListener('orbbound-request-fullscreen', () => host()?.postMessage({type:'fullscreen'}));
  host()?.addEventListener('message', event => {
    const message = event.data as {type?:string;text?:string;info?:DisplayInfo};
    if (message.type === 'import' && typeof message.text === 'string') receiveImport(message.text);
    else if (message.type === 'display-info' && message.info) applyDisplayInfo(message.info);
    else if (message.type === 'notice' && message.text) { if (message.text === '备份已导出') markExport(); else notify(message.text); }
  });
  const browserImport = () => {
    const input = document.createElement('input'); input.type='file';input.accept='.json,application/json';
    input.addEventListener('change', () => { const file=input.files?.[0]; if (!file) return; if(file.size>2_000_000){notify('备份文件过大');return;} void file.text().then(receiveImport).catch(()=>notify('备份读取失败')); }, {once:true});
    input.click();
  };
  document.addEventListener('click', event => {
    const element = (event.target as Element).closest<HTMLElement>('[data-backup]'), action=element?.dataset.backup;
    if(!action)return;
    if(action==='restore') { const text=readStorage('orbbound-backup-before-import'); if(text)receiveImport(text);else notify('暂无导入前备份');return; }
    if(action==='legacy'){ if(host())host()!.postMessage({type:'legacy'});else notify('旧 Windows 存档迁移请在 Windows 版中使用');return; }
    const run = async () => {
      element!.setAttribute('aria-busy','true');(element as HTMLButtonElement).disabled=true;
      try {
        if(action==='export') {
          const text=exportBackup();
          if(isAndroid()) { const result=await exportAndroidBackup(text);if(!result.cancelled)markExport(); }
          else if(host())host()!.postMessage({type:'export',text});
          else { const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='Orbbound-save.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);markExport(); }
        } else if(action==='import') {
          if(isAndroid()){ const result=await importAndroidBackup();if(!result.cancelled&&result.text)receiveImport(result.text); }
          else if(host())host()!.postMessage({type:'import'});else browserImport();
        }
      } catch(error) { notify(error instanceof Error ? error.message : '文件操作未完成，请重试'); }
      finally { if(element!.isConnected){element!.removeAttribute('aria-busy');(element as HTMLButtonElement).disabled=false;} }
    };
    void run();
  });
  window.addEventListener('orbbound-settings-open', updateExportTime);
}
