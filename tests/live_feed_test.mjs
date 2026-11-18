// Deterministic browser-transport tests. No device, database or public network.
import assert from 'node:assert/strict';
import { buildRoadCurrent, createUpdateFeed } from '../WebDashboard_Online/live-feed.mjs';

const now = 100000, fresh = {
  device_id: 'synthetic-physical', ingested_at: now - 25, ai_ready: 1,
  road_valid: 1, adxl_healthy: 1, road_label: 'duong_bang_phang', confidence: .96,
  flat_confidence: .96, speed_bump_confidence: .03, pothole_confidence: .01,
  x_g: .1, y_g: -.2, z_g: .98, inference_ms: 6, is_resend: 0,
};
const current = patch => buildRoadCurrent({ ...fresh, ...patch }, now);
assert.deepEqual(buildRoadCurrent(null, now), {
  valid: false, source: 'unknown', window_ms: 2000, age_ms: null,
  sample_time_ms: null, reason: 'missing', label: null, confidence: null,
  scores: { duong_bang_phang: null, go_giam_toc: null, o_ga: null },
  x_g: null, y_g: null, z_g: null, inference_ms: null,
});
const ready = current({});
assert.equal(ready.valid, true); assert.equal(ready.reason, 'fresh');
assert.equal(ready.source, 'adxl345'); assert.equal(ready.age_ms, 25);
assert.equal(ready.window_ms, 2000); assert.equal(ready.sample_time_ms, null,
  'server receipt time must not be presented as physical capture time');
assert.equal(ready.label, 'duong_bang_phang'); assert.equal(ready.confidence, .96);
assert.deepEqual(ready.scores, { duong_bang_phang: .96, go_giam_toc: .03, o_ga: .01 });
assert.equal(ready.y_g, -.2); assert.equal(ready.inference_ms, 6);
for (const label of ['duong_bang_phang', 'go_giam_toc', 'o_ga']) {
  assert.equal(current({ road_label: label }).label, label);
}
for (const patch of [
  { ingested_at: now - 3001 }, { ingested_at: null }, { ingested_at: undefined },
  { ingested_at: now + 1 }, { is_resend: 1 }, { is_resend: true },
]) {
  const result = current(patch); assert.equal(result.valid, false);
  assert.equal(result.reason, 'gateway_offline'); assert.equal(result.label, null);
  assert.equal(result.confidence, null); assert.equal(result.x_g, null);
}
assert.equal(current({ ingested_at: now - 3000 }).valid, true, 'inclusive receipt-age boundary');
for (const ai_ready of [0, false, null, undefined, 'true']) {
  assert.equal(current({ ai_ready }).reason, 'ai_not_ready');
}
for (const patch of [
  { road_valid: 0 }, { road_valid: null }, { road_label: 'unknown' },
  { confidence: -.001 }, { confidence: 1.001 }, { confidence: null },
  { confidence: NaN }, { confidence: Infinity }, { adxl_healthy: 0 },
]) {
  assert.equal(current(patch).reason, 'ai_stale'); assert.equal(current(patch).valid, false);
}
assert.equal(current({ confidence: 0 }).confidence, 0);
assert.equal(current({ confidence: 1 }).confidence, 1);
assert.deepEqual(current({ flat_confidence: null, speed_bump_confidence: 2,
  pothole_confidence: NaN, x_g: '', y_g: Infinity, z_g: null, inference_ms: '' }).scores,
{ duong_bang_phang: null, go_giam_toc: null, o_ga: null });
assert.equal(current({ x_g: '' }).x_g, null);
assert.equal(current({ device_id: 'synthetic-auto-demo', adxl_healthy: 0 }).source, 'auto_demo');
assert.equal(current({ device_id: 'synthetic-auto-demo', adxl_healthy: 0 }).valid, true);
assert.equal(current({ device_id: 'synthetic-demo', adxl_healthy: 0 }).source, 'sample_demo');
assert.equal(current({ device_id: 'synthetic-direct-demo', adxl_healthy: 0 }).source, 'adxl345');
assert.equal(current({ device_id: 'synthetic-direct-demo', adxl_healthy: 0 }).valid, false,
  'direct demo must require the actual accelerometer readiness gate');

let clock = now;
const feed = createUpdateFeed({ capacity: 3, now: () => clock });
const first = feed.read('vehicle-a');
assert.equal(first.refresh_required, true); assert.deepEqual(first.updates, []);
for (let i = 0; i < 10000; i++) {
  feed.publish('vehicle-a', 'telemetry', { sequence: i });
  feed.publish('vehicle-a', 'direct_realtime', { sequence: i });
}
assert.deepEqual(feed.read('vehicle-a', first.cursor), {
  cursor: first.cursor, refresh_required: false, updates: [],
}, 'replaceable high-rate snapshots do not grow the update outbox or cursor');
feed.publish('vehicle-a', 'event', { event: { id: 1, name: 'pothole_detected', raw_json: 'private raw payload' } });
clock += 1;
feed.publish('vehicle-b', 'command_ack', { command_id: 2 });
feed.publish('', 'config');
const all = feed.read('', first.cursor), onlyA = feed.read('vehicle-a', first.cursor);
assert.equal(all.refresh_required, false); assert.equal(all.updates.length, 3);
assert.equal(onlyA.updates.length, 2, 'device filter includes only selected and global updates');
assert.deepEqual(onlyA.updates.map(row => row.kind), ['event', 'config']);
assert.equal(onlyA.updates[0].received_at, new Date(now).toISOString());
assert.equal('n' in onlyA.updates[0], false); assert.equal('raw_json' in onlyA.updates[0].event, false);
assert.equal(JSON.stringify(onlyA).includes('private raw payload'), false);
assert.equal(feed.read('vehicle-b', onlyA.cursor).updates.length, 0,
  'cursor advances across filtered updates and does not replay another device');
feed.publish('vehicle-a', 'event', { event: { id: 4 } });
assert.equal(feed.read('vehicle-a', first.cursor).refresh_required, true, 'overrun requests full refresh');
assert.equal(feed.read('vehicle-a', first.cursor).updates.length, 0, 'never replay a partial gap');
const recentCursor = all.cursor;
for (let id = 5; id < 10005; id++) feed.publish('vehicle-a', 'event', { event: { id } });
assert.equal(feed.read('vehicle-a', recentCursor).refresh_required, true);
const tail = feed.read('vehicle-a', feed.read('vehicle-a').cursor.replace(/:\d+$/, ':10001'));
assert.equal(tail.updates.length, 3, 'retained events are bounded to configured capacity');
for (const invalid of ['', 'broken', '0:0', first.cursor.replace(/:\d+$/, ':999999999'),
  first.cursor.replace(/:\d+$/, ':9007199254740992')]) {
  assert.equal(feed.read('vehicle-a', invalid).refresh_required, true);
}
assert.equal(createUpdateFeed().read('vehicle-a', feed.read('vehicle-a').cursor).refresh_required, true,
  'process epoch prevents applying an old cursor after server restart');
console.log('PASS live feed: real/simulated source labels, readiness and staleness gates, no fabricated sample time, bounded cursor/restart/gap filtering, raw payload exclusion and 20000 replaceable snapshots.');
