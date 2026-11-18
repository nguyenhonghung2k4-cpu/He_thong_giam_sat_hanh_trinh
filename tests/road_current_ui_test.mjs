import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const file = name => readFileSync(new URL('../WebDashboard_Online/public/' + name, import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(file('road-state.js'), { globalThis: window });
const { resolve } = window.TelematicsRoadState;
const row = { device_id: 'real-gateway', ingested_at: 100000, road_valid: 1, road_label: 'o_ga', confidence: .98, flat_confidence: .01, speed_bump_confidence: .01, pothole_confidence: .98, ai_ready: 1, adxl_healthy: 1, x_g: .1, y_g: .2, z_g: 1, inference_ms: 6 };
const meta = { valid: true, source: 'adxl345', reason: 'fresh', label: 'o_ga', confidence: .98, age_ms: 500, window_ms: 2000, scores: { duong_bang_phang: .01, go_giam_toc: .01, o_ga: .98 } };
const context = { now: 200000, receivedAt: 200000, serverNow: 100500 };
assert.equal(resolve(row, meta, context).valid, true, 'server timestamp, not browser clock, defines age');
assert.equal(resolve(row, meta, { ...context, now: 202499 }).valid, true);
assert.equal(resolve(row,meta,{...context,transportDelay:2600}).valid,false,'network transit cannot make an expired AI result look new');
const expired = resolve(row, meta, { ...context, now: 202500 });
assert.equal(expired.valid, false);assert.equal(expired.label, 'unknown');assert.equal(expired.confidence, null);assert.equal(expired.x_g, null);assert.equal(expired.scores.o_ga, null);
for (const reason of ['gateway_offline', 'ai_not_ready', 'ai_stale', 'missing']) assert.equal(resolve(row, { ...meta, valid: false, reason }, context).label, 'unknown');
for (const label of ['unknown', 'bogus', '']) assert.equal(resolve(row, { ...meta, label }, context).valid, false, 'unknown labels never reuse a previous hazard');
for (const confidence of [-1, 2, null, 'bad']) assert.equal(resolve({ ...row, confidence }, { ...meta, confidence }, context).valid, false);
assert.equal(resolve(row, { ...meta, age_ms: null }, context).valid, false);
assert.equal(resolve(row, { ...meta, source: 'unknown' }, context).valid, false);
for (const source of ['auto_demo', 'sample_demo']) {
  const demo = resolve(row, { ...meta, source }, context);assert(demo.demo);assert.equal(demo.valid, false);assert.equal(demo.label, 'unknown');
}
assert.equal(resolve({ ...row, device_id: 'blackbox-esp32s3-auto-demo' }, meta, context).valid, false);
assert.equal(resolve({ ...row, device_id: 'real-gateway-direct-demo' }, meta, context).valid, true, 'direct demo uses real ADXL data');
assert.equal(resolve(row, null, { now: 100500, receivedAt: 100500 }).valid, true, 'legacy response may use fresh road_valid');
assert.equal(resolve({ ...row, is_resend: 1 }, null, { now: 100500 }).valid, false, 'backlog receipt is not current sensing');
assert.equal(resolve({ ...row, adxl_healthy: 0 }, null, { now: 100500 }).valid, false);
assert.equal(resolve({ ...row, ai_ready: 0 }, null, { now: 100500 }).valid, false);

let now = 200000, historyCalls = 0, mapPaints = 0;
class TestDate extends Date { static now() { return now; } }
const nodes = new Map();
const node = id => {
  if (!nodes.has(id)) nodes.set(id, { textContent: '', className: '', style: { width: '', setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {} });
  return nodes.get(id);
};
const source = file('dashboard.js'), prefix = source.slice(0, source.indexOf('  const SIDEBAR_PREF_KEY='));
vm.runInNewContext(prefix + `
renderStatuses=()=>{};renderHealth=()=>{};renderConnection=()=>{};renderDirectRealtimeReadings=()=>{};renderRouteControls=()=>window.historyCall();
updateMap=()=>window.historyCall();drawChart=()=>window.historyCall();renderEvents=()=>window.historyCall();
drawVehiclePosition=()=>window.mapPaint();
window.test={state,renderRoad,renderReadings,applyLiveSnapshot,newestSnapshot,realtimeFresh,rememberServerClock};})();`, {
  window, document: { getElementById: node }, Date: TestDate, Intl, console, setTimeout, clearTimeout,
  fetch: () => { historyCalls++; throw new Error('Light snapshot must not fetch'); },
  globalThis: { crypto: { randomUUID: () => 'road-ui' } },
});
window.historyCall = () => historyCalls++;window.mapPaint = () => mapPaints++;
const { state, renderRoad, renderReadings, applyLiveSnapshot, newestSnapshot, realtimeFresh,rememberServerClock } = window.test;
state.selectedDevice = 'real-gateway';state.vehicleCore = {};
const snapshot = { ok: true, device_id: 'real-gateway', latest: { ...row, ecu_online: 1, ecu_speed_kph: 42, temperature_c: 29, lat: 20, lon: 105, location_valid: 1 }, server_now: 100500, road_current: meta };
assert.equal(applyLiveSnapshot(snapshot), true);
assert.equal(realtimeFresh({received_at_ms:100500}),true,'direct motion uses server clock despite phone clock skew');
rememberServerClock({server_now:100500,transport_delay_ms:1600});
assert.equal(realtimeFresh({received_at_ms:100500}),false,'transit-aged direct motion expires without changing raw packet time');
state.serverClock=null;rememberServerClock(snapshot);
assert.equal(node('road-title').textContent, 'Ổ gà');assert.match(node('road-confidence').textContent, /98,0%/);
assert.equal(node('speed').textContent, '42');assert.equal(mapPaints, 1);assert.equal(historyCalls, 0);
const originalReceipt = state.data._received_at;
now += 2500;renderReadings(state.data, false);
assert.equal(node('road-title').textContent, 'Chờ dữ liệu TinyML mới');assert.equal(node('score-pothole').textContent, '—');assert.equal(node('axis-x').textContent, '—');assert.equal(node('confidence-bar').style.width, '0%');
assert.equal(state.data._received_at, originalReceipt, 'display timer does not renew a road window');
assert.equal(applyLiveSnapshot({ ...snapshot, device_id: 'other', latest: { ...row, device_id: 'other' } }), false, 'device fencing');
assert.equal(applyLiveSnapshot({ ...snapshot, latest: { ...snapshot.latest, ingested_at: 99999 } }), false, 'older fast snapshot rejected');
assert.equal(applyLiveSnapshot(snapshot,state.sourceGeneration-1),false,'source generation fencing');
const held = newestSnapshot({ ...snapshot, latest: { ...row, ingested_at: 99999 }, telemetry: ['new-history'] }, state.data);
assert.equal(held.latest.ingested_at, 100000);assert.equal(held.telemetry[0], 'new-history');assert.equal(held._received_at, originalReceipt, 'slow history does not rewind or refresh latest sensor state');
state.mode = 'demo';assert.equal(applyLiveSnapshot(snapshot), false, 'explicit UI simulation remains isolated');
renderRoad(row);assert.match(node('road-title').textContent, /Demo tự động/);assert.equal(node('road-badge').textContent, 'DEMO');assert.equal(node('score-pothole').textContent, '—');
state.mode = 'live';renderRoad({ ...row, device_id: 'real-gateway-direct-demo' }, { road_current: meta, _received_at: now, server_now: 100500 });assert.equal(node('road-source').textContent, 'ADXL345 thật · vị trí mô phỏng');
assert.equal(node('model-note').textContent,'');assert.equal(node('model-note').hidden,true);
renderRoad(row,{road_current:{...meta,valid:false,reason:'missing'},_received_at:now,server_now:100500});
assert.equal(node('road-source').textContent,'ADXL345 · ESP32-S3');assert.equal(node('road-updated').textContent,'Chờ AI');
assert.equal(node('road-event-status').textContent,'');assert.equal(node('road-event-status').hidden,true,'no repeated waiting explanation');

const html = file('index.html');
const right = html.slice(html.indexOf('<aside class="right-stack">'), html.indexOf('<article id="analytics"'));
assert(right.indexOf('id="road-current"') < right.indexOf('id="direct-demo"'));
assert(right.indexOf('id="direct-demo"') < right.indexOf('id="demo-tinyml-panel"'));
assert(right.indexOf('id="demo-tinyml-panel"') < right.indexOf('id="device"'));
assert(html.indexOf('/road-state.js?') < html.indexOf('/dashboard.js?'));
for (const id of ['road-title','road-confidence','road-result','road-badge','road-icon','confidence-bar','score-flat','score-bump','score-pothole','axis-x','axis-y','axis-z','model-note']) assert.equal((html.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, `${id} remains unique`);
console.log('PASS current road UI: first-panel hierarchy, real/direct vs demo provenance, fresh-only 3s expiry, unknown/invalid/resend clear, clock skew correction, no history fetch/redraw on light snapshot, device isolation and no rewind from slow history.');
