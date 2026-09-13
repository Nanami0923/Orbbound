import {expect,it,vi} from 'vitest';
import {bindSteeringControl} from '../src/game/steering-control';
import {directAimDegrees,fineRotationSpeed} from '../src/game/rotation';
import {headingLines} from '../src/ui/typography';
class Slider extends EventTarget {
 value='0';captured:number|null=null;
 setPointerCapture(id:number){this.captured=id;}hasPointerCapture(id:number){return this.captured===id;}releasePointerCapture(){this.captured=null;}
 getBoundingClientRect(){return {left:0,width:224} as DOMRect;}
}
const send=(slider:Slider,type:string,id=1,x=180)=>{const event=new Event(type,{cancelable:true});Object.assign(event,{pointerId:id,clientX:x,button:0});slider.dispatchEvent(event);};
it('keeps first-finger steering when another pointer releases or changes focus',()=>{
 const slider=new Slider(),value=vi.fn();const binding=bindSteeringControl(slider as unknown as HTMLInputElement,{fine:true,active:()=>true,onValue:value});
 send(slider,'pointerdown');const speed=value.mock.lastCall![0];expect(speed).toBeGreaterThan(0);
 send(slider,'pointerup',2);send(slider,'blur',2);expect(value).toHaveBeenCalledTimes(1);
 send(slider,'pointermove',1,210);expect(value.mock.lastCall![0]).toBeGreaterThan(speed);
 send(slider,'pointerup');expect(value.mock.lastCall![0]).toBe(0);expect(slider.value).toBe('0');binding.dispose();
});
it.each(['pointercancel','lostpointercapture','reset'])('stops on %s and rejects stale moves until a new touch',event=>{
 const slider=new Slider(),value=vi.fn();const binding=bindSteeringControl(slider as unknown as HTMLInputElement,{fine:true,active:()=>true,onValue:value});
 send(slider,'pointerdown');if(event==='reset')binding.reset();else send(slider,event);
 const count=value.mock.calls.length;send(slider,'pointermove',1,220);expect(value).toHaveBeenCalledTimes(count);
 send(slider,'pointerdown',3,190);expect(value.mock.lastCall![0]).toBeGreaterThan(0);binding.dispose();
});
it('preserves direct angles without snapping and uses a wider slow steering zone',()=>{
 expect(directAimDegrees(1)).toBe(1);expect(directAimDegrees(-0.5)).toBe(-0.5);expect(directAimDegrees(90)).toBe(78);
 expect(fineRotationSpeed(5)).toBe(0);expect(fineRotationSpeed(30)).toBeLessThan(3);
 expect(fineRotationSpeed(100,50)).toBe(30);expect(fineRotationSpeed(-100,150)).toBe(-90);
});
it('breaks long titles at commas and keeps short titles intact',()=>{
 expect(headingLines('时间到，挑战完成！')).toEqual(['时间到，','挑战完成！']);
 expect(headingLines('调整手感，找到节奏')).toEqual(['调整手感，','找到节奏']);
 expect(headingLines('本局已结算')).toEqual(['本局已结算']);
});
