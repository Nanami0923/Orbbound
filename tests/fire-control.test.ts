import {expect,it,vi} from 'vitest';
import {bindFireButton} from '../src/game/fire-control';
function event(type:string,fields:Record<string,unknown>) {
 const e=new Event(type,{cancelable:true});Object.assign(e,fields);return e;
}
it('fires on a non-primary second pointer without moving focus or firing a duplicate click',()=>{
 const button=Object.assign(new EventTarget(),{disabled:false}) as unknown as HTMLButtonElement;
 const fire=vi.fn();bindFireButton(button,fire);
 const press=event('pointerdown',{pointerId:2,isPrimary:false,pointerType:'touch',button:0});
 button.dispatchEvent(press);expect(fire).toHaveBeenCalledOnce();expect(press.defaultPrevented).toBe(true);
 button.dispatchEvent(event('click',{detail:1}));expect(fire).toHaveBeenCalledOnce();
 button.disabled=true;button.dispatchEvent(event('pointerdown',{button:0}));expect(fire).toHaveBeenCalledOnce();
 button.disabled=false;button.dispatchEvent(event('click',{detail:0}));expect(fire).toHaveBeenCalledTimes(2);
});
