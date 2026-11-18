// Execute production functions with a small DOM/Leaflet adapter. HTTP ACKs
// here are transport fixtures; this test does not simulate TinyML accuracy.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const nodes=new Map();
function node(id){if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',classList:{toggle(){}},disabled:false});return nodes.get(id);}
const document={getElementById:node,createElement:()=>({style:{},append(){},textContent:''}),visibilityState:'visible'};
function layer(pos,options){
  const classes=new Map(),text={textContent:''},pin={classList:{toggle(key,value){classes.set(key,value);}}};
  return {pos:[...pos],options:{...options},classes,text,setLatLng(next){this.pos=[...next];return this;},setRadius(radius){this.options.radius=radius;return this;},setStyle(style){Object.assign(this.options,style);return this;},addTo(){return this;},getElement(){return {querySelector:selector=>selector==='.hazard-pin'?pin:text};},getPopup(){return this.popup;},bindPopup(popup){this.popup=popup;return this;},setPopupContent(popup){this.popup=popup;return this;}};
}
const window={L:{circle:layer,marker:layer,divIcon:x=>x},TelematicsRouteGeometry:{splitRouteSegments:()=>[]}};
let now=1000,requests=[],responder=async()=>({ok:true,status:200,json:async()=>({ok:true})});
const fetch=(path,options={})=>{requests.push({path,options,body:options.body?JSON.parse(options.body):null});return responder(path,options);};
const source=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'..','WebDashboard_Online','public','dashboard.js'),'utf8');
const prefix=source.slice(0,source.indexOf('  const SIDEBAR_PREF_KEY='));
const context={window,document,fetch,performance:{now:()=>now},AbortSignal,Intl,Date,console,setTimeout,clearTimeout,cancelAnimationFrame(){},requestAnimationFrame(){},URL,globalThis:{crypto:{randomUUID:()=> 'ui-test-client'}}};
vm.runInNewContext(prefix+'\nwindow.test={state,vehicleMotion,fillConfig,reconcileHazards,drawVehiclePosition,loadCachedConfig,saveConfigToDevice};})();',context);
const api=window.test,{state}=api,AUTO='blackbox-esp32s3-auto-demo';
const hazard={lat:20,lon:105,confidence:.95};
const outside=[20.00018,105],inside=[20.00004,105];
state.selectedDevice=AUTO;state.map={};state.layers={hazards:{removeLayer(){}},vehicle:{}};
state.displayedRoute={status:'active'};state.data={latest:{device_id:AUTO,boot_id:'session-1',lat:inside[0],lon:inside[1],ingested_at:Date.now()},potholes:[hazard],speed_bumps:[]};
const config=(radius,pending=null)=>({device_id:'real-gateway',target_device_id:'real-gateway',view_device_id:AUTO,confirmed:true,source:'device',geofence_warning_m:radius,geofence_rearm_m:radius+10,overspeed_warning_kph:120,overspeed_clear_kph:115,pothole_confidence:.8,speed_bump_confidence:.8,pending_command:pending});
api.fillConfig(config(30));api.reconcileHazards(state.data,outside);
let record=[...state.hazardLayers.values()][0];
assert.equal(record.rangeCircle.options.radius,30);
assert.equal(record.marker.classes.get('in-range'),true);
assert.match(node('config-target-note').textContent,/real-gateway/);

node('cfg-geo-warn').value=10;state.configDirty=true;
api.fillConfig(config(30,{id:7,status:'pending'}));
assert.equal(record.rangeCircle.options.radius,30,'Pending request changed effective circle before ACK');
assert.equal(node('cfg-geo-warn').value,10,'Telemetry refresh erased unsaved user input');
assert.match(node('config-status').textContent,/Chờ ESP xác nhận/);
api.fillConfig(config(10),true);api.drawVehiclePosition(outside);
assert.equal(record.rangeCircle.options.radius,10);
assert.equal(record.marker.classes.get('in-range'),false,'Highlight used newer server point instead of painted point');
assert.match(record.marker.text.textContent,/vòng 10 m/);
await new Promise(setImmediate);
let reports=requests.filter(x=>x.path==='/api/demo/display-position');
assert.equal(reports.length,1);assert.deepEqual(reports[0].body.position,{lat:outside[0],lon:outside[1]});
assert.equal(reports[0].body.session_id,'session-1');assert.equal(reports[0].body.client_id,'ui-test-client');
now+=100;api.drawVehiclePosition(inside);await new Promise(setImmediate);
assert.equal(record.marker.classes.get('in-range'),true);
assert.equal(requests.filter(x=>x.path==='/api/demo/display-position').length,1,'Display reports exceeded 5 Hz');
now+=101;api.drawVehiclePosition(inside);await new Promise(setImmediate);
reports=requests.filter(x=>x.path==='/api/demo/display-position');assert.equal(reports.length,2);assert.ok(reports[1].body.sequence>reports[0].body.sequence);
document.visibilityState='hidden';now+=250;api.drawVehiclePosition(inside);await new Promise(setImmediate);assert.equal(requests.filter(x=>x.path==='/api/demo/display-position').length,2,'Hidden browser competed for visible-page lease');document.visibilityState='visible';

// Saving while AUTO is selected targets the alias, and only the confirmed
// server response changes the ring. There is no local simulated config store.
node('cfg-geo-warn').value=30;node('cfg-geo-rearm').value=40;state.configDirty=true;
let saved=null,ack=false;
responder=async(path,options={})=>{
  let body={ok:true};
  if(path==='/api/device-config'&&options.method==='POST'){
    saved=JSON.parse(options.body);assert.equal(state.deviceConfig.geofence_warning_m,10);assert.equal(record.rangeCircle.options.radius,10);
    body.command={id:9};
  }else if(path==='/api/device-commands/9'){ack=true;body.command={status:'done',result:{config:config(30)}};}
  else if(path.startsWith('/api/device-config?'))body.config=config(ack?30:10);
  return {ok:true,status:200,json:async()=>body};
};
await api.saveConfigToDevice();
assert.equal(saved.device_id,AUTO);assert.equal(saved.geofence_warning_m,30);
assert.equal(state.deviceConfig.geofence_warning_m,30);assert.equal(record.rangeCircle.options.radius,30);
assert.equal(state.configDirty,false);assert.match(node('config-status').textContent,/ESP đã xác nhận/);

// A delayed reply for the previous map source cannot replace a newly selected
// device's settings.
let release;responder=()=>new Promise(resolve=>{release=resolve;});
const pending=api.loadCachedConfig();state.sourceGeneration++;state.selectedDevice='other-real-gateway';
release({ok:true,json:async()=>({ok:true,config:config(10)})});await pending;
assert.equal(state.deviceConfig.geofence_warning_m,30,'Old source response changed config after device switch');
console.log('PASS UI V11.4.1: canonical Gateway radius 10/30 m, pending/ACK isolation, unsaved inputs, rendered-position distance and reports, 5 Hz/hidden-page guards, AUTO config save, stale source response.');
