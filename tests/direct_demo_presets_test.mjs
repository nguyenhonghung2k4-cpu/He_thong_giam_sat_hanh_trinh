// Deterministic offline preset geometry and direct-demo lifecycle fixtures.
// No GNSS receiver, external map service, real inference or physical CAN here.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import { createDirectDemo, routeLength, distanceM } from '../WebDashboard_Online/direct-demo.mjs';
import { listDemoPresets, getDemoPreset, DEMO_PRESET_MAX_LENGTH_M, DEMO_ROAD_SOURCE_POINTS, DEMO_ROAD_PROVENANCE } from '../WebDashboard_Online/direct-demo-presets.mjs';

const geometryContext = {};
runInNewContext(await readFile(new URL('../WebDashboard_Online/public/direct-demo-geometry.js', import.meta.url), 'utf8'), geometryContext);
const geometry = geometryContext.TelematicsDirectGeometry;
const catalog = listDemoPresets();
const ROAD_ID = 'kma-chien-thang-tan-trieu';
assert.deepEqual(catalog.map(route => route.nominal_length_m), [427,605,898,1205,1612,1902]);
assert.equal(DEMO_PRESET_MAX_LENGTH_M, 2000); assert.equal(new Set(catalog.map(route => route.id)).size, 6);
for (const route of catalog) {
  const length = routeLength(route.points), first = route.points[0], last = route.points.at(-1);
  assert.equal(route.source, 'osm_road'); assert.equal(route.synthetic, false); assert.equal(route.motion_simulated, true);
  assert.match(route.description, /Đường thật cạnh Học viện Kỹ thuật Mật mã/);
  assert.equal('osm_way_id' in route, false); assert.equal('distance_m' in route, false);
  assert(route.points.length >= 2 && route.points.length <= 64, 'under firmware 64-vertex bound');
  assert(Math.abs(length - route.nominal_length_m) < .5, 'rounded length is a label, never a geometry scale factor');
  assert(Math.abs(length - route.length_m) < 1e-8); assert(length >=400&&length <= 2000);
  if(route.id===ROAD_ID)assert.deepEqual(route.points, DEMO_ROAD_SOURCE_POINTS, 'legacy route retains every source vertex and turn');
  assert(length - distanceM(first,last) > 150, 'actual road bends are not replaced by an end-to-end line');
  for (let i = 1; i < route.points.length; i++) {
    const [a, b] = [route.points[i - 1], route.points[i]];
    assert(b.every(Number.isFinite)); assert(Math.abs(b[0]) < 85 && Math.abs(b[1]) < 180);
    assert(distanceM(a, b) > 1, 'no duplicate vertices; dense vertices retain the real road geometry');
    assert(distanceM(DEMO_ROAD_PROVENANCE.campus_reference, b) < 1500, 'all routes remain in the KMA neighbourhood, not old Xuân Nê');
  }
  const view = geometry.view(geometry.route(route.points), 1200, 700);
  assert(Number.isFinite(view.angle), 'rotate the entire map, not the real-road coordinates');
}
const evidenceFiles=['427','legacy','898','1205','east','1902'];
for(let i=0;i<catalog.length;i++){
  const captured=JSON.parse(await readFile(new URL(`../Docs/V11_6_1_ROADS/source-${evidenceFiles[i]}.json`,import.meta.url),'utf8'));
  assert.equal(captured.http_status,200);
  assert.deepEqual(catalog[i].points,captured.response.routes[0].geometry.coordinates.map(([lon,lat])=>[lat,lon]),'every published vertex comes from saved OSRM road geometry, no scaled/synthetic cut-through');
}
const mutated = getDemoPreset(ROAD_ID); mutated.points[0][0] = 0; mutated.name = 'forged';
assert.notEqual(getDemoPreset(ROAD_ID).points[0][0], 0, 'consumer cannot mutate whitelist geometry');
assert.notEqual(getDemoPreset(ROAD_ID).name, 'forged');
assert.equal(getDemoPreset('legacy-osm-road'), null); assert.equal(getDemoPreset('demo-400m'), null);
assert.equal(getDemoPreset({ id: ROAD_ID }), null);
const engine = await readFile(new URL('../Arduino/ESP32S3_Telematics/direct_demo_engine.h', import.meta.url), 'utf8');
assert.match(engine, /MaxVertices\s*=\s*64/); assert.match(engine, /total\s*>\s*2000/,
  'all presets stay within existing firmware; no S3 rebuild required for this catalog');

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE telemetry(id INTEGER PRIMARY KEY,device_id TEXT,boot_id TEXT,ingested_at INTEGER,
  is_resend INTEGER,firmware_version TEXT,ecu_online INTEGER,location_valid INTEGER,lat REAL,lon REAL,
  satellites INTEGER,hdop REAL,raw_json TEXT);
  CREATE TABLE device_commands(id INTEGER PRIMARY KEY,device_id TEXT,action TEXT,params_json TEXT,
  status TEXT,created_at INTEGER,completed_at INTEGER,result_json TEXT);`);
let clock = 100000, auto = false, routeCounter = 0;
const commands = [], inserts = [], broadcasts = [], ended = [];
const direct = createDirectDemo({ db, HttpError, now: () => clock, autoActive: () => auto,
  queueCommand: (device, action, params) => {
    const row = { id: commands.length + 1, device_id: device, action, params_json: JSON.stringify(params), status: 'pending' };
    commands.push(row); db.prepare('INSERT INTO device_commands VALUES(?,?,?,?,?,?,?,?)')
      .run(row.id, device, action, row.params_json, row.status, clock, null, null); return row;
  },
  insertTelemetry: (...args) => inserts.push(args), broadcast: (...args) => broadcasts.push(args),
  startRoute: () => ({ route: { id: ++routeCounter } }), endRoute: id => ended.push(id),
});
const seed = (patch = {}) => {
  const row = { device_id: 'physical', boot_id: 'physical-boot', ingested_at: clock,
    is_resend: 0, firmware_version: '11.5.3-CAN-RECOVERY', ecu_online: 1,
    location_valid: 0, lat: null, lon: null, satellites: 0, hdop: 100,
    raw_json: JSON.stringify({ system: { navigation_ready: false }, location: { valid: false } }), ...patch };
  db.exec('DELETE FROM telemetry');
  db.prepare('INSERT INTO telemetry VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(row));
};
const failure = (operation, code) => assert.throws(operation, error => error instanceof HttpError && error.code === code);
const markAck = (row, ok, result) => {
  const ack = direct.ack(row, ok, result);
  db.prepare('UPDATE device_commands SET status=?,completed_at=?,result_json=? WHERE id=?')
    .run(ack.status, clock, JSON.stringify(ack.result), row.id); return ack;
};
const oldFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Offline direct-demo catalog attempted external network'); };
try {
  const changes = db.prepare('SELECT total_changes() AS n').get().n;
  const offline = await direct.roads();
  assert.equal(offline.roads.length, 6); assert.equal(offline.requires_gps, false); assert.equal(offline.requires_network, false);
  assert.equal(offline.source, 'osm_road'); assert.equal(offline.synthetic, false);
  assert.deepEqual(offline.provenance, DEMO_ROAD_PROVENANCE);
  assert.equal('anchor' in offline, false); assert.equal('cached' in offline, false);
  for (let i = 0; i < 50; i++) assert.deepEqual(await direct.roads('unknown-device'), offline);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes, 'catalog reads never touch SQLite');
  const input = { device_id: 'physical', road_id: ROAD_ID, speed_multiplier: 2 };
  failure(() => direct.start(input), 'gateway_offline');
  failure(() => direct.start({ ...input, device_id: 'physical-direct-demo' }), 'physical_gateway_required');
  seed({ ingested_at: clock - 10001 }); failure(() => direct.start(input), 'gateway_offline');
  seed({ is_resend: 1 }); failure(() => direct.start(input), 'gateway_offline');
  seed({ firmware_version: '11.4.2' }); failure(() => direct.start(input), 'direct_firmware_required');
  seed({ ecu_online: 0 }); failure(() => direct.start(input), 'direct_can_required');
  seed({firmware_version:'11.6.1-MARKER-FIFO-FIX'});auto = true; failure(() => direct.start(input), 'automatic_demo_active'); auto = false;
  failure(() => direct.start({ ...input, speed_multiplier: 9 }), 'invalid_speed_multiplier');
  // Legacy cache contents do not expand the prepared whitelist or override it.
  db.prepare('INSERT INTO direct_demo_road_cache VALUES(?,?,?,?,?)')
    .run('physical', clock, 0, 0, JSON.stringify([{ id: 'legacy-osm-road', points: [[0, 0], [0, 1]] },
      { ...getDemoPreset(ROAD_ID), points: [[0, 0], [0, 1]] }]));
  failure(() => direct.start({ ...input, road_id: 'legacy-osm-road' }), 'unknown_road');
  failure(() => direct.start({ ...input, road_id: '../demo-400m' }), 'unknown_road');
  for (const preset of catalog) {
    seed(); const started = direct.start({ ...input, road_id: preset.id,
      route_points: [0, 0, 0, 1], points: [[0, 0], [0, 1]], route: { points: [[0, 0], [0, 1]] } });
    assert.equal(started.session.state, 'starting'); assert.equal(started.session.route.synthetic, false);
    assert.deepEqual(started.session.route.points, preset.points, 'start uses only server whitelist geometry');
    const command = commands.at(-1), params = JSON.parse(command.params_json);
    assert.deepEqual(params.route_points, preset.points.flat()); assert.equal(params.speed_multiplier, 2);
    assert.equal(direct.start({ ...input, road_id: preset.id }).duplicate, true);
    assert.equal(markAck(command, false, { error: 'synthetic-unapplied-start' }).status, 'failed');
    assert.equal(direct.state().session.state, 'failed');
  }
  assert.equal(inserts.length, 0); assert.equal(routeCounter, 0, 'listing/queued start cannot fabricate telemetry, AI or an applied trip');
  // A persisted pre-preset session continues to use its original geometry.
  const legacyPoints = [[20, 105], [20, 105.002]], legacyLength = routeLength(legacyPoints);
  const legacy = { session_id: 'legacy-active-session', device_id: 'physical', virtual_device_id: 'physical-direct-demo',
    physical_boot_id: 'physical-boot', state: 'paused', route: { id: 'old-osm-id', points: legacyPoints, length_m: legacyLength },
    speed_multiplier: 2, created_at: clock - 5000, updated_at: clock, last_telemetry: clock,
    last_snapshot: { session_id: 'legacy-active-session', active: true, state: 'paused', pass_index: 1,
      lat: 20, lon: 105, distance_m: 0, route_length_m: legacyLength, speed_kph: 0, input_speed_kph: 0,
      speed_multiplier: 2, capture_ms: 1000 }, last_sequence: 1, pass_index: 1,
    route_id: 99, pending_operation: null, command_id: null, error: '' };
  db.prepare('INSERT INTO direct_demo_sessions VALUES(?,?,?,?,?)')
    .run(legacy.session_id, legacy.device_id, legacy.state, clock, JSON.stringify(legacy));
  assert.deepEqual(direct.state().session.route.points, legacyPoints);
  const resumed = direct.control({ session_id: legacy.session_id, operation: 'resume' });
  assert.equal(resumed.session.route.id, 'old-osm-id');
  assert.equal(markAck(commands.at(-1), true, { applied: true, direct_demo: { ...legacy.last_snapshot,
    state: 'running', capture_ms: 1200, input_speed_kph: 20, speed_kph: 40 } }).status, 'done');
  const repeatedSnapshot = { ...legacy.last_snapshot, state: 'running', pass_index: 2,
    capture_ms: 1600, input_speed_kph: 20, speed_kph: 40 };
  direct.control({ session_id: legacy.session_id, operation: 'pause' });
  markAck(commands.at(-1), true, { applied: true, direct_demo: { ...legacy.last_snapshot, capture_ms: 1400 } });
  direct.control({ session_id: legacy.session_id, operation: 'repeat' });
  assert.equal(markAck(commands.at(-1), true, { applied: true, direct_demo: repeatedSnapshot }).status, 'done');
  assert.equal(direct.state().session.pass_index, 2); assert.deepEqual(direct.state().session.route.points, legacyPoints);
  assert.equal(db.prepare('SELECT count(*) AS n FROM direct_demo_road_cache').get().n, 1, 'legacy data retained, never deleted');
} finally { globalThis.fetch = oldFetch; db.close(); }
console.log('PASS real-road direct demo: cached KMA road vertices, 2km/64-point firmware compatibility, whole-map rotation, offline/no-GNSS catalog, physical/CAN/firmware gates, server geometry whitelist, no fabricated AI, legacy-session resume/repeat preservation.');
