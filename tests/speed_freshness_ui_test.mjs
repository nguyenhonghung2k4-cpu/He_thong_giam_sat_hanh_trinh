import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Real UI functions, synthetic independent server/wall/monotonic clocks only.
// No database, real device, history fetch, timers or public network is touched.
const source=readFileSync(new URL('../WebDashboard_Online/public/dashboard.js',import.meta.url),'utf8');
const boundary=source.indexOf('  const SIDEBAR_PREF_KEY=');
assert(boundary>0);
let wall=100000,tick=1000;
class TestDate extends Date { static now(){return wall;} }
const nodes=new Map();
const node=id=>{
  if(!nodes.has(id))nodes.set(id,{textContent:'',className:'',style:{setProperty(){},removeProperty(){}},classList:{toggle(){},add(){},remove(){}},setAttribute(){}});
  return nodes.get(id);
};
let requests=0;
const window={TelematicsDirectGeometry:{confirmed:s=>['running','paused','completed','can_stale'].includes(s)}};
vm.runInNewContext(source.slice(0,boundary)+`\nwindow.audit={state,directView,directRealtime,rememberServerClock,serverTimeMs,realtimeFresh,renderDirectRealtimeReadings};})();`,{
  window,document:{getElementById:node},Date:TestDate,performance:{now:()=>tick},Intl,console,
  globalThis:{crypto:{randomUUID:()=> 'speed-fixture'}},
  fetch(){requests++;throw new Error('Speed freshness must not request data');},setTimeout,clearTimeout,
});
const {state,directView,directRealtime,rememberServerClock,serverTimeMs,realtimeFresh,renderDirectRealtimeReadings}=window.audit;
const advance=milliseconds=>{wall+=milliseconds;tick+=milliseconds;};
const calibrate=()=>{wall=100000;tick=1000;state.serverClock=null;rememberServerClock({server_now:100000,transport_delay_ms:20});};

calibrate();advance(100);
const slow={received_at_ms:100050};
rememberServerClock({server_now:100050,transport_delay_ms:2200,direct_realtime:slow});
assert.equal(realtimeFresh({received_at_ms:100100}),true,'slow query must not make another newly captured CAN/motion frame stale');
assert.equal(realtimeFresh(slow),false,'slow frame keeps its own conservative transit age');
assert.equal(serverTimeMs(),100120,'shared clock retains low-RTT monotonic projection');
rememberServerClock({server_now:100110,transport_delay_ms:5});
assert.equal(serverTimeMs(),100115,'better current sample can refine calibration without inheriting slow query delay');
rememberServerClock({server_now:100000,transport_delay_ms:1});
assert.equal(serverTimeMs(),100115,'older response cannot rewind calibration');
assert.equal(realtimeFresh({received_at_ms:serverTimeMs()-1499}),true);
assert.equal(realtimeFresh({received_at_ms:serverTimeMs()-1500}),false,'1.5s expiry is unchanged');

calibrate();advance(31000);
const projected=serverTimeMs();
rememberServerClock({server_now:131000,transport_delay_ms:2000});
assert.equal(serverTimeMs(),projected,'30s quality refresh cannot jump common clock ahead by one slow RTT');
assert.equal(state.serverClock.roundtripMs,2000,'expired quality baseline can refresh for a changed network');
assert.equal(realtimeFresh({received_at_ms:131000}),true);
const capture=serverTimeMs();wall-=50000;tick+=5000;
assert.equal(realtimeFresh({received_at_ms:capture}),false,'phone wall-clock rollback cannot freeze a 5s-old speed as fresh');

calibrate();
state.selectedDevice='real-direct-demo';state.vehicleCore={};
directView.session={session_id:'session',virtual_device_id:'real-direct-demo',device_id:'real',physical_boot_id:'boot',state:'running',pass_index:1,last_snapshot:{session_id:'session',pass_index:1,capture_ms:1000}};
const snap=(capture=1000)=>({session_id:'session',pass_index:1,capture_ms:capture,state:'running',can_fresh:true,speed_kph:84,input_speed_kph:42,distance_m:1});
const durable=()=>({device_id:'real-direct-demo',boot_id:'session',physical_boot_id:'boot',ingested_at:serverTimeMs()-100,uptime_ms:1000,ecu_online:1,ecu_speed_kph:42,direct_demo:snap()});
const fast=()=>({device_id:'real-direct-demo',source_device_id:'real',boot_id:'boot',received_at_ms:serverTimeMs()-1600,direct_demo:snap(1200),ecu:{online:true}});
state.data={latest:durable()};directRealtime.packet=fast();
renderDirectRealtimeReadings();
assert.equal(node('speed').textContent,'42','retained stale fast frame cannot erase an independent fresh periodic CAN reading');
assert.equal(node('gnss-speed').textContent,'84');
const rejected=(change,message)=>{
  state.data={latest:durable()};directRealtime.packet=fast();
  change(state.data.latest,directRealtime.packet);
  node('speed').textContent='—';renderDirectRealtimeReadings();
  assert.equal(node('speed').textContent,'—',message);
};
rejected(row=>row.ingested_at=serverTimeMs()-1500,'periodic fallback has same 1.5s budget, not 10s generic telemetry TTL');
rejected(row=>row.ecu_online=0,'offline periodic ECU must not be shown as current speed');
rejected(row=>row.ecu_speed_kph=null,'missing periodic runtime speed is not zero');
rejected(row=>row.device_id='other-direct-demo','different device cannot supply fallback');
rejected(row=>row.boot_id='other-session','different session boot cannot supply fallback');
rejected(row=>row.physical_boot_id='other-boot','physical reboot cannot supply fallback');
rejected(row=>row.direct_demo.session_id='other-session','different direct scope cannot supply fallback');
rejected(row=>row.direct_demo.pass_index=2,'different pass cannot supply fallback');
rejected((row,packet)=>{packet.received_at_ms=serverTimeMs();packet.ecu.online=false;},'fresh explicit CAN loss is not overridden by periodic old success');
rejected((row,packet)=>{packet.received_at_ms=serverTimeMs();packet.direct_demo.can_fresh=false;},'fresh explicit runtime-stale packet remains unavailable');
rejected((row,packet)=>{packet.ecu.online=false;},'retained offline fast frame blocks older periodic success uploaded later');
rejected((row,packet)=>{packet.direct_demo.can_fresh=false;packet.direct_demo.state='can_stale';},'retained CAN-stale fast frame cannot be revived by HTTP receipt freshness');
state.data={latest:{...durable(),ecu_speed_kph:0}};directRealtime.packet=fast();renderDirectRealtimeReadings();
assert.equal(node('speed').textContent,'0','fresh zero is a valid speed, not a missing value');
assert.equal(requests,0);
console.log('PASS speed freshness: per-packet transit, stable low-RTT calibration, 30s quality refresh, monotonic expiry, same 1.5s fresh periodic fallback and explicit CAN/device/session/pass/boot isolation.');
