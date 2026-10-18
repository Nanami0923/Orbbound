import { afterEach, expect, it, vi } from 'vitest';
import { createRound } from '../src/core/modes';
import { exportBackup, importBackup, validateBackup, backupSummary } from '../src/storage/backup';
import { saveSettings, DEFAULT_SETTINGS, setHighScore, clearGame } from '../src/storage/storage';
afterEach(()=>vi.unstubAllGlobals());
function fixture() {
 const values=new Map<string,string>();let failKey='';
 const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{if(k===failKey)throw Error('QuotaExceeded');values.set(k,v);},removeItem:(k:string)=>values.delete(k)};
 const dispatchEvent=vi.fn();vi.stubGlobal('window',{localStorage:storage,dispatchEvent});
 return {values,storage,dispatchEvent,fail:(k:string)=>{failKey=k;}};
}
it('round trips both saves and false settings, preserving a recovery copy',()=>{
 const f=fixture();f.storage.setItem('orbbound-save-v1',JSON.stringify(createRound('normal','endless',300000)));
 f.storage.setItem('orbbound-timed-active-v2',JSON.stringify(createRound('normal','timed',600000)));
 saveSettings({...DEFAULT_SETTINGS,adaptiveMusic:false});const backup=exportBackup();f.values.clear();importBackup(backup);
 expect(validateBackup(exportBackup())).toEqual(validateBackup(backup));expect(f.values.has('orbbound-backup-before-import')).toBe(true);
});

it.each(['auto',undefined])('normalizes legacy backup frameRate %j without writing during preview',frameRate=>{
 const f=fixture();saveSettings({...DEFAULT_SETTINGS,frameRate:90});const original=new Map(f.values);
 const incoming=JSON.stringify({app:'orbbound',version:1,values:{'orbbound-settings-v1':JSON.stringify({frameRate,musicVolume:11,quality:'auto'})}});
 const normalized=validateBackup(incoming);
 expect(JSON.parse(normalized['orbbound-settings-v1'])).toEqual({frameRate:60,musicVolume:11,quality:'auto'});
 expect(backupSummary(incoming)).toContain('及设置');expect(f.values).toEqual(original);
 importBackup(incoming);expect(JSON.parse(f.values.get('orbbound-settings-v1')!)).toEqual({frameRate:60,musicVolume:11,quality:'auto'});
 const recovery=f.values.get('orbbound-backup-before-import')!;importBackup(recovery);
 expect(JSON.parse(f.values.get('orbbound-settings-v1')!).frameRate).toBe(90);
});

it.each([30,60,90,120])('preserves fixed backup preference %i',frameRate=>{
 const f=fixture();importBackup(JSON.stringify({app:'orbbound',version:1,values:{'orbbound-settings-v1':JSON.stringify({frameRate})}}));
 expect(JSON.parse(f.values.get('orbbound-settings-v1')!).frameRate).toBe(frameRate);
});

it.each([null,0,240,'60','AUTO',{},[]])('rejects corrupt backup frameRate %j before any storage mutation',frameRate=>{
 const f=fixture();saveSettings({...DEFAULT_SETTINGS,frameRate:120});const original=new Map(f.values);
 expect(()=>importBackup(JSON.stringify({app:'orbbound',version:1,values:{'orbbound-settings-v1':JSON.stringify({frameRate})}}))).toThrow('帧率设置无效');
 expect(f.values).toEqual(original);
});

it('preserves current settings when a partial backup contains no settings',()=>{
 const f=fixture();saveSettings({...DEFAULT_SETTINGS,frameRate:120});const original=f.values.get('orbbound-settings-v1');
 importBackup(JSON.stringify({app:'orbbound',version:1,values:{'orbbound-high-score-v1':'123'}}));
 expect(f.values.get('orbbound-settings-v1')).toBe(original);
});

it('exports normalized local settings without carrying legacy auto or writing during export',()=>{
 const f=fixture();f.values.set('orbbound-settings-v1',JSON.stringify({frameRate:'auto',volume:23,musicVolume:0,quality:'auto'}));
 const original=new Map(f.values), normalized=validateBackup(exportBackup());
 expect(JSON.parse(normalized['orbbound-settings-v1'])).toMatchObject({frameRate:60,volume:23,musicVolume:0,quality:'auto'});
 expect(f.values).toEqual(original);
});

it('rolls back earlier writes if a normalized settings import fails',()=>{
 const f=fixture();saveSettings({...DEFAULT_SETTINGS,frameRate:90});setHighScore(10);
 const original=f.values.get('orbbound-settings-v1'); f.fail('orbbound-settings-v1');
 const incoming=JSON.stringify({app:'orbbound',version:1,values:{'orbbound-high-score-v1':'999','orbbound-settings-v1':'{"frameRate":"auto"}'}});
 expect(()=>importBackup(incoming)).toThrow('导入未完成');
 expect(f.values.get('orbbound-high-score-v1')).toBe('10');expect(f.values.get('orbbound-settings-v1')).toBe(original);
});
it('rejects malformed, foreign and non-finite save content before touching active storage',()=>{
 fixture();saveSettings(DEFAULT_SETTINGS);const original=validateBackup(exportBackup());
 for(const value of [{app:'other',version:1,values:{}},{app:'orbbound',version:2,values:{}},{app:'orbbound',version:1,values:{unknown:'1'}},{app:'orbbound',version:1,values:{'orbbound-settings-v1':'{"volume":999}'}},{app:'orbbound',version:1,values:{'orbbound-save-v1':JSON.stringify({...createRound('normal','endless',300000),seed:-1})}}])expect(()=>importBackup(JSON.stringify(value))).toThrow();
 expect(validateBackup(exportBackup())).toEqual(original);
});
it('aborts when the recovery backup cannot be stored and handles settings write failures',()=>{
 const f=fixture();saveSettings(DEFAULT_SETTINGS);const original=f.values.get('orbbound-settings-v1');
 const next=JSON.stringify({app:'orbbound',version:1,values:{'orbbound-settings-v1':'{"adaptiveMusic":false}'}});
 f.fail('orbbound-backup-before-import');expect(()=>importBackup(next)).toThrow();expect(f.values.get('orbbound-settings-v1')).toBe(original);
 f.fail('orbbound-settings-v1');expect(()=>saveSettings(DEFAULT_SETTINGS)).not.toThrow();expect(f.dispatchEvent).toHaveBeenCalled();
 f.fail('orbbound-high-score-v1');expect(()=>setHighScore(10)).not.toThrow();expect(()=>clearGame()).not.toThrow();
});
