import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../Arduino/ESP32S3_Telematics');
for(const name of ['o_ga','go_giam_toc','qua_toc_do']){
  const text=fs.readFileSync(path.join(root,`audio_${name}.inc`),'utf8');
  const bytes=Buffer.from((text.match(/0x[0-9a-f]{2}\b/gi)||[]).map(x=>parseInt(x,16)));
  assert.equal(bytes.toString('ascii',0,4),'RIFF');
  assert.equal(bytes.toString('ascii',8,12),'WAVE');
  assert.equal(bytes.readUInt32LE(4)+8,bytes.length);
  let fmt=null,data=null;
  for(let p=12;p+8<=bytes.length;){
    const name=bytes.toString('ascii',p,p+4),n=bytes.readUInt32LE(p+4),start=p+8;
    assert.ok(start+n<=bytes.length,'truncated WAV chunk');
    if(name==='fmt ')fmt=bytes.subarray(start,start+n);
    if(name==='data')data=bytes.subarray(start,start+n);
    p=start+n+(n&1);
  }
  assert.ok(fmt&&data);
  assert.equal(fmt.readUInt16LE(0),1,'PCM');
  assert.equal(fmt.readUInt16LE(14),16,'16-bit');
  const channels=fmt.readUInt16LE(2),rate=fmt.readUInt32LE(4);
  assert.ok(channels===1||channels===2);
  assert.ok(rate>=8000&&rate<=48000);
  assert.equal(data.length%(channels*2),0);
  console.log(`PASS ${name}: PCM16 ${rate}Hz ${channels}ch, ${(data.length/(rate*channels*2)).toFixed(2)}s`);
}
for(const fn of ['config.h','config.example.h']){
  const text=fs.readFileSync(path.join(root,fn),'utf8');
  assert.ok(/AUDIO_PCM_GAIN_PERCENT\s*=\s*100\s*;/.test(text), `${fn}: PCM must remain 100%`);
  assert.ok(/SD_SPI_FREQUENCY_HZ\s*=\s*1000000\s*;/.test(text), `${fn}: SD must remain 1MHz`);
  assert.ok(/11\.6\.1-MARKER-FIFO-FIX/.test(text), `${fn}: expected V11.6.1 marker/FIFO build identity`);
  for (const key of ['WIFI_SSID','WIFI_PASSWORD','SERVER_URL','DEVICE_ID','HTTP_API_KEY','SITES_BYPASS_TOKEN']) {
    // A quoted replacement token may immediately follow an object-like macro name.
    // Preserve the user's existing credentials instead of rewriting private headers.
    assert.ok(new RegExp('^#define\\s+'+key+'\\s*"[^\\r\\n]*"\\s*(?://[^\\r\\n]*)?$', 'm').test(text), `${fn}: missing string macro ${key}`);
  }
  assert.ok(!/^\s*null\s*$/m.test(text), `${fn}: invalid configuration merge`);
  // Do not print Wi-Fi keys, server credentials or complete configuration.
}
console.log('PASS: both configuration headers retain PCM 100%, SD 1MHz and the new build identity.');
