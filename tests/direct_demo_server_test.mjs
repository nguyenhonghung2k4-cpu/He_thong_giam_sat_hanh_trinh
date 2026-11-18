// Isolated HTTP/SQLite test. Mock ESP packets are NOT actual TinyML results.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {routeLength,distanceM} from '../WebDashboard_Online/direct-demo.mjs';
const root=fileURLToPath(new URL('../WebDashboard_Online/',import.meta.url));
const folder=await mkdtemp(join(tmpdir(),'direct-http-'));
const dbFile=join(folder,'test.db'),key='isolated-direct-test-key',device='test-physical',virtual=device+'-direct-demo';
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const base=`http://127.0.0.1:${port}`,wait=ms=>new Promise(r=>setTimeout(r,ms));
let output='',child,db,seq=0,session;
let road;
const legacyRoad={id:'known-test-road',name:'TEST ROAD - LEGACY CACHE FIXTURE ONLY',points:[[20.9,105.82],[20.9,105.8205],[20.9,105.821]],length_m:0};legacyRoad.length_m=routeLength(legacyRoad.points);
const cfg={overspeed_warning_kph:120,overspeed_clear_kph:115,geofence_warning_m:10,geofence_rearm_m:20,pothole_confidence:.8,speed_bump_confidence:.8};
async function request(path,body,status=200,extra={}){
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`,...extra},body:body===undefined?undefined:JSON.stringify(body)});
  const json=await r.json();assert.equal(r.status,status,`${path}: ${JSON.stringify(json)}`);return json;
}
function routePosition(distance){
  for(let i=1;i<road.points.length;i++){
    const length=distanceM(road.points[i-1],road.points[i]);
    if(distance<=length){const t=length?distance/length:0;return {lat:road.points[i-1][0]+t*(road.points[i][0]-road.points[i-1][0]),lon:road.points[i-1][1]+t*(road.points[i][1]-road.points[i-1][1])};}
    distance-=length;
  }
  return {lat:road.points.at(-1)[0],lon:road.points.at(-1)[1]};
}
const snapshot=(state='running',distance=0,pass=1)=>({session_id:session.session_id,active:state!=='stopped',state,pass_index:pass,...routePosition(distance),distance_m:distance,route_length_m:road.length_m,speed_kph:state==='running'?40:0,input_speed_kph:20,speed_multiplier:2});
function payload(s=null,boot='real-boot') {return {type:'telemetry',device_id:device,boot_id:boot,seq:++seq,ts:new Date().toISOString(),uptime_ms:seq*1000,
  location:{valid:true,lat:20.9,lon:105.82,satellites:12,hdop:.8,speed_kph:0},
  ecu:{online:true,speed_kph:20,temperature_c:29,dtc_active:false},road:{valid:true,label:'duong_bang_phang',confidence:.99},
  system:{sd_ok:true,sd_state:'online',ai_ready:true,navigation_ready:true,firmware_version:'11.5.0-DIRECT-DEMO',runtime_config:cfg},direct_demo:s};}
async function packet(s=null,headers={}){return request('/api/telemetry',payload(s),201,headers);}
async function next(){return (await request(`/api/device-commands/next?device_id=${device}`)).command;}
async function ack(command,s){return request('/api/device-commands/result',{device_id:device,command_id:command.id,ok:true,result:{applied:true,direct_demo:s}});}
async function state(){return (await request('/api/direct-demo/state')).session;}
try {
  child=spawn(process.execPath,[join(root,'server.mjs')],{cwd:root,windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATABASE_FILE:dbFile,INGEST_API_KEY:key,DEMO_SPEAKER_ENABLED:'false',DEMO_SPEAKER_DEVICE_ID:device},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await wait(75);}assert(ready,output);
  db=new DatabaseSync(dbFile);db.exec('PRAGMA busy_timeout=5000');
  // Prepared routes are available before any GNSS/ECU packet and are not
  // replaced by legacy OSM cache rows from an older project database.
  db.prepare('INSERT INTO direct_demo_road_cache VALUES(?,?,?,?,?)').run(device,Date.now(),20.9,105.82,JSON.stringify([legacyRoad]));
  const candidates=await request('/api/direct-demo/roads');
  assert.equal(candidates.source,'osm_road');assert.equal(candidates.synthetic,false);
  assert.equal(candidates.requires_gps,false);assert.equal(candidates.requires_network,false);
  road=candidates.roads.find(row=>row.id==='kma-chien-thang-tan-trieu');
  assert.ok(road,'cached real road beside KMA is present');assert.notEqual(road.id,legacyRoad.id);
  assert(Math.abs(road.length_m-605.3863)<.01);
  assert.equal(road.source,'osm_road');assert.equal(road.synthetic,false);
  await packet();
  await request('/api/direct-demo/start',{device_id:device,road_id:'invented'},422);
  await request('/api/direct-demo/start',{device_id:device,road_id:road.id,speed_multiplier:9},422);
  await request('/api/direct-demo/start',{device_id:device,road_id:road.id},403,{Origin:'https://untrusted.invalid'});
  const start=await request('/api/direct-demo/start',{device_id:device,road_id:road.id,speed_multiplier:2},202);session=start.session;assert.equal(session.state,'starting');
  assert.equal(db.prepare('SELECT count(*) AS n FROM routes WHERE device_id=?').get(virtual).n,0,'queue is not an applied trip');
  const duplicate=await request('/api/direct-demo/start',{device_id:device,road_id:road.id,speed_multiplier:2},202);assert.equal(duplicate.command_id,start.command_id);
  await request('/api/demo/start',{},409);
  const startCommand=await next();assert.equal(startCommand.action,'direct_demo_start');assert(startCommand.expires_in_ms>0);assert.deepEqual(startCommand.route_points,road.points.flat());
  await ack(startCommand,snapshot());assert.equal((await state()).state,'running');assert.equal((await ack(startCommand,snapshot())).duplicate_ack,true);
  await packet(snapshot());await packet(snapshot('running',25));
  await request('/api/routes/start',{device_id:virtual},409);
  await request('/api/routes/end',{device_id:virtual},409);
  await request('/api/hazards/delete',{device_id:virtual,kind:'pothole',lat:20.9,lon:105.82},409);
  const realDash=await request('/api/dashboard?device_id='+device),virtualDash=await request('/api/dashboard?device_id='+virtual);
  assert.equal(realDash.latest.lon,105.82);assert.equal(virtualDash.latest.lon,snapshot('running',25).lon);assert.equal(virtualDash.latest.ecu_speed_kph,20);assert.equal(virtualDash.latest.speed_kph,40);
  assert.equal(virtualDash.latest.direct_demo.session_id,session.session_id);assert.equal(virtualDash.demo_mode,'direct');
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n,0,'road label alone must not fabricate an event');
  const evt={...payload(snapshot('running',25)),type:'event',road:{valid:true,label:'o_ga',confidence:.996},event:{id:'real-inference-mock-1',demo_mode:'direct',name:'pothole_detected',severity:'warning',gps_attached:true,new_map_point:true,lat:snapshot('running',25).lat,lon:snapshot('running',25).lon,confidence:.996,saved_to_sd:false,inference_source:'adxl345'}};
  await request('/api/events',evt,201);
  assert.equal(db.prepare('SELECT count(*) AS n FROM events WHERE device_id=?').get(device).n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM events WHERE device_id=?').get(virtual).n,1);
  const originalLon=db.prepare('SELECT lon FROM events WHERE device_id=?').get(virtual).lon;
  await packet(snapshot('running',60));await request('/api/events',evt,201,{'X-Telematics-Resend':'1'});
  assert.equal(db.prepare('SELECT count(*) AS n FROM events WHERE device_id=?').get(virtual).n,1);assert.equal(db.prepare('SELECT lon FROM events WHERE device_id=?').get(virtual).lon,originalLon);
  await request('/api/telemetry',{...payload(snapshot()),device_id:virtual},422);
  await packet(snapshot('completed',road.length_m));assert.equal((await state()).state,'completed');
  const firstRoute=db.prepare('SELECT * FROM routes WHERE device_id=? ORDER BY id').get(virtual);assert.equal(firstRoute.status,'completed');
  const repeat=await request('/api/direct-demo/control',{session_id:session.session_id,operation:'repeat'},202);
  await packet(snapshot('completed',road.length_m));assert.equal((await state()).pending_operation,'repeat','old completed telemetry cannot confirm repeat');
  const repeatCommand=await next();assert.equal(repeatCommand.id,repeat.command_id);await ack(repeatCommand,snapshot('running',0,2));
  await packet(snapshot('running',0,2));await packet(snapshot('running',20,2));
  assert.equal(db.prepare('SELECT count(*) AS n FROM routes WHERE device_id=?').get(virtual).n,2,'repeat starts a separate trip without teleport line');
  const detail=await request(`/api/routes/${firstRoute.id}?device_id=${virtual}`);assert.equal(detail.demo_mode,'direct');assert.equal(detail.events.length,1);
  const pause=await request('/api/direct-demo/control',{session_id:session.session_id,operation:'pause'},202);await ack(await next(),snapshot('paused',20,2));assert.equal((await state()).state,'paused');
  const stop=await request('/api/direct-demo/control',{session_id:session.session_id,operation:'stop'},202);await ack(await next(),snapshot('stopped',20,2));assert.equal((await state()).state,'stopped');
  const old=payload(snapshot('running',10,1));await request('/api/telemetry',old,201,{'X-Telematics-Resend':'1'});assert.equal((await state()).state,'stopped');assert.equal(db.prepare("SELECT count(*) AS n FROM routes WHERE device_id=? AND status='active'").get(virtual).n,0);
  await packet();const again=await request('/api/direct-demo/start',{device_id:device,road_id:road.id},202);session=again.session;
  await ack(await next(),snapshot());await packet(snapshot());await request('/api/telemetry',payload(null,'new-boot'),201);assert.equal((await state()).state,'interrupted');
  // Cancel a queued start that was never applied: authenticated no-session ACK
  // releases the lock without requiring a physical reboot.
  await packet();session=(await request('/api/direct-demo/start',{device_id:device,road_id:road.id},202)).session;
  await request('/api/direct-demo/control',{session_id:session.session_id,operation:'stop'},202);
  const cancel=await next();assert.equal(cancel.operation,'stop');
  const cancelled=await request('/api/device-commands/result',{device_id:device,command_id:cancel.id,ok:false,result:{error:'session_mismatch',direct_demo:null}});
  assert.equal(cancelled.status,'done');assert.equal(cancelled.result.confirmed_no_active_session,true);assert.equal((await state()).state,'stopped');
  const inactivePrevious=snapshot('stopped');
  // Delivered-but-unconfirmed expiry is uncertain, and must keep both demo
  // modes locked until fresh firmware explicitly confirms no active session.
  await packet();session=(await request('/api/direct-demo/start',{device_id:device,road_id:road.id},202)).session;
  const unconfirmed=await next();
  const params=JSON.parse(db.prepare('SELECT params_json FROM device_commands WHERE id=?').get(unconfirmed.id).params_json);
  params.expires_at_ms=Date.now()-1;db.prepare('UPDATE device_commands SET params_json=? WHERE id=?').run(JSON.stringify(params),unconfirmed.id);
  assert.equal((await state()).state,'unknown');await request('/api/demo/start',{},409);
  await request('/api/direct-demo/control',{session_id:session.session_id,operation:'stop'},202);
  const stopUnknown=await next();
  await request('/api/device-commands/result',{device_id:device,command_id:stopUnknown.id,ok:false,result:{error:'session_mismatch',direct_demo:inactivePrevious}});
  assert.equal((await state()).state,'stopped');
  // Preset coordinates are stable across runs and never replaced by vehicle
  // telemetry or the old OSM cache. Unknown route IDs were rejected above.
  const reloaded=await request('/api/direct-demo/roads?device_id='+device);
  assert.deepEqual(reloaded.roads.find(row=>row.id===road.id).points,road.points);
  console.log('PASS direct server: prepared route provenance/no-GPS discovery, real/virtual isolation, actual-event-only map, applied ACK/expiry field, retry idempotence, repeat stale-packet regression, trip history, controls, cancel-unapplied-start, reboot, resends, legacy-cache isolation and cross-origin rejection. Mock transport; no real ESP or OSM request.');
}catch(error){throw new Error(error.message+'\n'+output,{cause:error});}
finally{db?.close();child?.kill();if(child)await new Promise(r=>{child.once('exit',r);setTimeout(r,2000).unref();});}
