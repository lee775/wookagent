import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const browser=await chromium.launch({headless:false,args:['--enable-webgl','--use-gl=angle','--use-angle=d3d11']});
const report={};
try {
  const reduced=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  await reduced.goto('http://127.0.0.1:5198/?officeDemo=cycle&studio3d=1',{waitUntil:'networkidle'});
  await reduced.waitForFunction(()=>window.render_game_to_text&&JSON.parse(window.render_game_to_text(false)).ready);
  const frames=[];
  for(let second=0;second<88;second++){
    const state=JSON.parse(await reduced.evaluate(()=>{window.advanceTime(1000);return window.render_game_to_text(false);}));
    frames.push(state);
  }
  report.reducedMotion={walkingFrames:frames.filter(frame=>frame.people.some(person=>person.walking)).length,
    places:[...new Set(frames.flatMap(frame=>frame.people.map(person=>person.place)))],
    idleMovers:frames.slice(64).some(frame=>frame.people.some(person=>person.place!=='desk'))};
  await reduced.close();

  const interaction=await browser.newPage({viewport:{width:1440,height:900}});
  await interaction.goto('http://127.0.0.1:5198/?officeDemo=busy&studio3d=1',{waitUntil:'networkidle'});
  await interaction.waitForFunction(()=>window.render_game_to_text&&JSON.parse(window.render_game_to_text(false)).ready);
  const tag=interaction.locator('.studio3d-tag:visible').first();
  const tagName=await tag.locator('strong').textContent();
  await tag.hover();
  const cardVisible=await tag.locator('.studio3d-card').isVisible();
  await tag.click();
  await interaction.locator('.member-hero-art').waitFor();
  report.tagInteraction={tagName,cardVisible,panelOpened:await interaction.locator('.member-hero-art').isVisible()};
  await interaction.close();

  const emergency=await browser.newPage({viewport:{width:1440,height:900}});
  await emergency.clock.install({time:new Date('2026-10-28T12:00:00Z')});
  await emergency.goto('http://127.0.0.1:5198/?officeDemo=cycle&studio3d=1',{waitUntil:'networkidle'});
  await emergency.waitForFunction(()=>window.render_game_to_text&&JSON.parse(window.render_game_to_text(false)).ready);
  const sceneRect=()=>emergency.locator('.office-scene').evaluate(element=>{
    const {x,y,width,height}=element.getBoundingClientRect();return {x,y,width,height};});
  report.layout={before:await sceneRect()};
  await emergency.evaluate(()=>window.advanceTime(55000));await emergency.clock.runFor(55000);
  report.layout.during=await sceneRect();
  await emergency.screenshot({path:'docs/design/v4/phase2c/stills/emergency-layout.png'});
  await emergency.evaluate(()=>window.advanceTime(4000));await emergency.clock.runFor(4000);
  report.layout.after=await sceneRect();
  await emergency.close();

  const home=await browser.newPage({viewport:{width:1440,height:900}});
  await home.goto('http://127.0.0.1:5198/?officeDemo=working&capture=home',{waitUntil:'networkidle'});
  await home.waitForTimeout(1500);
  report.home=await home.locator('.main-agent-portrait').evaluate(image=>({tag:image.tagName,source:image.getAttribute('src')?.slice(0,24),width:image.getBoundingClientRect().width,height:image.getBoundingClientRect().height}));
  await home.screenshot({path:'docs/design/v4/phase2c/stills/home-portrait.png'});
  await home.close();

  const member=await browser.newPage({viewport:{width:1440,height:900}});
  await member.goto('http://127.0.0.1:5198/?officeDemo=working&capture=member',{waitUntil:'networkidle'});
  await member.waitForTimeout(1500);
  report.member=await member.locator('.member-hero-art').evaluate(image=>({tag:image.tagName,source:image.getAttribute('src')?.slice(0,24),width:image.getBoundingClientRect().width,height:image.getBoundingClientRect().height}));
  await member.screenshot({path:'docs/design/v4/phase2c/stills/member-portrait.png'});
  await member.close();
  writeFileSync('docs/design/v4/phase2c/ui-results.json',JSON.stringify(report,null,2));
  console.log(report);
} finally {await browser.close();}
