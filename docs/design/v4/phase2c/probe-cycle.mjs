import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require=createRequire(import.meta.url);
const { chromium }=require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const output='docs/design/v4/phase2c';
mkdirSync(`${output}/stills`,{recursive:true});
const browser=await chromium.launch({headless:false,args:['--enable-webgl','--use-gl=angle','--use-angle=d3d11']});
const report={cycleSeconds:88,idleSeconds:24,widths:[],errors:[]};
const captures=new Map([[5,'assignment'],[18,'review'],[31,'celebrate'],[39,'report'],[48,'awaiting'],[51,'error'],
  [55,'emergency'],[59,'release'],[72,'idle']]);
const rectOverlap=(a,b)=>a&&b&&a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
const nearPoint=(rect,point,pad=12)=>rect&&point&&point.x>=rect.x-pad&&point.x<=rect.x+rect.width+pad&&
  point.y>=rect.y-pad&&point.y<=rect.y+rect.height+pad;
try {
  for(const width of (process.argv[2]?[Number(process.argv[2])]:[1100,1440,1920])) {
    const page=await browser.newPage({viewport:{width,height:900},deviceScaleFactor:1});
    await page.clock.install({time:new Date('2026-10-28T12:00:00Z')});
    await page.clock.pauseAt(new Date('2026-10-28T12:00:01Z'));
    page.on('pageerror',error=>report.errors.push({width,error:error.message}));
    page.on('console',message=>{if(message.type()==='error')report.errors.push({width,error:message.text()});});
    page.on('response',response=>{if(response.status()>=400)report.errors.push({width,status:response.status(),url:response.url()});});
    await page.goto('http://127.0.0.1:5198/?officeDemo=cycle&studio3d=1',{waitUntil:'networkidle'});
    for(let attempt=0;attempt<20;attempt++){
      if(await page.evaluate(()=>!!window.render_game_to_text&&JSON.parse(window.render_game_to_text(false)).ready))break;
      await page.clock.runFor(100);
    }
    if(!await page.evaluate(()=>!!window.render_game_to_text&&JSON.parse(window.render_game_to_text(false)).ready))
      throw new Error('Studio 3D did not become ready');
    const first=JSON.parse(await page.evaluate(()=>window.render_game_to_text(false)));
    if(first.people.length!==13)throw new Error(`Expected 13 people at ${width}, got ${first.people.length}`);
    const stats={width,frames:0,minSeparation:Infinity,minAt:null,minVisualSeparation:Infinity,
      minVisualAt:null,maxActorStep:0,maxVisualStep:0,
      maxVisualAt:null,maxTagStep:0,maxTagAt:null,
      emergencyAt:null,releasedAt:null,footprintViolations:[],tagOverlaps:[],capacityViolations:[],
      facingViolations:[],freezeViolations:[],idleMovers:[],visitArrivals:[],peopleCount:first.people.length,
      chairViolations:[],chairPushViolations:[],chipViolations:[],blinkMax:{},sitTypeBlinkMax:0,sofaTalkMouthMax:0,
      folderWalkFrames:0,footSlide:null,footprintCount:first.footprints.length,initialTime:first.time};
    const moved=new Set();let frozen=null;let previous=first;
    const home=new Map(first.people.map(p=>[p.id,{x:p.x,z:p.z}]));
    for(let index=1;index<=2200;index++) {
      await page.evaluate(()=>window.advanceTime(40));
      await page.clock.runFor(40);
      const state=JSON.parse(await page.evaluate(()=>window.render_game_to_text(false)));
      stats.frames++;
      for(const p of state.people){const old=previous.people.find(other=>other.id===p.id);
        if(!old)continue;
        stats.maxActorStep=Math.max(stats.maxActorStep,Math.hypot(p.x-old.x,p.z-old.z));
        const visualStep=Math.hypot((p.visualX??p.x)-(old.visualX??old.x),
          (p.visualZ??p.z)-(old.visualZ??old.z));
        if(visualStep>stats.maxVisualStep){stats.maxVisualStep=visualStep;stats.maxVisualAt={time:index*.04,id:p.id};}
        if(old.tagRect&&p.tagRect){const step=Math.hypot(p.tagRect.x-old.tagRect.x,p.tagRect.y-old.tagRect.y);
          if(step>stats.maxTagStep){stats.maxTagStep=step;stats.maxTagAt={time:index*.04,id:p.id};}}
      }
      for(let a=0;a<state.people.length;a++)for(let b=a+1;b<state.people.length;b++) {
        const p=state.people[a],q=state.people[b],distance=Math.hypot(p.x-q.x,p.z-q.z);
        if(distance<stats.minSeparation){stats.minSeparation=distance;stats.minAt={time:index*.04,a:p.id,b:q.id};}
        const visualDistance=Math.hypot((p.visualX??p.x)-(q.visualX??q.x),
          (p.visualZ??p.z)-(q.visualZ??q.z));
        if(visualDistance<stats.minVisualSeparation){stats.minVisualSeparation=visualDistance;
          stats.minVisualAt={time:index*.04,a:p.id,b:q.id};}
        if(rectOverlap(p.tagRect,q.tagRect)&&stats.tagOverlaps.length<10)stats.tagOverlaps.push({time:index*.04,a:p.id,b:q.id});
      }
      const protectedPoints=state.people.filter(person=>person.status==='awaiting_answer'||person.status==='error')
        .flatMap(person=>person.posePoints??[]);
      for(const tagged of state.people)if(tagged.tagRect)for(const point of protectedPoints)
        if(nearPoint(tagged.tagRect,point,8)&&stats.chipViolations.length<10)
          stats.chipViolations.push({time:index*.04,id:tagged.id,point:point.name});
      const counts={coffee:0,sofa:0,window:0,meeting:0};
      for(const p of state.people){
        if(index<=250)stats.blinkMax[p.id]=Math.max(stats.blinkMax[p.id]??0,p.eyeBlink??0);
        if(p.id!==first.people[0].id&&p.clip==='sit_type')
          stats.sitTypeBlinkMax=Math.max(stats.sitTypeBlinkMax,p.mixerBlink??0);
        if(p.id!==first.people[0].id&&p.clip==='sofa_talk')
          stats.sofaTalkMouthMax=Math.max(stats.sofaTalkMouthMax,p.mixerMouth??0);
        if(p.activeClip==='walk_folder')stats.folderWalkFrames++;
        const chairName=p.place==='producer'?'producer chair':p.place==='desk'?`chair ${p.seat}`:
          p.place==='meeting'?(['meeting 0','meeting 1','meeting 2'].find(name=>{
            const chair=state.chairs.find(item=>item.name===name);
            return chair&&Math.hypot(chair.homeX-p.x,chair.homeZ-p.z)<.3;})??''):'';
        const chair=state.chairs.find(item=>item.name===chairName);
        if(p.pose==='seated'&&chair&&Math.hypot(chair.x-chair.homeX,chair.z-chair.homeZ)>.025&&stats.chairViolations.length<10)
          stats.chairViolations.push({time:index*.04,id:p.id,chair:chairName,offset:Math.hypot(chair.x-chair.homeX,chair.z-chair.homeZ)});
        const homeChair=state.chairs.find(item=>item.name===`chair ${p.seat}`||
          p.seat===13&&item.name==='producer chair');
        if(p.walking&&homeChair&&Math.hypot(homeChair.x-homeChair.homeX,homeChair.z-homeChair.homeZ)<.16&&
          stats.chairPushViolations.length<10)
          stats.chairPushViolations.push({time:index*.04,id:p.id});
        if(p.place in counts)counts[p.place]++;
        const seat=home.get(p.id);
        if(index>=1600&&seat&&Math.hypot(p.x-seat.x,p.z-seat.z)>.6)moved.add(p.id);
        if(p.walking)for(const box of state.footprints){
          if(p.x>box.minX-.15&&p.x<box.maxX+.15&&p.z>box.minZ-.15&&p.z<box.maxZ+.15&&stats.footprintViolations.length<10)
            stats.footprintViolations.push({time:index*.04,id:p.id,box:box.name,x:p.x,z:p.z});
        }
        if(p.visiting&&Math.hypot(p.x-p.target.x,p.z-p.target.z)<.12){
          const visited=state.people.find(q=>q.id===p.visiting);
          if(visited){const wanted=Math.atan2(visited.x-p.x,visited.z-p.z),error=Math.abs(Math.atan2(Math.sin(p.yaw-wanted),Math.cos(p.yaw-wanted)));
            if(error>.45&&stats.facingViolations.length<10)stats.facingViolations.push({time:index*.04,id:p.id,error});
            else if(!stats.visitArrivals.some(item=>item.id===p.id))stats.visitArrivals.push({time:index*.04,id:p.id,visited:p.visiting});}
        }
      }
      for(const [place,limit] of Object.entries({coffee:2,sofa:2,window:2,meeting:3}))
        if(counts[place]>limit&&stats.capacityViolations.length<10)stats.capacityViolations.push({time:index*.04,place,count:counts[place]});
      if(state.emergency&&!frozen)frozen=state.people.map(p=>[p.id,p.x,p.z]);
      if(state.emergency&&stats.emergencyAt===null)stats.emergencyAt=index*.04;
      if(!state.emergency&&stats.emergencyAt!==null&&stats.releasedAt===null)stats.releasedAt=index*.04;
      if(state.emergency&&frozen)for(const p of state.people){const old=frozen.find(q=>q[0]===p.id);
        if(old&&Math.hypot(p.x-old[1],p.z-old[2])>.001&&stats.freezeViolations.length<10)stats.freezeViolations.push({time:index*.04,id:p.id});}
      if(!state.emergency)frozen=null;
      const second=Math.round(index*.04);
      if(width===1440&&Math.abs(index*.04-second)<.0001&&captures.has(second))
        await page.screenshot({path:`${output}/stills/${String(second).padStart(2,'0')}-${captures.get(second)}.png`});
      previous=state;
    }
    stats.idleMovers=[...moved];
    stats.footSlide=previous.footSlide;
    stats.footSlidePerStep=stats.footSlide.steps?{
      before:stats.footSlide.before/stats.footSlide.steps,
      after:stats.footSlide.after/stats.footSlide.steps}:null;
    report.widths.push(stats);
    writeFileSync(`${output}/probe-results.json`,JSON.stringify(report,null,2));
    await page.close();
  }
} finally {await browser.close();}
writeFileSync(`${output}/probe-results.json`,JSON.stringify(report,null,2));
const failures=report.widths.filter(item=>item.minSeparation<.45||item.minVisualSeparation<.45||
  item.maxActorStep>.07||item.maxVisualStep>.10||item.maxTagStep>8||
  item.footprintViolations.length||item.tagOverlaps.length||item.capacityViolations.length||
  item.facingViolations.length||item.freezeViolations.length||item.chairViolations.length||
  item.chairPushViolations.length||item.chipViolations.length||
  Object.keys(item.blinkMax).length!==13||Object.values(item.blinkMax).some(value=>value<=.01)||
  item.sitTypeBlinkMax<=.01||item.sofaTalkMouthMax<=.01||item.folderWalkFrames===0||
  item.footSlide.steps===0||item.footSlide.after>=item.footSlide.before||
  item.footSlidePerStep.after>.05||item.idleMovers.length<6||
  item.visitArrivals.length<3||item.emergencyAt>54||item.releasedAt>58);
if(failures.length||report.errors.length)process.exitCode=1;
console.log(JSON.stringify(report));
