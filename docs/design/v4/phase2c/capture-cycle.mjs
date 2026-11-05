import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';

const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const root='docs/design/v4/phase2c';
mkdirSync(`${root}/contact-frames`,{recursive:true});mkdirSync(`${root}/stills`,{recursive:true});
const event=new Map([[250,'assignment'],[450,'review'],[775,'celebrate'],[1100,'report'],
  [1200,'awaiting'],[1275,'error'],[1375,'emergency'],[1475,'release']]);
const encoder=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','image2pipe','-vcodec','mjpeg',
  '-framerate','25','-i','pipe:0','-frames:v','2200','-an','-c:v','libvpx','-b:v','3M',
  '-deadline','realtime','-cpu-used','4',`${root}/cycle-88s-25fps.webm`],{stdio:['pipe','inherit','inherit']});
const browser=await chromium.launch({headless:false,args:['--enable-webgl','--use-gl=angle','--use-angle=d3d11']});
try {
  const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
  await page.clock.install({time:new Date('2026-10-28T12:00:00Z')});
  await page.clock.pauseAt(new Date('2026-10-28T12:00:01Z'));
  await page.goto('http://127.0.0.1:5198/?officeDemo=cycle&studio3d=1',{waitUntil:'networkidle'});
  for(let attempt=0;attempt<20;attempt++){
    if(await page.evaluate(()=>!!window.render_game_to_text&&JSON.parse(window.render_game_to_text(false)).ready))break;
    await page.clock.runFor(100);
  }
  if(!await page.evaluate(()=>!!window.render_game_to_text&&JSON.parse(window.render_game_to_text(false)).ready))
    throw new Error('Studio 3D did not become ready');
  for(let frame=1;frame<=2200;frame++){
    await page.evaluate(()=>window.advanceTime(40));
    await page.clock.runFor(40);
    const picture=await page.screenshot({type:'jpeg',quality:86});
    if(!encoder.stdin.write(picture))await once(encoder.stdin,'drain');
    if(frame%25===0){const second=frame/25;
      writeFileSync(`${root}/contact-frames/${String(second-1).padStart(3,'0')}.jpg`,picture);}
    const name=event.get(frame);if(name)writeFileSync(`${root}/stills/${name}.jpg`,picture);
    if(frame%250===0)console.log(`captured ${frame}/2200`);
  }
  encoder.stdin.end();
  const [exitCode]=await once(encoder,'exit');
  if(exitCode!==0)throw new Error(`ffmpeg exited ${exitCode}`);
  for(const [start,end] of [[0,23],[24,47],[48,71],[72,87]]){
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-framerate','1',
      '-start_number',String(start),'-i',`${root}/contact-frames/%03d.jpg`,
      '-vf',`scale=240:150,tile=6x4:nb_frames=${end-start+1}`,
      '-frames:v','1',`${root}/contact-${String(start).padStart(2,'0')}-${end}.png`]);
  }
  console.log('cycle video and contacts complete');
} finally {encoder.stdin.destroy();await browser.close();}
