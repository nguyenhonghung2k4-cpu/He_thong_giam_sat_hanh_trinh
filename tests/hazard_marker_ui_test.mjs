// Regression for a confirmed TinyML point disappearing after a slow HTTP query.
// Simulated browser/ESP transport only; no claim about trained-model accuracy.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const file=name=>readFileSync(new URL('../WebDashboard_Online/public/'+name,import.meta.url),'utf8');
let now=100000;
class TestDate extends Date {static now(){return now;}}
const nodes=new Map(),node=id=>{
  if(!nodes.has(id))nodes.set(id,{textContent:'',className:'',value:'',hidden:false,style:{setProperty(){},removeProperty(){}},classList:{add(){},remove(){},toggle(){}},append(){}});
  return nodes.get(id);
};
const layer={items:new Set(),removeLayer(value){this.items.delete(value);}};
const item=()=>({addTo(target){target.items.add(this);return this;},setLatLng(){return this;},setRadius(){},setStyle(){},getElement(){return null;},getPopup(){return null;},bindPopup(){return this;},setPopupContent(){}});
const window={L:{circle:item,marker:item,divIcon:value=>value}};
vm.runInNewContext(file('road-state.js'),{globalThis:window});
const code=file('dashboard.js'),prefix=code.slice(0,code.indexOf('  const SIDEBAR_PREF_KEY='));
vm.runInNewContext(prefix+`
renderReadings=()=>{};renderEvents=()=>{};drawChart=()=>{};
updateMap=data=>reconcileHazards(data);
window.test={state,directView,acceptRealtimeEvent,newestSnapshot,render,renderRoad,recordServerTransport,mapTileUrl};})();`,{
  window,document:{getElementById:node,createElement:()=>({style:{},append(){}})},Date:TestDate,Intl,console,setTimeout,clearTimeout,
  globalThis:{crypto:{randomUUID:()=> 'marker-test'}}
});
const {state,directView,acceptRealtimeEvent,newestSnapshot,render,renderRoad,recordServerTransport,mapTileUrl}=window.test;
state.map={};state.layers={hazards:layer};state.selectedDevice='real-direct-demo';
directView.session={session_id:'session',virtual_device_id:'real-direct-demo'};
state.liveData={device_id:'real-direct-demo',latest:{device_id:'real-direct-demo',ingested_at:now},events:[],potholes:[],speed_bumps:[]};
render(state.liveData);
assert.equal(state.hazardLayers.size,0,'raw telemetry alone creates no point');
const event={id:1,event_uid:'bump-1',device_id:'real-direct-demo',boot_id:'session',name:'speed_bump_detected',lat:20.98,lon:105.795,gps_attached:1,new_map_point:1,confidence:.98,ingested_at:100100};
assert.equal(acceptRealtimeEvent({kind:'event',device_id:'real-direct-demo',event}),true);
assert.equal(state.hazardLayers.size,1,'confirmed event paints its marker immediately');
assert.equal(layer.items.size,2,'one warning ring and one marker');
const oldQuery={device_id:'real-direct-demo',latest:{device_id:'real-direct-demo',ingested_at:99900},events:[],potholes:[],speed_bumps:[],server_now:100000};
const held=newestSnapshot(oldQuery,state.liveData);render(held);
assert.equal(held.speed_bumps.length,1,'late pre-event HTTP query cannot erase newer confirmed marker');
assert.equal(state.hazardLayers.size,1);
assert.equal(acceptRealtimeEvent({event:{...event,event_uid:'wrong-device',device_id:'other'}}),false);
assert.equal(acceptRealtimeEvent({event:{...event,event_uid:'old-session',boot_id:'prior-session'}}),false);
acceptRealtimeEvent({event:{...event,event_uid:'no-position',gps_attached:0,lat:21,lon:106}});
assert.equal(state.hazardLayers.size,1,'unattached location never creates a marker');
acceptRealtimeEvent({event:{...event,event_uid:'invalid-position',lat:null,lon:null}});
assert.equal(state.hazardLayers.size,1);
const currentQuery={...oldQuery,server_now:100500};
const deleted=newestSnapshot(currentQuery,state.liveData);render(deleted);
assert.equal(state.hazardLayers.size,0,'new authoritative query may remove deleted points');
const row={device_id:'real-direct-demo',ingested_at:100000,road_valid:1,road_label:'go_giam_toc',confidence:.98,ai_ready:1,adxl_healthy:1};
const meta={valid:true,source:'adxl345',label:'go_giam_toc',confidence:.98,age_ms:0,event:{state:'pending_confirmation',candidate_windows:1,required_windows:2}};
renderRoad(row,{road_current:meta,server_now:100000,_received_at:now});
assert.equal(node('road-event-status').textContent,'Đang xác nhận (1/2)');
assert.equal(node('road-event-status').hidden,false);
assert.equal(state.hazardLayers.size,0,'raw pending class remains separate from confirmed marker');
renderRoad(row,{road_current:{...meta,event:{state:'confirmed',last_event_reason:'no_position'}},server_now:100000,_received_at:now});
assert.equal(node('road-event-status').textContent,'Chưa có vị trí');
renderRoad(row,{events:[{event_uid:'old-pot'}],road_current:{...meta,event:{state:'pending_confirmation',candidate_windows:1,required_windows:2,last_event_id:'old-pot',last_event_label:'o_ga',last_event_position_attached:true}},server_now:100000,_received_at:now});
assert.equal(node('road-event-status').textContent,'Đang xác nhận (1/2)','old other-class event cannot override current short status');
renderRoad(row,{events:[{event_uid:'new-bump'}],road_current:{...meta,event:{state:'confirmed',last_event_id:'new-bump',last_event_label:'go_giam_toc',last_event_position_attached:true}},server_now:100000,_received_at:now});
assert.equal(node('road-event-status').textContent,'Đã ghi điểm','matching confirmed event keeps useful result visible');
assert.equal(recordServerTransport(true),true);now+=100;
assert.equal(recordServerTransport(false),true,'one failed query does not erase recent server success');
now+=8000;assert.equal(recordServerTransport(false),false,'actual sustained loss is not hidden');
assert.equal(mapTileUrl(),'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
window.TelematicsAccess={remote:true};assert.equal(mapTileUrl(),'/map-tiles/{z}/{x}/{y}.png','public tiles bypass PC relay');
const html=file('index.html');
assert(html.includes('/vendor/leaflet/leaflet.js'));assert(!html.includes('src="https://unpkg.com/leaflet'));
assert(html.includes('id="map-retry"'));assert(html.includes('id="road-event-status"'));
assert(!code.includes('TRUNG TÂM ĐIỀU HÀNH · INTERNET'));
console.log('PASS marker UI: confirmed-only immediate pin/ring, no loss after old history, device/session/position fencing, authoritative deletion, admission diagnostics, bounded health hysteresis and public tile path.');
