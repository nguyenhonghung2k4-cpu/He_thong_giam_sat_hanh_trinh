import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { listDemoPresets } from '../WebDashboard_Online/direct-demo-presets.mjs';

const file = name => readFileSync(new URL('../WebDashboard_Online/public/' + name, import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(file('direct-demo-geometry.js'), { globalThis: window });
const nodes = new Map(), requests = [], previews = [];
const node = id => {
  if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', disabled: false, options: [], classList: { toggle() {}, add() {}, remove() {} },
    replaceChildren() { this.options = []; this.value = ''; }, append(option) { this.options.push(option); } });
  return nodes.get(id);
};
let roadFailure = false, roadEmpty = false;
const roads = listDemoPresets(), roadId = roads[0].id;
window.telematicsDashboard = { currentDeviceId: () => '', getDirectRealtime: () => null, refreshDirectRealtime() {},
  getServerTimeMs: () => 100000, previewDirectDemoRoad: route => { previews.push(route);return true; },clearDirectDemoView() {} };
window.dispatchEvent = () => {};
const source = file('direct-demo.js');
vm.runInNewContext(source.slice(0,source.indexOf('  $("direct-roads").addEventListener')) + '\nwindow.api={state,loadRoads,render,start,previewRoad,gatewayChanged,renderMotion};})();', {
  window, document: { getElementById: node, body: { classList: { toggle() {} } }, createElement: () => ({ value: '', textContent: '' }) },
  AbortSignal, CustomEvent: class {}, console,
  fetch: async (url,options) => {
    requests.push({url,options});
    if (url === '/api/direct-demo/roads') {
      if (roadFailure) throw new Error('preview network interruption');
      return {ok:true,json:async()=>({ok:true,roads:roadEmpty?[]:roads,source:'osm_road',synthetic:false,requires_gps:false,requires_network:false})};
    }
    if (url === '/api/direct-demo/start') return {ok:true,json:async()=>({ok:true,session:{session_id:'new',device_id:'physical',virtual_device_id:'physical-direct-demo',state:'starting',revision:1,pass_index:0}})};
    throw new Error(`Unexpected request ${url}`);
  },
});
const {state,loadRoads,render,start,previewRoad,gatewayChanged,renderMotion} = window.api;
state.available = true;
assert.equal(node('direct-device').value,'');
const loading=loadRoads();
assert.equal(node('direct-road-note').hidden,false,'loading remains visible');
assert.match(node('direct-road-note').textContent,/Đang tải tuyến demo/);
await loading;
assert.equal(requests[0].url,'/api/direct-demo/roads','catalog loads without a gateway/GPS query');
assert.equal(state.roads.length,6);assert.equal(node('direct-road').options.length,7);
assert.equal(node('direct-road').disabled,false,'prepared dropdown ready without physical device');
assert.equal(node('direct-roads').disabled,false,'reload does not require GPS or gateway');
assert.equal(node('direct-start').disabled,true,'a prepared route alone cannot start without a physical gateway');
assert.equal(node('direct-road-note').textContent,'','successful catalog does not reinsert the removed explanation');
assert.equal(node('direct-road-note').hidden,true,'successful catalog leaves no explanatory paragraph');
node('direct-road').value=roadId;previewRoad();assert.equal(previews[0].id,roadId,'route preview works without a GPS fix');
const catalog=state.roads;node('direct-device').value='other-physical';gatewayChanged();
assert.equal(state.roads,catalog,'changing gateway does not discard independent prepared catalog');
await loadRoads();assert.equal(node('direct-road').value,roadId,'reload preserves selected cached real route');const reloadedCatalog=state.roads;
render();assert.equal(node('direct-start').disabled,false);
await start();
const posted=requests.find(r=>r.url==='/api/direct-demo/start');assert(posted);
assert.equal(JSON.parse(posted.options.body).road_id,roadId);
assert.equal(state.session.state,'starting');assert.equal(state.view,'','route preview/start request does not pretend ESP acknowledged');
state.session=null;node('direct-device').value='';const before=requests.length;await start();assert.equal(requests.length,before,'missing gateway is not submitted');
node('direct-device').value='physical';node('direct-road').value='unlisted';await start();assert.equal(requests.length,before,'unknown route is not submitted');
roadFailure=true;await loadRoads();assert.equal(state.roads,reloadedCatalog);assert.match(node('direct-road-note').textContent,/máy chủ/);assert.equal(node('direct-road-note').hidden,false,'load errors remain visible');assert.doesNotMatch(node('direct-road-note').textContent,/GPS thật mới|vị trí GPS khác|tìm đoạn đường OSM/);
roadFailure=false;await loadRoads();assert.equal(node('direct-road-note').hidden,true,'successful retry clears the previous error');assert.equal(node('direct-road-note').textContent,'');
roadEmpty=true;await loadRoads();assert.equal(node('direct-road-note').hidden,false,'empty catalog remains actionable');assert.match(node('direct-road-note').textContent,/Chưa có tuyến hợp lệ/);roadEmpty=false;

// A phone may have an arbitrary wall clock; motion age uses the server anchor.
window.telematicsDashboard.getDirectRealtime=()=>({received_at_ms:99900,direct_demo:{distance_m:3,input_speed_kph:10,speed_kph:20,route_length_m:400}});
renderMotion();assert.match(node('direct-realtime-status').textContent,/100 ms/);
window.telematicsDashboard.getServerTimeMs=()=>102000;renderMotion();assert.match(node('direct-realtime-status').textContent,/đã cũ/);

assert.match(source,/poll\(\); loadDevices\(\); loadRoads\(\)/,'catalog auto-loads at boot');
assert(!source.includes('/api/demo/tinyml'),'direct demo never injects acceleration');
const html=file('index.html'),section=html.slice(html.indexOf('<article id="direct-demo"'),html.indexOf('<article id="demo-tinyml-panel"'));
assert.match(section,/Tải lại tuyến demo/);assert.match(section,/<p id="direct-road-note" class="direct-demo-note" hidden><\/p>/);assert.match(section,/ADXL345 và TinyML vẫn dùng rung động thật/);
assert.match(section,/Các tuyến có chiều dài từ 400 m đến 2 km/);
assert.match(section,/openstreetmap.org\/copyright/);
assert.match(html,/dashboard\.js\?v=v1161-ui-speed-20261116b/);assert.match(html,/direct-demo\.js\?v=v1161-ui-speed-20261116b/);
assert.match(html,/<span id="road-source">ADXL345 · ESP32-S3<\/span>/);
assert.match(html,/<span id="road-updated">Chờ AI<\/span>/);
assert.match(html,/<p id="model-note" class="model-note" hidden><\/p>/);
assert.match(html,/<p id="road-event-status" class="model-note" aria-live="polite" hidden><\/p>/);
assert.match(html,/<p class="road-current-intro" hidden><\/p>/);
assert(!section.includes('Tìm đường gần GPS'));assert(!section.includes('3 km'));assert(!section.includes('GPS thật mới'));
console.log('PASS real-road direct-demo UI: KMA catalog without GPS/device, cached road dropdown/reload/preview, gateway change retention, physical gateway/start guards, ACK honesty, no acceleration injection and server-clock motion age.');
