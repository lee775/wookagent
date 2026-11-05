import { writeFileSync } from 'node:fs';

const width=16,height=16;
const xor=Buffer.alloc(width*height*4);
for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
  const index=((height-1-y)*width+x)*4;
  const frame=x>=2&&x<=13&&y>=2&&y<=13;
  const pane=frame&&x>=4&&x<=11&&y>=4&&y<=11;
  xor[index]=pane?198:frame?69:0;
  xor[index+1]=pane?220:frame?105:0;
  xor[index+2]=pane?215:frame?67:0;
  xor[index+3]=frame?255:0;
}
const mask=Buffer.alloc(width*height/8);
const dib=Buffer.alloc(40);
dib.writeUInt32LE(40,0);dib.writeInt32LE(width,4);dib.writeInt32LE(height*2,8);
dib.writeUInt16LE(1,12);dib.writeUInt16LE(32,14);
dib.writeUInt32LE(xor.length+mask.length,20);
const header=Buffer.alloc(22);
header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);
header[6]=width;header[7]=height;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);
header.writeUInt32LE(dib.length+xor.length+mask.length,14);header.writeUInt32LE(header.length,18);
writeFileSync('src/renderer/public/favicon.ico',Buffer.concat([header,dib,xor,mask]));
