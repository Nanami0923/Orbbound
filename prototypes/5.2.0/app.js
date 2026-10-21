(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const scene = { fixed: [], removed: [] };
  const colors = [0, 2, 4, 3, 1, 4, 2, 0, 3, 4, 2, 3, 0, 1];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 14; col++) scene.fixed.push({ x: 50 + col * 40 + (row % 2 ? 20 : 0), y: 56 + row * 34.64, color: colors[(col + row * 3) % 14] });
  for (let row = 3; row < 5; row++) for (let col = 0; col < 14; col++) if (col < 4 || col > 10) scene.fixed.push({ x: 50 + col * 40 + (row % 2 ? 20 : 0), y: 56 + row * 34.64, color: colors[(col + row * 3) % 14] });
  const coordinates = [[310,160,1,false],[350,160,1,false],[330,195,1,false],[390,160,1,false], [310,230,2,true],[350,230,3,true],[290,265,4,true],[330,265,0,true],[370,265,2,true],[310,300,3,true],[350,300,0,true],[330,335,4,true]];
  scene.removed = coordinates.map(([x,y,color,falling], index) => ({x,y,color,falling,index}));
  const state = { view: 'motion', effect: 'full', layout: 'both', playing: true, speed: 1, time: 0 };
  const atlas = ORB_DATA.themes.map(theme => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 144;
    const c = canvas.getContext('2d'); c.translate(72,72); c.scale(144/35,144/35); c.translate(-24,-24);
    c.fillStyle=theme.cssColor; c.beginPath(); c.arc(24,24,17.5,0,Math.PI*2);c.fill();
    c.strokeStyle='rgba(12,20,33,.25)';c.lineWidth=.7;c.stroke();
    c.fillStyle='rgba(255,255,255,.065)';c.beginPath();c.ellipse(18,17,4.5,2.4,0,0,Math.PI*2);c.fill();
    c.fillStyle=theme.ink;c.fill(new Path2D(ORB_DATA.paths[theme.id]));
    for(const x of [18,30]){c.beginPath();c.arc(x,32,1.7,0,Math.PI*2);c.fill();}return canvas;
  });
  function orb(c, color, x, y, radius=18, alpha=1, rotation=0) {
    if(alpha<=0)return;c.save();c.translate(x,y);c.rotate(rotation);c.globalAlpha=alpha;c.drawImage(atlas[color],-radius,-radius,radius*2,radius*2);c.restore();
  }
  function svgOrb(color) { const t=ORB_DATA.themes[color];return `<svg viewBox="6.5 6.5 35 35" aria-hidden="true"><circle cx="24" cy="24" r="17.5" fill="${t.cssColor}"/><path d="${ORB_DATA.paths[color]}" fill="${t.ink}"/><circle cx="18" cy="32" r="1.7" fill="${t.ink}"/><circle cx="30" cy="32" r="1.7" fill="${t.ink}"/></svg>`; }
  document.querySelectorAll('[data-orb]').forEach(e=>e.innerHTML=svgOrb(Number(e.dataset.orb)));
  const particles = { windows: clearParticles(scene.removed,'windows'), android: clearParticles(scene.removed,'android') };
  function fit(canvas,width,height){ const dpr=Math.min(devicePixelRatio||1,2);const w=Math.max(1,Math.round(canvas.getBoundingClientRect().width*dpr)),h=Math.round(w*height/width);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}const c=canvas.getContext('2d');c.setTransform(w/width,0,0,h/height,0,0);return c; }
  function paintBoard(c) {
    c.fillStyle='#101b29';c.fillRect(0,0,640,760);
    c.strokeStyle='rgba(143,163,184,.055)';c.lineWidth=1;
    for(let y=367;y<650;y+=42){c.beginPath();c.moveTo(34,y);c.lineTo(606,y);c.stroke();}
    c.strokeStyle='#34414d';c.beginPath();c.moveTo(32,652);c.lineTo(608,652);c.stroke();
    c.fillStyle='#66788b';c.font='11px "Microsoft YaHei",sans-serif';c.textAlign='center';c.fillText('触底线',320,673);
    for(const item of scene.fixed)orb(c,item.color,item.x,item.y);
    c.fillStyle='#1e2b3c';c.beginPath();c.arc(320,716,34,0,Math.PI*2);c.fill();
    c.save();c.translate(320,716);c.rotate(.14);c.fillStyle='#293b4c';c.beginPath();c.roundRect(-11,-57,22,58,7);c.fill();c.fillStyle='#83c6b2';c.beginPath();c.roundRect(-8,-55,16,6,3);c.fill();c.restore();orb(c,1,320,716,19);
  }
  function renderCanvas(platform) {
    const canvas=$(`#${platform}-canvas`);if(!canvas.getClientRects().length)return;
    const c=fit(canvas,640,760);paintBoard(c);const {hitElapsed:t,beforeHit,resetAlpha}=sceneClock(state.time),reduced=state.effect==='reduced';
    if(beforeHit){for(const item of scene.removed)if(item.index!==3)orb(c,item.color,item.x,item.y);
      // Scripted flight is illustrative; it does not consume a gameplay random stream.
      const flight=clamp01((state.time-520)/480),x=(1-flight)**2*320+2*(1-flight)*flight*580+flight*flight*390,y=(1-flight)**2*716+2*(1-flight)*flight*560+flight*flight*160;
      orb(c,1,x,y,18);c.strokeStyle='rgba(131,198,178,.17)';c.lineWidth=1;c.beginPath();c.arc(390,160,22,0,Math.PI*2);c.stroke();
    }else{
      for(const item of scene.removed){const p=orbPose(item,t,reduced);orb(c,item.color,p.x,p.y,18,p.alpha,p.rotation);}
      if(!reduced)for(const p of particles[platform]){const pose=particlePose(p,t);if(pose.alpha<=0)continue;c.save();c.globalAlpha=pose.alpha;c.fillStyle=ORB_DATA.themes[p.color].cssColor;
        c.beginPath();c.arc(pose.x,pose.y,pose.radius,0,Math.PI*2);c.fill();
        if(p.tail){c.lineCap='round';c.strokeStyle=ORB_DATA.themes[p.color].cssColor;c.lineWidth=pose.radius*.55;c.globalAlpha=pose.alpha*.45;c.beginPath();c.moveTo(pose.x,pose.y);c.lineTo(pose.x-p.vx*.07,pose.y-p.vy*.07-3);c.stroke();}c.restore();}
      if(!reduced&&t<880){const p=clamp01(t/880);c.save();c.textAlign='center';c.globalAlpha=Math.pow(1-p,1.1);c.fillStyle='#b7dfcd';c.font='600 29px "Microsoft YaHei",sans-serif';c.fillText('+ 1 0 5 0',330,225-42*p);c.font='12px "Microsoft YaHei",sans-serif';c.fillStyle='#91aaae';c.fillText('连锁消除',330,247-42*p);c.restore();}
      if(resetAlpha>0)for(const item of scene.removed)if(item.index!==3)orb(c,item.color,item.x,item.y,18,resetAlpha);
    }
  }
  let previousScore='';function render(){if(state.view!=='motion')return;renderCanvas('windows');renderCanvas('android');
    const clock=sceneClock(state.time),duration=state.effect==='full'?MOTION.fullMs:MOTION.reducedMs;
    const label=clock.beforeHit?'等待命中':clock.hitElapsed<duration?'同步消除 · 等大淡出':'淡出完成';
    $('#phase-label').textContent=label;$('#time-label').textContent=clock.beforeHit?`命中前 ${Math.round(-clock.hitElapsed)}ms`:`t₀ + ${Math.round(clock.hitElapsed)}ms`;
    $('#timeline').value=String(Math.min(3000,state.time));
    const score=clock.beforeHit||clock.resetAlpha>0?'002410':'003460';if(previousScore!==score){document.querySelectorAll('[data-score]').forEach(e=>e.textContent=score);previousScore=score;}
  }
  function pressed(selector,key,value){document.querySelectorAll(selector).forEach(e=>e.setAttribute('aria-pressed',String(e.dataset[key]===value)));}
  document.querySelectorAll('[data-effect]').forEach(b=>b.addEventListener('click',()=>{
    state.effect=b.dataset.effect;pressed('[data-effect]','effect',state.effect);
    const reduced=state.effect==='reduced';$('#effect-description').textContent=reduced?'基础淡出保留 · 关闭粒子、散落与旋转':'球体等大淡出 · 同步加速散落 · 双端保留粒子';
    $('#density-label').textContent=reduced?'减少额外动效':'粒子双端保留';$('#reduced-description').textContent=reduced?'两类球原位淡出 320ms，保留发射、装填和正常界面过渡。':'细粒与短尾混合，颜色来自被消除的小球。';
    document.querySelectorAll('.preview-caption small').forEach((e,i)=>e.textContent=`${i?'竖屏':'横屏'} · ${reduced?'减少效果':'完整效果'}`);render();
  }));
  document.querySelectorAll('[data-layout]').forEach(b=>b.addEventListener('click',()=>{state.layout=b.dataset.layout;$('.previews').dataset.layout=state.layout;pressed('[data-layout]','layout',state.layout);render();}));
  $('#play-toggle').addEventListener('click',()=>{state.playing=!state.playing;$('#play-toggle').textContent=state.playing?'暂停':'继续';$('#play-toggle').setAttribute('aria-pressed',String(!state.playing));});
  $('#speed').addEventListener('change',e=>state.speed=Number(e.target.value));
  $('#timeline').addEventListener('input',e=>{state.time=Number(e.target.value);state.playing=false;$('#play-toggle').textContent='继续';$('#play-toggle').setAttribute('aria-pressed','true');render();});
  let rooms=[];function renderRooms(){rooms=['你','玩家 2','玩家 3','玩家 4'].map((name,i)=>({name,...independentPlayer(roomSeed,`seat-${i+1}`)}));$('#random-players').innerHTML=rooms.map((p,i)=>`<article class="random-player"><h3>${p.name}</h3><p>普通 · 7 行 · 独立随机</p><canvas data-room="${i}" aria-label="${p.name}的随机棋盘"></canvas><span class="queue-label">出球顺序预览</span><div class="queue">${p.queue.map(svgOrb).join('')}</div></article>`).join('');drawRooms();}
  function drawRooms(){document.querySelectorAll('[data-room]').forEach(canvas=>{const c=fit(canvas,640,390);c.fillStyle='#101b29';c.fillRect(0,0,640,390);rooms[Number(canvas.dataset.room)].board.forEach((row,r)=>row.forEach((color,col)=>orb(c,color,50+col*40+(r%2?20:0),70+r*34.64,18)));});}
  let roomSeed=crypto.getRandomValues(new Uint32Array(1))[0];$('#new-room').addEventListener('click',()=>{roomSeed=crypto.getRandomValues(new Uint32Array(1))[0];renderRooms();});
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{state.view=b.dataset.view;pressed('[data-view]','view',state.view);$('#motion-study').hidden=state.view!=='motion';$('#random-study').hidden=state.view!=='random';if(state.view==='random')renderRooms();else render();}));
  const preferred=matchMedia('(prefers-reduced-motion: reduce)');if(preferred.matches)$('[data-effect="reduced"]').click();
  if(innerWidth<780)$('[data-layout="android"]').click();
  let last=performance.now();function frame(now){const dt=Math.min(60,now-last);last=now;if(state.playing&&state.view==='motion'&&!document.hidden){state.time=(state.time+dt*state.speed)%MOTION.cycleMs;render();}requestAnimationFrame(frame);}requestAnimationFrame(frame);
  addEventListener('resize',()=>{render();if(state.view==='random')drawRooms();});render();
  // Read-only inspection hook for reproducible demo QA; no game storage or engine access.
  Object.defineProperty(window,'orbboundDemo',{value:Object.freeze({snapshot:()=>({state:{...state},motion:MOTION,orbs:scene.removed.map(o=>({...o})),rooms:rooms.map(p=>({...p,board:p.board.map(r=>[...r]),queue:[...p.queue]})),particleCounts:{windows:particles.windows.length,android:particles.android.length}})})});
})();
