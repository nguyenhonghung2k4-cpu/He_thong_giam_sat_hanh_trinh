import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import './direct_session_order_test.mjs';
const file=name=>readFileSync(new URL('../WebDashboard_Online/public/'+name,import.meta.url),'utf8');
const window={};vm.runInNewContext(file('direct-demo-geometry.js'),{globalThis:window});
const g=window.TelematicsDirectGeometry;
const coords=[[20.9,105.82],[20.9003,105.8202],[20.9004,105.821]];
const route=g.route(coords);assert(route);assert.equal(g.route([[0,0]]),null);assert.equal(g.route([[NaN,0],[0,1]]),null);
const part=g.path(route,5,route.total-5);assert.equal(part.length,3);assert.deepEqual([...part[1]],coords[1]);
for(const points of [coords,[...coords].reverse(),[[20,105],[20.001,105]],[[20.001,105],[20,105]]]){
  const r=g.route(points),v=g.view(r,1000,600),a=points[0],b=points.at(-1),rad=Math.PI/180;
  const proj=p=>[(p[1]+180)/360*256,(1-Math.log(Math.tan(Math.PI/4+p[0]*rad/2))/Math.PI)/2*256];
  const p=proj(a),q=proj(b),dx=q[0]-p[0],dy=q[1]-p[1],angle=v.angle*rad;
  assert(Math.abs(dx*Math.sin(angle)+dy*Math.cos(angle))<1e-8,'rotated endpoints horizontal');
  assert(dx*Math.cos(angle)-dy*Math.sin(angle)>0,'travel must be left to right');
}
let now=0,frames=new Map(),frameId=0,paint=[];
const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',value:'',style:{setProperty(){},removeProperty(){}},classList:{toggle(){},add(){},remove(){}},setAttribute(){},append(){}});return nodes.get(id);};
const source=file('dashboard.js'),prefix=source.slice(0,source.indexOf('  const SIDEBAR_PREF_KEY='));
vm.runInNewContext(prefix+`\ndrawVehiclePosition=p=>window.paint.push([...p]);window.api={state,directView,vehicleMotion,animateDirectVehicle,stopVehicleMotion};})();`,{
  window,document:{getElementById:node},performance:{now:()=>now},Intl,Date,console,setTimeout,clearTimeout,
  requestAnimationFrame:callback=>{frames.set(++frameId,callback);return frameId;},cancelAnimationFrame:id=>frames.delete(id),globalThis:{crypto:{randomUUID:()=> 'ui-test'}}
});
window.paint=paint;const {state,directView,vehicleMotion,animateDirectVehicle}=window.api;
state.data={latest:{device_id:'real-direct-demo'}};directView.route=route;directView.session={session_id:'s'};
const row=(seq,distance,time,pass=1)=>({device_id:'real-direct-demo',sequence:seq,ingested_at:time,direct_demo:{session_id:'s',pass_index:pass,distance_m:distance,state:'running'}});
const frame=dt=>{now+=dt;const batch=[...frames.values()];frames.clear();for(const callback of batch)callback(now);};
animateDirectVehicle(row(1,0,1000),coords[0]);assert.deepEqual([...paint.at(-1)],coords[0]);
animateDirectVehicle(row(2,route.total,2000),coords.at(-1));assert.equal(frames.size,1);
frame(500);assert.deepEqual([...paint.at(-1)],[...g.at(route,route.total/2)]);assert(vehicleMotion.directDistance<route.total);
const sameKey=vehicleMotion.key;animateDirectVehicle(row(2,route.total,2000),coords.at(-1));assert.equal(vehicleMotion.key,sameKey);assert.equal(frames.size,1,'same telemetry must not restart interpolation');
frame(500);assert.deepEqual([...paint.at(-1)],coords.at(-1));assert.equal(frames.size,0);
const held=[...paint.at(-1)];frame(10000);assert.deepEqual([...paint.at(-1)],held,'no extrapolation when server silent');
animateDirectVehicle(row(3,0,3000,2),coords[0]);assert.deepEqual([...paint.at(-1)],coords[0]);assert.equal(frames.size,0,'repeat must reset without drawing a cross-map teleport');
assert.match(file('v11.js'),/addEventListener\("telematics:source-changed", connectSse\)/);
assert.match(file('direct-demo.js'),/geometry\.confirmed\(s\.state\)/);
assert(!file('direct-demo.js').includes('/api/demo/tinyml'),'direct mode never submits acceleration');
assert.match(file('dashboard.css'),/direct-demo-session #demo-tinyml-panel\{display:none\}/);
assert.match(file('trip-report.js'),/Tọa độ mô phỏng – AI thực/);
console.log('PASS direct UI: actual geometry/interpolation functions, both travel orientations, bends preserved, smooth confirmed progress, no extrapolation, repeat reset, direct source SSE wiring and provenance. DOM adapter; browser QA separate.');
