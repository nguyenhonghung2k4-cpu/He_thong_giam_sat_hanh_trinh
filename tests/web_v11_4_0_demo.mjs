// HTTP/state test only. Explicitly MOCKED transport ACKs are NOT model accuracy.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..','WebDashboard_Online'),DEMO='blackbox-esp32s3-auto-demo',REAL='blackbox-esp32s3-01',KEY='tinyml-transport-test',wait=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const temp=await mkdtemp(join(tmpdir(),'telematics-tinyml-')),database=join(temp,'test.db'),base=`http://127.0.0.1:${await port()}`;
const child=spawn(process.execPath,[join(ROOT,'server.mjs')],{cwd:ROOT,windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:base.split(':').at(-1),DATABASE_FILE:database,INGEST_API_KEY:KEY,DEMO_SPEED:'12',DEMO_SPEAKER_ENABLED:'true',DEMO_SPEAKER_DEVICE_ID:REAL},stdio:['ignore','pipe','pipe']});
let output='',realSeq=0,demoSeq=50000,session='',timer=null;child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
async function req(path,method='GET',body,expected=200){const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${KEY}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const d=await r.json();assert.equal(r.status,expected,`${method} ${path}: ${JSON.stringify(d)}`);return d;}
async function heartbeat(){return req('/api/telemetry','POST',{device_id:REAL,boot_id:'mock-real-gateway',seq:++realSeq,ts:new Date().toISOString(),location:{valid:true,lat:20.9036,lon:105.8266,speed_kph:0,satellites:12,hdop:.8},ecu:{online:true,speed_kph:0},road:{valid:true,label:'duong_bang_phang',confidence:.99},system:{sd_ok:true,ai_ready:true,navigation_ready:true,firmware_version:'MOCK_TRANSPORT_TEST_ONLY'}},201);}
async function point(p){return req('/api/telemetry','POST',{device_id:DEMO,boot_id:session,session_id:session,seq:++demoSeq,ts:new Date().toISOString(),location:{valid:true,...p,speed_kph:9,satellites:12,hdop:.9},ecu:{online:true,speed_kph:30},road:{valid:false,label:'unknown',confidence:0},system:{sd_ok:true,ai_ready:false}},201);}
async function events(){return (await req(`/api/events/search?device_id=${DEMO}&limit=200`)).events||[];}
async function next(){return (await req(`/api/device-commands/next?device_id=${REAL}`)).command;}
async function ack(c,result){return req('/api/device-commands/result','POST',{device_id:REAL,command_id:c.id,ok:true,result});}
function result(label,confidence=.99,hazard=true){const v=(1-confidence)/2,scores={duong_bang_phang:v,go_giam_toc:v,o_ga:v};scores[label]=confidence;return {test_transport_mock:true,inference_ok:true,label,confidence,scores,frame_samples:200,frequency_hz:100,units:'g',model_version:'telematics-ei-1.0.1',inference_ms:7,hazard_accepted:hazard};}
async function send(sample_id,position){return req('/api/demo/tinyml','POST',{sample_id,session_id:session,position},201);}
async function stop(){await req('/api/demo/stop','POST',{});for(let i=0;i<80;i++){if(!(await req('/api/demo/status')).demo.running)return;await wait(40);}throw Error('Demo did not stop');}
function sql(fn){const db=new DatabaseSync(database);try{fn(db);}finally{db.close();}}
try{
  for(let i=0;i<100;i++){try{await req('/api/health');break;}catch{if(i===99)throw Error(output);await wait(50);}}
  const catalog=await req('/api/demo/tinyml');assert.equal(catalog.samples.length,2);assert.equal(catalog.model.frequency_hz,100);for(const s of catalog.samples){assert.equal(s.values.length,600);assert.equal(s.units,'g');assert.ok(s.source_file);assert.ok(s.values.every(Number.isFinite));}
  session=(await req('/api/demo/start','POST',{},202)).demo.session_id;
  let car;for(let i=0;i<80;i++){car=(await req(`/api/dashboard?device_id=${DEMO}`)).latest;if(car?.boot_id===session)break;await wait(30);}assert.ok(car?.lat);
  const rejected=await req('/api/demo/tinyml','POST',{sample_id:'pothole',session_id:session,position:{lat:car.lat,lon:car.lon}},409);assert.equal(rejected.code||rejected.error,'gateway_offline');assert.equal(await next(),null);
  await heartbeat();timer=setInterval(()=>heartbeat().catch(()=>{}),700);
  car=(await req(`/api/dashboard?device_id=${DEMO}`)).latest;const captured={lat:car.lat,lon:car.lon},queued=await send('pothole',captured);assert.deepEqual({lat:queued.captured_position.lat,lon:queued.captured_position.lon},captured);
  let c=await next();assert.equal(c.id,queued.command.id);assert.equal(c.action,'demo_infer');assert.equal(c.values.length,600);assert.equal(c.demo_session_id,session);assert.deepEqual(c.values,catalog.samples.find(s=>s.id==='pothole').values);assert.equal(c.label,undefined);assert.equal(c.confidence,undefined);
  assert.equal((await events()).filter(e=>/detected$/.test(e.name)).length,0,'Event before ACK');await wait(250);
  const confirmed=await ack(c,result('go_giam_toc'));assert.equal(confirmed.status,'done',JSON.stringify(confirmed));assert.equal(confirmed.result.map_point_created,true);
  const detection=(await events()).find(e=>e.name==='speed_bump_detected');assert.ok(detection,'Selected sample forced label instead of actual prediction');assert.equal(detection.lat,captured.lat);assert.equal(detection.lon,captured.lon);
  await ack(c,result('go_giam_toc'));assert.equal((await events()).filter(e=>e.event_uid===detection.event_uid).length,1,'Duplicate ACK event');
  car=(await req(`/api/dashboard?device_id=${DEMO}`)).latest;const pending=await send('speed_bump',{lat:car.lat,lon:car.lon}),late=await next();assert.equal(late.id,pending.command.id);
  await stop();assert.equal((await ack(late,result('o_ga'))).status,'failed');assert.equal((await events()).filter(e=>e.name==='pothole_detected').length,0);
  // Controlled external session: same authenticated APIs, no moving child.
  session=`transport-controlled-${Date.now()}`;const origin={lat:20.9041,lon:105.8267};await req('/api/routes/start','POST',{device_id:DEMO},201);await point(origin);const state=(await req('/api/demo/status')).demo;assert.equal(state.session_id,session);assert.equal(state.running,true);
  const before=(await events()).filter(e=>/detected$/.test(e.name)).length;
  await send('pothole',origin);c=await next();await ack(c,result('duong_bang_phang',.99,false));assert.equal((await events()).filter(e=>/detected$/.test(e.name)).length,before,'Flat made marker');
  await send('pothole',origin);c=await next();await ack(c,result('o_ga',.6,false));assert.equal((await events()).filter(e=>/detected$/.test(e.name)).length,before,'Low confidence made marker');
  await send('pothole',origin);c=await next();const low=await ack(c,result('o_ga',.6,true));assert.equal(low.result.hazard_accepted,false,'Server trusted an inconsistent low-confidence accepted flag');assert.equal((await events()).filter(e=>/detected$/.test(e.name)).length,before);
  await send('pothole',origin);c=await next();const bad=await ack(c,{...result('o_ga'),units:'m/s2'});assert.equal(bad.status,'failed','Incorrect model units accepted');assert.equal((await events()).filter(e=>/detected$/.test(e.name)).length,before);
  await send('speed_bump',origin);c=await next();const moved={lat:origin.lat+.00032,lon:origin.lon};await point(moved);assert.equal((await ack(c,result('o_ga'))).result.map_point_created,true);
  const pothole=(await events()).find(e=>e.name==='pothole_detected');assert.equal(pothole.lat,origin.lat);assert.equal(pothole.lon,origin.lon,'ACK used later position');assert.equal(await next(),null,'First detection sounded');
  await point(moved);await point({lat:origin.lat+.00005,lon:origin.lon});await wait(800);const voice=await next();assert.equal(voice.action,'audio_play');assert.equal(voice.sound,'pothole');await ack(voice,{speaker_accepted:true,test_transport_mock:true});
  await point(origin);await point({lat:origin.lat+.00002,lon:origin.lon});assert.equal(await next(),null,'Repeated voice inside approach');assert.equal((await events()).filter(e=>e.name==='pothole_proximity').length,1);
  await send('pothole',origin);c=await next();sql(db=>{const row=db.prepare('SELECT params_json FROM device_commands WHERE id=?').get(c.id),p=JSON.parse(row.params_json);p.expires_at_ms=Date.now()-1;db.prepare('UPDATE device_commands SET params_json=? WHERE id=?').run(JSON.stringify(p),c.id);});const expired=await ack(c,result('go_giam_toc'));assert.equal(expired.status,'failed');assert.equal(expired.result.inference_ok,false);
  await req('/api/demo/tinyml','POST',{sample_id:'pothole',session_id:'old-session',position:origin},409);
  const real=await req(`/api/dashboard?device_id=${REAL}`);assert.equal(real.latest.road_label,'duong_bang_phang');assert.equal(real.potholes.length,0);assert.equal(real.speed_bumps.length,0);assert.equal((await req('/api/dashboard')).device_id,REAL);
  console.log('PASS V11.4.0 transport: raw600 XYZ, frozen click/session, no event before mock ACK, actual predicted class, duplicate/flat/low/stale/offline gates, one voice per rearmed approach, isolation. MOCK ACKS ARE NOT MODEL ACCURACY.');
}catch(e){throw Error(`${e.message}\nSERVER:\n${output}`);}finally{clearInterval(timer);try{await req('/api/demo/stop','POST',{});}catch{}if(!child.killed)child.kill();await wait(600);await rm(temp,{recursive:true,force:true});}
