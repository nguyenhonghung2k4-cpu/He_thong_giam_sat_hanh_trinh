// Isolated HTTP/config/geofence regression. TinyML/device ACKs are MOCKED:
// this verifies protocol behavior, not physical CAN, audio or model accuracy.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..','WebDashboard_Online');
const DEMO='blackbox-esp32s3-auto-demo',REAL='blackbox-esp32s3-01',KEY='v1141-geofence-test';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const temp=await mkdtemp(join(tmpdir(),'telematics-v1141-')),base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,[join(ROOT,'server.mjs')],{cwd:ROOT,windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATABASE_FILE:join(temp,'test.db'),INGEST_API_KEY:KEY,DEMO_SPEAKER_ENABLED:'true',DEMO_SPEAKER_DEVICE_ID:REAL},stdio:['ignore','pipe','pipe']});
let output='',realSeq=0,demoSeq=0,displaySeq=0,session=`demo-test-${Date.now()}`,realBoot='real-boot-A';
child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
const config=radius=>({overspeed_warning_kph:120,overspeed_clear_kph:115,geofence_warning_m:radius,geofence_rearm_m:radius===30?40:radius+10,pothole_confidence:.8,speed_bump_confidence:.8});
const origin={lat:20.9041,lon:105.8267};const at=meters=>({lat:origin.lat+meters/111194.92664456,lon:origin.lon});
async function req(path,method='GET',body,status=200,headers={}){const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${KEY}`,'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});const d=await r.json();assert.equal(r.status,status,`${path}: ${JSON.stringify(d)}`);return d;}
async function real(cfg=config(30),extra={},headers={}){return req('/api/telemetry','POST',{type:'telemetry',device_id:REAL,boot_id:realBoot,seq:++realSeq,ts:new Date().toISOString(),location:{valid:true,...origin,speed_kph:0},ecu:{online:true},road:{valid:true,label:'duong_bang_phang',confidence:.99},system:{runtime_config:cfg,sd_ok:true,firmware_version:'MOCK_PROTOCOL_ONLY'},...extra},201,headers);}
async function car(meters){return req('/api/telemetry','POST',{type:'telemetry',device_id:DEMO,boot_id:session,seq:++demoSeq,ts:new Date().toISOString(),location:{valid:true,...at(meters),speed_kph:20},ecu:{online:true},road:{valid:false,label:'unknown'},system:{runtime_config:config(3)}},201);}
async function display(meters,extra={}){return req('/api/demo/display-position','POST',{session_id:session,client_id:'visible-test-tab',sequence:++displaySeq,position:at(meters),...extra});}
async function next(device=REAL){return req(`/api/device-commands/next?device_id=${device}`);}
async function ack(command,result={speaker_accepted:true,mock:true}){return req('/api/device-commands/result','POST',{device_id:REAL,command_id:command.id,ok:true,result});}
async function cfg(){return (await req(`/api/device-config?device_id=${DEMO}`)).config;}
async function events(){return (await req(`/api/events/search?device_id=${DEMO}&limit=200`)).events||[];}
try{
  for(let i=0;i<100;i++){try{await req('/api/health');break;}catch{if(i===99)throw Error(output);await wait(50);}}
  await real(config(30));await req('/api/routes/start','POST',{device_id:DEMO},201);await car(0);
  const initial=await cfg();assert.equal(initial.device_id,REAL);assert.equal(initial.view_device_id,DEMO);assert.equal(initial.confirmed,true);assert.equal(initial.geofence_warning_m,30);
  assert.equal((await req('/api/device-config')).config.geofence_warning_m,30,'Latest demo must not select a default config');
  assert.equal((await req(`/api/dashboard?device_id=${DEMO}`)).device_config.geofence_warning_m,30);
  assert.equal((await req('/api/demo/status')).demo.device_config.geofence_warning_m,30);
  // Read NVS and save through the AUTO view must address the physical Gateway.
  const read=(await req('/api/device-config/read','POST',{device_id:DEMO},201)).command;assert.equal(read.device_id,REAL);assert.equal((await next()).command.id,read.id);await ack(read,{config:config(10)});assert.equal((await cfg()).geofence_warning_m,10);
  const save=(await req('/api/device-config','POST',{device_id:DEMO,...config(30)},201)).command;assert.equal(save.device_id,REAL);assert.equal((await cfg()).geofence_warning_m,10,'Unacknowledged save changed effective radius');assert.equal((await cfg()).pending_command.id,save.id);await ack(save,{config:config(30)});assert.equal((await cfg()).geofence_warning_m,30);assert.equal((await cfg()).pending_command,null);
  // Old queue/replay packets cannot roll the applied settings back.
  await real(config(3),{seq:1});assert.equal((await cfg()).geofence_warning_m,30);
  await real(config(3),{}, {'X-Telematics-Resend':'1'});assert.equal((await cfg()).geofence_warning_m,30);
  realBoot='real-boot-B';await real(config(10));assert.equal((await cfg()).geofence_warning_m,10);
  await real(config(3),{boot_id:'real-boot-A'});assert.equal((await cfg()).geofence_warning_m,10);
  await real(config(30));assert.equal((await cfg()).geofence_warning_m,30,'Old boot poisoned subsequent current snapshots');
  const active=await next();assert.equal(active.demo_active,true);assert.equal(active.next_poll_ms,500);assert.equal(active.command,null);const other=await next('another-gateway');assert.equal(other.demo_active,false);assert.equal(other.next_poll_ms,3000);
  const queued=await req('/api/demo/tinyml','POST',{sample_id:'pothole',session_id:session,position:origin},201);const infer=(await next()).command;assert.equal(infer.id,queued.command.id);
  const inferred=await ack(infer,{inference_ok:true,label:'o_ga',confidence:.95,scores:{o_ga:.95,go_giam_toc:.03,duong_bang_phang:.02},frame_samples:200,frequency_hz:100,units:'g',model_version:'telematics-ei-1.0.1',inference_ms:6,hazard_accepted:true,mock:true});assert.equal(inferred.result.map_point_created,true);assert.equal((await next()).command,null,'First detection played audio');
  // Activate painted-marker authority outside the rearm radius.
  await car(50);await display(50);await car(31);await display(31);assert.equal((await next()).command,null);
  await car(29);assert.equal((await next()).command,null,'Server car ran ahead of painted marker');assert.equal((await events()).filter(e=>e.name==='pothole_proximity').length,0);
  await display(31);assert.equal((await next()).command,null,'31m is outside configured30m');await display(29);
  let voice=(await next()).command;assert.equal(voice?.action,'audio_play');let played=await ack(voice);assert.equal(played.status,'done');assert.equal(played.play_audio,true);assert.equal((await ack(voice)).play_audio,true,'Lost ACK recovery rejected valid duplicate');
  await display(28);assert.equal((await next()).command,null,'Repeated voice inside same approach');assert.equal((await events()).filter(e=>e.name==='pothole_proximity').length,1);
  const old=await display(28,{sequence:displaySeq-1});assert.equal(old.accepted,false);assert.equal(old.reason,'old_display_sequence');
  // A second visible tab cannot steal a live viewer's lease. If the first
  // tab stalls, the server must NOT fall back to its newer car position;
  // a new visible tab may take over only after the old lease expires.
  const competitor=await display(28,{client_id:'other-visible-tab'});assert.equal(competitor.accepted,false);assert.equal(competitor.reason,'another_demo_view_is_active');
  await car(50);await display(50);await wait(1600);await car(29);
  assert.equal((await next()).command,null,'Stale viewer fell back to the ahead-of-display server car');
  assert.equal((await events()).filter(e=>e.name==='pothole_proximity').length,1);
  assert.equal((await display(31,{client_id:'other-visible-tab'})).accepted,true,'Expired viewer lease could not be acquired');
  assert.equal((await next()).command,null,'New viewer still outside30m triggered audio');
  await display(29,{client_id:'other-visible-tab'});voice=(await next()).command;assert.equal(voice?.action,'audio_play');assert.equal((await ack(voice)).play_audio,true);
  await wait(1600);await car(25);assert.equal((await display(25)).accepted,true);
  // Reconfigure live to10m. A painted11m marker remains outside even when
  // the authoritative telemetry has already crossed to9m.
  await real(config(10));assert.equal((await cfg()).geofence_warning_m,10);await car(25);await display(25);await car(11);await display(11);await car(9);assert.equal((await next()).command,null);await display(11);assert.equal((await next()).command,null);await display(9);voice=(await next()).command;assert.equal(voice?.action,'audio_play');
  // Radius changed while the ESP handled its command: HTTP200 is NOT
  // authorization to play a stale sound.
  await real(config(3));played=await ack(voice);assert.equal(played.play_audio,false);assert.equal(played.status,'failed');assert.equal((await ack(voice)).play_audio,false,'Cancelled ACK resurrected audio');
  await car(15);await display(15);await car(4);await display(4);await car(2);assert.equal((await next()).command,null);await display(2);voice=(await next()).command;assert.equal(voice?.action,'audio_play');await req('/api/demo/stop','POST',{});played=await ack(voice);assert.equal(played.play_audio,false);assert.equal(played.status,'failed');assert.equal((await next()).next_poll_ms,3000);
  const realDash=await req(`/api/dashboard?device_id=${REAL}`);assert.equal(realDash.potholes.length,0);assert.equal(realDash.latest.road_label,'duong_bang_phang');
  console.log('PASS V11.4.1: canonical30m/10m settings, NVS/read/save ACK, fresh runtime config and replay guard; painted outside=no voice; one voice on entry; stale/multiple viewer lease guard;500ms scoped polling; changed/cancelled ACK blocks playback; live isolation. Device/model ACKs are MOCKED.');
}catch(error){throw Error(`${error.stack}\nSERVER:\n${output}`);}finally{try{await req('/api/demo/stop','POST',{});}catch{}if(!child.killed)child.kill();await wait(500);await rm(temp,{recursive:true,force:true});}
