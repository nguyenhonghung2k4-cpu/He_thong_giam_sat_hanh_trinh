import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const file = name => readFileSync(new URL('../WebDashboard_Online/public/' + name, import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(file('direct-demo-geometry.js'), { globalThis: window });
const geometry = window.TelematicsDirectGeometry;
const route = geometry.route([[20.9, 105.82], [20.9003, 105.8202], [20.9004, 105.821]]);
let now = 100000, frameId = 0, fetches = 0;
const frames = new Map(), nodes = new Map(), paint = [];
const node = id => {
  if (!nodes.has(id)) nodes.set(id, { textContent: '', className: '', value: '', style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, append() {} });
  return nodes.get(id);
};
class TestDate extends Date { static now() { return now; } }
const dashboard = file('dashboard.js');
const prefix = dashboard.slice(0, dashboard.indexOf('  const SIDEBAR_PREF_KEY='));
vm.runInNewContext(prefix + `
drawVehiclePosition=p=>{vehicleMotion.displayed=p.slice();window.paint.push([...p]);};
window.api={state,directView,directRealtime,vehicleMotion,applyDirectRealtime,directMapLatest,directMotionPacket,renderDirectRealtimeReadings,animateDirectVehicle,newerUint32};
})();`, {
  window, document: { getElementById: node }, Date: TestDate, performance: { now: () => now }, Intl, console,
  setTimeout, clearTimeout, fetch: () => { fetches++; throw new Error('Realtime must never fetch history'); },
  requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
  cancelAnimationFrame: id => frames.delete(id), globalThis: { crypto: { randomUUID: () => 'realtime-test' } },
});
window.paint = paint;
const { state, directView, directRealtime, vehicleMotion, applyDirectRealtime, directMapLatest, directMotionPacket, renderDirectRealtimeReadings, animateDirectVehicle, newerUint32 } = window.api;
const snapshot = (capture, distance, extra = {}) => ({ session_id: 'session', capture_ms: capture, pass_index: 1, distance_m: distance, speed_kph: 36, input_speed_kph: 18, can_fresh: true, state: 'running', ...extra });
const durable = (capture, distance, extra = {}) => ({ device_id: 'real-direct-demo', boot_id: 'session', sequence: capture, uptime_ms: capture, ingested_at: now, location_valid: true, lat: route.points[0][0], lon: route.points[0][1], direct_demo: snapshot(capture, distance, extra) });
const packet = (sequence, capture, distance, extra = {}) => ({ kind: 'direct_realtime', device_id: 'real-direct-demo', source_device_id: 'real', boot_id: 'physical-boot', sequence, uptime_ms: capture, received_at_ms: now, direct_demo: snapshot(capture, distance), ecu: { online: true }, ...extra });
const advance = dt => { now += dt; const batch = [...frames.values()]; frames.clear(); for (const fn of batch) fn(now); };
state.selectedDevice = 'real-direct-demo'; state.vehicleCore = {};
state.data = { latest: durable(1000, 0) };
directView.route = route;
directView.session = { session_id: 'session', virtual_device_id: 'real-direct-demo', device_id: 'real', physical_boot_id: 'physical-boot', state: 'running', last_snapshot: snapshot(1000, 0) };
animateDirectVehicle(state.data.latest, route.points[0]);
advance(200);
assert.equal(applyDirectRealtime(packet(1, 1200, 10)), true);
assert.equal(frames.size, 1);
advance(80); assert(Math.abs(vehicleMotion.directDistance - 5) < 0.001, 'bounded confirmed interpolation follows route distance');
advance(80); assert.equal(vehicleMotion.directDistance, 10); assert.equal(frames.size, 0, '5 Hz motion settles in at most 160 ms');
assert.equal(node('speed').textContent, '18');
assert.equal(node('gnss-speed').textContent, '36');
assert.equal(state.data.latest.ingested_at, 100000, 'fast motion must not refresh durable sensor timestamps');
assert.equal(applyDirectRealtime(packet(1, 1200, 11)), false, 'duplicate rejected');
assert.equal(applyDirectRealtime(packet(0, 1100, 11)), false, 'out-of-order rejected');
assert.equal(applyDirectRealtime(packet(2, 1400, 11, { boot_id: 'other' })), false, 'physical boot isolation');
assert.equal(applyDirectRealtime(packet(2, 1400, 11, { device_id: 'other-direct-demo' })), false, 'device isolation');
assert.equal(applyDirectRealtime(packet(2, 1400, 11, { received_at_ms: now - 2000 })), false, 'stale arrival rejected');

// Simulate 12 seconds of audio/storage work without any durable telemetry update.
for (let seq = 2; seq <= 61; seq++) {
  advance(40);
  const distance = 10 + seq / 2;
  assert.equal(applyDirectRealtime(packet(seq, 1000 + seq * 200, distance, { audio_active: true })), true);
  advance(160);
  assert.equal(vehicleMotion.directDistance, distance);
}
assert.equal(fetches, 0, '60 fast packets create no dashboard/route/history requests');
assert.equal(state.data.latest.ingested_at, 100000, 'old TinyML/SD freshness remains unchanged after prolonged audio');
assert.equal(directMapLatest(state.data.latest).direct_demo.distance_m, 40.5, 'late durable query cannot roll marker back');
const held = [...paint.at(-1)];
advance(2000); renderDirectRealtimeReadings();
assert.deepEqual([...paint.at(-1)], held, 'silent stream does not extrapolate');
assert.equal(node('speed').textContent, '—', 'stale speed is unavailable, not live');
assert.equal(directMapLatest(state.data.latest).direct_demo.distance_m, 40.5, 'stale stream holds latest confirmed position');

state.data.latest = durable(14000, 45);
assert.equal(directMotionPacket(), null, 'newer durable capture supersedes fast packet');
assert.equal(directMapLatest(state.data.latest).direct_demo.distance_m, 45);
assert.equal(applyDirectRealtime(packet(62, 13800, 44)), false, 'fast packet older than durable capture rejected');
directView.session.last_snapshot = snapshot(15000, 0, { pass_index: 2 });
assert.equal(applyDirectRealtime(packet(63, 15200, 5)), false, 'previous pass rejected');
assert.equal(applyDirectRealtime(packet(63, 15200, 5, { direct_demo: snapshot(15200, 5, { pass_index: 2 }) })), true);
assert.equal(vehicleMotion.directDistance, 5, 'confirmed repeat resets without cross-pass interpolation');
advance(200);
assert.equal(applyDirectRealtime(packet(64, 15400, 6, { direct_demo: snapshot(15400, 6, { pass_index: 2, speed_kph: 0 }) })), true);
assert.equal(frames.size, 0, 'zero speed applies confirmed stop immediately');
directView.session.state = 'stopped';
assert.equal(applyDirectRealtime(packet(65, 15600, 7)), false, 'motion never acknowledges or resurrects stopped session');
assert.equal(newerUint32(10, 0xfffffff0), true, 'capture wrap accepted');
assert.equal(newerUint32(0xfffffff0, 10), false, 'pre-wrap delayed frame rejected');

// Exercise actual SSE dispatch: the fast lane must bypass the generic refresh path.
const events = [], bridgeWindow = { dispatchEvent: event => events.push(event) };
const bridgeSource = file('v11.js');
vm.runInNewContext(bridgeSource.slice(0, bridgeSource.indexOf('  async function selectDashboardDevice')) + '\nwindow.handle=handleSseMessage;})();', {
  window: bridgeWindow, document: { getElementById: id => id === 'device-select' ? { value: 'real-direct-demo' } : null },
  CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts.detail; } },
  clearTimeout() {},
});
bridgeWindow.handle({ data: JSON.stringify(packet(99, 19000, 9)) });
assert.equal(events.length, 1); assert.equal(events[0].type, 'telematics:direct-realtime');
assert.equal(events.some(event => event.type === 'telematics:sse-update'), false);
const html = file('index.html');
assert(!html.includes('analytics-v10')); assert(!html.includes('>Thống kê<'));
assert(!dashboard.includes('/api/analytics')); assert(!dashboard.includes('renderAnalytics')); assert(!dashboard.includes('drawAnalyticsChart'));
assert(html.includes('href="#analytics"')); assert(html.includes('id="accel-chart"'));
assert(html.includes('id="event-list"')); assert(html.includes('id="route-report-btn"')); assert(html.includes('id="auto-demo"'));
assert(file('direct-demo.js').includes('if(s?.realtime)window.telematicsDashboard?.applyDirectRealtime?.(s.realtime)'));
console.log('PASS direct realtime UI: no-fetch 5 Hz lane, 160 ms confirmed interpolation, 12 s audio without durable data, freshness isolation, no extrapolation/rollback, pass/boot/source/sequence guards, zero-speed stop, SSE routing, and statistics-only removal.');
