// Deterministic UI transport tests; no running user server, DB or hardware.
// Exercise the shipped functions with delayed responses and a manual clock.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../WebDashboard_Online/public/dashboard.js',import.meta.url),'utf8');
const routes=source.slice(source.indexOf('  function directRouteScope('),source.indexOf('  async function postRoute('));
const polling=source.slice(source.indexOf('  async function poll(){'),source.indexOf('  async function loadDevices('));
// Include the actual lightweight snapshot/clock dependencies used by poll().
// Keep all route cancellation/render assertions unchanged.
const numeric=source.slice(source.indexOf('  function number('),source.indexOf('  function fmt('));
const timeParser=source.slice(source.indexOf('  function timeMs('),source.indexOf('  function hasCoords('));
const clock=source.slice(source.indexOf('  function serverTimeMs('),source.indexOf('  function telemetryFresh('));
const snapshots=source.slice(source.indexOf('  function newestSnapshot('),source.indexOf('  function sdPresentation('));
const transport=source.slice(source.indexOf('  const serverTransport='),source.indexOf('  const AUTO_DEMO_DEVICE_ID='));
const flush=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
function harness(remote=false){
  const state={mode:'live',selectedDevice:'real-direct-demo',sourceGeneration:1,requestInFlight:false,pollPending:false,
    routeRequestInFlight:false,routes:[],selectedRouteId:null,routePoints:[],routeEvents:[],routeStats:null,
    displayedRoute:null,activeRoute:null,modeLocked:true};
  const session=(pass=1,lifecycle='running')=>({session_id:'s',virtual_device_id:'real-direct-demo',pass_index:pass,state:lifecycle});
  const directView={session:session()},routeRequests={list:null,detail:null},requests=[],renders=[],feedback=[],timers=new Map(),timeouts=[];
  let timerId=0,sequence=0;
  const globals={state,directView,routeRequests,Number,String,console,AbortController,queueMicrotask,window:{},performance,
    window:{TelematicsAccess:{remote}},performance:{now:Date.now},rememberServerClock(){},newestSnapshot:incoming=>incoming,
    DASHBOARD_TIMEOUT_MS:1500,ROUTE_TIMEOUT_MS:2000,
    setTimeout:(fn,ms)=>{timeouts.push(ms);timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
    currentDeviceId:()=>state.selectedDevice,renderRouteControls(){},stopReplay(){},
    selectedCompletedRoute:()=>state.routes.find(r=>r.id===state.selectedRouteId&&r.status==='completed')||null,
    setRouteFeedback:message=>feedback.push(message),fillConfig(){},
    render:data=>{state.data=data;renders.push(data.latest.sequence);},updateMap(){},
    loadV10Data(){},searchEventCenter(){},updateModeButton(){},renderConnection(){},
    fetch:(url,options)=>{
      if(url.startsWith('/api/dashboard'))return Promise.resolve({ok:true,json:async()=>({ok:true,device_id:state.selectedDevice,
        latest:{device_id:state.selectedDevice,sequence:++sequence},device_config:{}})});
      let resolve;
      const promise=new Promise(r=>{resolve=r;});
      // Deliberately ignores abort to test the separate cancellation race.
      requests.push({url,options,answer:data=>resolve({ok:true,json:async()=>({ok:true,...data})})});return promise;
    },api:{}};
  vm.runInNewContext(transport+numeric+timeParser+clock+snapshots+routes+polling+';Object.assign(api,{poll,loadRoutes,fetchRouteDetail,cancelRouteRequests});',globals);
  return {state,directView,session,routeRequests,requests,renders,feedback,timers,timeouts,api:globals.api,
    expire:async()=>{const batch=[...timers.values()];timers.clear();for(const fn of batch)fn();await flush();}};
}
{
  const remote=harness(true);await remote.api.poll();
  assert(remote.timeouts.includes(6000),'Internet dashboard allows a bounded 6-second request');
  assert(remote.timeouts.includes(10000),'Internet route history allows a bounded 10-second request');
  remote.api.cancelRouteRequests();await flush();
  const local=harness();await local.api.poll();
  assert(local.timeouts.includes(1500));assert(local.timeouts.includes(2000),'LAN timeouts retain the responsive existing policy');
  local.api.cancelRouteRequests();await flush();
}
{
  const h=harness();
  await h.api.poll();
  assert.deepEqual(h.renders,[1],'fresh dashboard renders before route response');
  assert.equal(h.state.requestInFlight,false,'route history never owns dashboard poll lock');
  assert.equal(h.state.routeRequestInFlight,true);
  assert(h.requests[0].options.signal,'list fetch receives cancellation signal');
  await h.api.poll();
  assert.deepEqual(h.renders,[1,2],'new ECU/sensor data paints while history is stalled');
  assert.equal(h.requests.length,1,'one current-scope history request only');
  await h.expire();
  assert.equal(h.requests[0].options.signal.aborted,true);
  assert.equal(h.state.routeRequestInFlight,false,'lost request releases route lock by timeout');
  assert.equal(h.state.serverOnline,true,'route timeout does not mark healthy dashboard server offline');
  h.requests[0].answer({routes:[{id:999,status:'active'}],active_route:{id:999,status:'active'}});await flush();
  assert.equal(h.state.routes.length,0,'post-timeout body cannot mutate route state');
  await h.api.poll();assert.equal(h.requests.length,2,'next refresh can retry after timeout');
  h.api.cancelRouteRequests();await flush();
}
{
  // Start pass 1 -> repeat pass 2 while list is unresolved. The abandoned
  // pass must not release the new pass's request ownership or paint its data.
  const h=harness(),old=h.api.loadRoutes();
  h.directView.session=h.session(2);
  const current=h.api.loadRoutes();await flush();
  assert.equal(h.requests[0].options.signal.aborted,true);
  assert.equal(h.state.routeRequestInFlight,true,'old finally does not release new list lock');
  assert.equal(h.requests.length,2);
  h.requests[0].answer({routes:[{id:1,status:'active'}],active_route:{id:1,status:'active'}});await flush();
  assert.equal(h.state.routes.length,0);
  h.requests[1].answer({routes:[{id:2,status:'active'}],active_route:{id:2,status:'active'}});await flush();
  assert.match(h.requests[2].url,/\/api\/routes\/2\?/);
  assert(h.requests[2].options.signal,'detail fetch receives cancellation signal');
  // Stop before old detail finishes. Scope comparison protects even before
  // the view/source-switch cancellation hook has run.
  h.directView.session=h.session(2,'stopped');
  h.requests[2].answer({route:{id:2,status:'active'},points:[{lat:1,lon:2}]});await flush();
  assert.equal(await old,false);assert.equal(await current,false);
  assert.equal(h.state.displayedRoute,null,'late pre-stop detail cannot reopen route');
  assert.equal(h.state.routePoints.length,0);
  assert.equal(h.state.routeRequestInFlight,false);
}
{
  const h=harness(),pending=h.api.loadRoutes();
  h.state.selectedDevice='other-gateway';h.state.sourceGeneration++;
  h.api.cancelRouteRequests();await flush();
  h.requests[0].answer({routes:[{id:77,status:'completed'}],active_route:null});await flush();
  assert.equal(await pending,false);
  assert.equal(h.state.routes.length,0,'late old source cannot replace current route list');
  assert.equal(h.state.displayedRoute,null);
  assert.equal(h.feedback.length,0,'cancelled old source does not display stale failure feedback');
  const next=h.api.loadRoutes();h.requests[1].answer({routes:[],active_route:null});await flush();
  assert.equal(await next,true,'new source can load immediately');
}
{
  const h=harness(),old=h.api.fetchRouteDetail(77,true),current=h.api.fetchRouteDetail(88,true);
  h.requests[0].answer({route:{id:77,status:'completed'},points:[{lat:77}]});await flush();
  assert.equal(await old,false,'superseded route selection is rejected');
  assert.equal(h.state.displayedRoute,null);
  h.requests[1].answer({route:{id:88,status:'completed'},points:[{lat:88}]});await flush();
  assert.equal(await current,true);assert.equal(h.state.displayedRoute.id,88);
  const stalled=h.api.fetchRouteDetail(99,true).catch(error=>error.message);
  await h.expire();assert.equal(await stalled,'route_request_aborted');
  assert.equal(h.state.displayedRoute.id,88,'detail timeout retains prior successful route');
  assert.equal(h.routeRequests.detail,null);
}
assert.match(source,/async function selectDeviceSource\(deviceValue\)\{\s+cancelRouteRequests\(\)/);
assert.match(source,/directRouteScope\(directView\.session\)!==directRouteScope\(preview\?null:session\)\)cancelRouteRequests\(\)/);
assert.match(source,/function clearDirectMapView\(\)\{\s+if\(!directView\.rotated\)return;\s+cancelRouteRequests\(\)/);
console.log('PASS route UI requests: live render independent of history, bounded list/detail cancellation, no dead poll lock, late source/pass/stop responses fenced, superseded selection ownership, and timeout recovery. Deterministic transport adapters only.');
