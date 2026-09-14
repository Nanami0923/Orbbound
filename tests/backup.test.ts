import { afterEach, expect, it, vi } from 'vitest';
import { createRound } from '../src/core/modes';
import { exportBackup, importBackup, validateBackup } from '../src/storage/backup';
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
