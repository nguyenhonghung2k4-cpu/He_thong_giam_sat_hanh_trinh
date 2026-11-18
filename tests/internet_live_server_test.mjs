// Isolated real-server/browser-bridge integration using synthetic SQLite rows.
// Copies code to an OS temporary directory: no user database, private config,
// ESP board, OSM request or public tunnel is accessed by this test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createOnlineBridge } from '../WebDashboard_Online/online-bridge.mjs';
import { signRelay, sha256Hex } from '../CloudPortal/worker/protocol.js';
import { routeLength } from '../WebDashboard_Online/direct-demo.mjs';
import { listDemoPresets } from '../WebDashboard_Online/direct-demo-presets.mjs';

const source = fileURLToPath(new URL('../WebDashboard_Online/', import.meta.url));
const folder = await mkdtemp(join(tmpdir(), 'telematics-internet-live-test-'));
const app = join(folder, 'WebDashboard_Online'), dbFile = join(folder, 'synthetic.db');
await mkdir(join(app, 'public'), { recursive: true });
for (const file of ['server.mjs', 'demo-tinyml.mjs', 'direct-demo.mjs', 'direct-demo-presets.mjs', 'direct-demo-roads.json', 'live-feed.mjs']) {
  await copyFile(join(source, file), join(app, file));
}
await copyFile(join(source, 'public/index.html'), join(app, 'public/index.html'));
const reserve = createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`, key = 'synthetic-lan-ingestion-key';
const publicOrigin = 'https://synthetic-node-relay.example';
const relayKey = 'synthetic-connector-key-for-isolated-server-tests';
const runId = 'synthetic_node_run_0123456789';
const device = 'synthetic-live-physical', virtual = `${device}-direct-demo`, boot = 'synthetic-physical-boot';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let output = '', db, bridge, bridgeBase, clock = Date.now();
const child = spawn(process.execPath, [join(app, 'server.mjs')], {
  cwd: app, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_FILE: dbFile,
    INGEST_API_KEY: key, DEMO_SPEAKER_ENABLED: 'false', DEMO_SPEAKER_DEVICE_ID: device },
});
child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value);
const signedHeaders = async (path, method = 'GET', body = '', timestamp = clock) => ({
  'x-hht-relay-time': String(timestamp), 'x-hht-relay-run': runId, 'x-hht-relay-origin': publicOrigin,
  'x-hht-relay-signature': await signRelay(relayKey, { purpose: 'proxy', method, path,
    origin: publicOrigin, runId, timestamp: String(timestamp), bodyHash: await sha256Hex(Buffer.from(body)) }),
  ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) ? { Origin: publicOrigin } : {}),
});
const request = async (path, { body, status = 200, auth = false, headers = {}, method, url = base, signed = false } = {}) => {
  const verb = method || (body === undefined ? 'GET' : 'POST');
  const payload = body === undefined ? '' : JSON.stringify(body);
  const response = await fetch(url + path, { redirect: 'manual', method: verb,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(signed ? await signedHeaders(path, verb, payload) : {}),
      ...(auth ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    body: body === undefined ? undefined : payload });
  const json = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(json)}`);
  return { json, response };
};
let sequence = 0;
const telemetry = (extra = {}) => ({ type: 'telemetry', device_id: device, boot_id: boot, seq: ++sequence,
  ts: new Date().toISOString(), uptime_ms: 1000,
  location: { valid: true, lat: 20.9, lon: 105.82, speed_kph: 12 },
  ecu: { online: true, speed_kph: 12, adc_raw: 273, temperature_c: 29, dtc_code: 0 },
  road: { valid: true, label: 'go_giam_toc', confidence: .98,
    scores: { duong_bang_phang: .01, go_giam_toc: .98, o_ga: .01 },
    x_g: .1, y_g: .2, z_g: .95, inference_ms: 7 },
  system: { ai_ready: true, adxl_healthy: true, sd_ok: true },
  synthetic_raw_marker: 'RAW_PAYLOAD_MUST_NOT_REACH_BROWSER', ...extra });
const event = (id, target = device) => ({ type: 'event', device_id: target, boot_id: boot, seq: id,
  ts: new Date().toISOString(), uptime_ms: id,
  event: { id: `synthetic-event-${id}`, name: 'dtc_active', severity: 'warning' },
  ecu: { dtc_code: 1 }, synthetic_raw_marker: 'EVENT_RAW_MUST_NOT_REACH_BROWSER' });
const dbState = () => ({
  version: db.prepare('PRAGMA data_version').get().data_version,
  rows: Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    .map(({ name }) => [name, db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count])),
});

try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/internet-capabilities')).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await wait(30);
  }
  assert(ready, output);
  db = new DatabaseSync(dbFile); db.exec('PRAGMA busy_timeout=5000');
  assert.equal((await request('/api/internet-capabilities')).json.patch_version, '11.6.1');
  assert.equal((await request('/api/access-status')).json.transport, 'sse', 'LAN retains SSE mode');
  assert.equal((await request('/api/live')).json.latest, null);
  await request('/api/telemetry', { body: telemetry(), status: 401 });
  await request('/api/telemetry', { body: telemetry(), auth: true, status: 201 });
  const initial = (await request('/api/live?device_id=' + device)).json;
  assert.equal(initial.refresh_required, true); assert.equal(initial.device_id, device);
  assert.equal(initial.road_current.valid, true); assert.equal(initial.road_current.source, 'adxl345');
  assert.equal(initial.road_current.label, 'go_giam_toc'); assert.equal(initial.road_current.confidence, .98);
  assert.equal(initial.latest.ecu_speed_kph, 12); assert.equal(initial.latest.adc_raw, 273);
  for (const absent of ['telemetry', 'events', 'potholes', 'speed_bumps', 'device_config', 'routes']) {
    assert.equal(absent in initial, false, `live endpoint must not fetch full ${absent} history`);
  }
  assert.equal('raw_json' in initial.latest, false);
  assert.equal(JSON.stringify(initial).includes('RAW_PAYLOAD_MUST_NOT_REACH_BROWSER'), false);
  const originalSequence = initial.latest.sequence;
  await request('/api/telemetry', { body: telemetry({ road: { valid: true, label: 'o_ga', confidence: .99 } }),
    auth: true, status: 201, headers: { 'X-Telematics-Resend': '1' } });
  assert.equal((await request('/api/live?device_id=' + device)).json.latest.sequence, originalSequence,
    'newly delivered historical resend cannot replace current road or speed');
  assert.equal((await request('/api/live')).json.device_id, device, 'automatic selection prefers real gateway');
  const cursor = (await request('/api/live?device_id=' + device)).json.cursor;
  await request('/api/events', { body: event(1), auth: true, status: 201 });
  await request('/api/events', { body: event(2, 'synthetic-other-physical'), auth: true, status: 201 });
  const delta = (await request(`/api/live?device_id=${device}&cursor=${encodeURIComponent(cursor)}`)).json;
  assert.equal(delta.refresh_required, false); assert.equal(delta.updates.length, 1);
  assert.equal(delta.updates[0].device_id, device); assert.equal(delta.updates[0].event.name, 'dtc_active');
  assert.equal(JSON.stringify(delta).includes('EVENT_RAW_MUST_NOT_REACH_BROWSER'), false);
  assert.equal((await request(`/api/live?device_id=${device}&cursor=${encodeURIComponent(delta.cursor)}`)).json.updates.length, 0);

  // Synthetic active direct session and physical fast frame, not a generated AI inference.
  const route = structuredClone(listDemoPresets()[0]);
  route.length_m = routeLength(route.points);
  const snapshot = capture => ({ session_id: 'synthetic-direct-session', active: true, state: 'running', pass_index: 1,
    lat: route.points[0][0], lon: route.points[0][1], distance_m: 0, route_length_m: route.length_m, speed_kph: 24,
    input_speed_kph: 12, speed_multiplier: 2, capture_ms: capture });
  const session = { session_id: 'synthetic-direct-session', device_id: device, virtual_device_id: virtual,
    physical_boot_id: boot, state: 'running', route, speed_multiplier: 2, created_at: Date.now(),
    updated_at: Date.now(), last_telemetry: Date.now(), last_snapshot: snapshot(1000),
    last_sequence: 1, pass_index: 1, route_id: null, error: '', pending_operation: null };
  db.prepare('INSERT INTO direct_demo_sessions VALUES(?,?,?,?,?)')
    .run(session.session_id, device, session.state, session.updated_at, JSON.stringify(session));
  await request('/api/direct-demo/realtime', { body: { type: 'direct_realtime', device_id: device,
    boot_id: boot, seq: 1, uptime_ms: 1200, direct_demo: snapshot(1200),
    ecu: { online: true, speed_kph: 12, adc_raw: 273 }, audio_active: true }, auth: true });
  const motion = (await request(`/api/live?device_id=${virtual}&motion_only=1`)).json;
  assert.equal(motion.direct_active, true); assert.equal(motion.direct_realtime.sequence, 1);
  assert.equal(motion.direct_realtime.ecu.adc_raw, 273); assert.equal(motion.direct_realtime.audio_active, true);
  assert.equal('latest' in motion, false); assert.equal('road_current' in motion, false);
  assert.equal('direct_demo' in motion, false); assert(JSON.stringify(motion).length < 2500);

  bridge = createOnlineBridge({ connectorSecret: relayKey, publicUrl: publicOrigin,
    runId, targetUrl: base, now: () => clock });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  bridgeBase = `http://127.0.0.1:${bridge.address().port}`;
  await request('/api/live?device_id=' + device, { url: bridgeBase, status: 403 });
  const browser = options => ({ url: bridgeBase, signed: true, ...options });
  const accessStatus = (await request('/api/access-status', browser())).json;
  assert.equal(accessStatus.transport, 'poll'); assert.equal(accessStatus.requires_login, false);
  assert.equal(accessStatus.access_mode, 'public'); assert.equal(accessStatus.run_id, runId);
  const publicLive = await request('/api/live?device_id=' + device, browser());
  assert.equal(publicLive.json.latest.sequence, originalSequence);
  assert.equal(publicLive.response.headers.get('access-control-allow-origin'), null,
    'base server wildcard CORS must not cross public security boundary');
  for (const path of ['/api/telemetry', '/api/events', '/api/direct-demo/realtime',
    '/api/device-commands/next', '/api/device-commands/result', '/api/sd/export-chunk']) {
    const privateResponse = await request(path, browser({ status: 403, headers: { Authorization: `Bearer ${key}` } }));
    assert.equal(privateResponse.json.code, 'device_endpoint_not_public');
  }
  const beforePolls = dbState();
  for (let i = 0; i < 80; i++) {
    const path = `/api/live?device_id=${i % 2 ? device : virtual}&motion_only=${i % 3 === 0 ? 1 : 0}&cursor=${encodeURIComponent(delta.cursor)}`;
    await request(path, i % 2 ? browser() : {});
  }
  assert.deepEqual(dbState(), beforePolls,
    'repeated live/motion reads must not change any table or commit SQLite writes');

  // Browser may manage commands; only the LAN device plane may retrieve/ACK them.
  const queued = (await request('/api/device-config/read', browser({ body: { device_id: device }, status: 201,
    headers: { Origin: publicOrigin } }))).json.command;
  await request('/api/device-commands/next?device_id=' + device, { status: 401 });
  const next = (await request('/api/device-commands/next?device_id=' + device, { auth: true })).json;
  assert.equal(next.command.id, queued.id); assert.equal(next.command.action, 'config_get');
  await request('/api/device-commands/result', { body: { device_id: device, command_id: queued.id,
    ok: true, result: { synthetic: true } }, auth: true });
  assert.equal((await request('/api/device-commands/' + queued.id, browser())).json.command.status, 'done');
  const rejectedOrigin = await request('/api/direct-demo/control', browser({ body: { session_id: 'does-not-exist', action: 'pause' },
    status: 409, headers: { Origin: publicOrigin } }));
  assert.notEqual(rejectedOrigin.json.code, 'cross_origin_control_denied',
    'validated browser origin is rewritten for real backend direct-demo controls');
  const oldSignature = await signedHeaders('/');
  const rawHtml = await fetch(bridgeBase + '/', { redirect: 'manual', headers: oldSignature });
  assert.equal(rawHtml.status, 200); assert.match(rawHtml.headers.get('content-type'), /text\/html/); await rawHtml.text();
  clock += 300001;
  const expiredDocument = await fetch(bridgeBase + '/', { redirect: 'manual', headers: oldSignature });
  assert.equal(expiredDocument.status, 403, 'expired internal signature is rejected');
  await request('/api/live?device_id=' + device, browser());
  db.prepare('UPDATE telemetry SET ingested_at=? WHERE device_id=? AND is_resend=0').run(Date.now() - 4000, device);
  const stale = (await request('/api/live?device_id=' + device)).json;
  assert.equal(stale.road_current.valid, false); assert.equal(stale.road_current.reason, 'gateway_offline');
  assert.equal(stale.road_current.label, null); assert.equal(stale.road_current.confidence, null);
  console.log('PASS real server + signed internal relay: synthetic LAN ingestion/auth/resend, lightweight current-road and direct-motion polls, event deltas, 80 reads with zero SQLite commits, private device-plane isolation, public UI command/ACK roundtrip without browser password, origin rewrite, streamed static HTML and expired-signature rejection. No public tunnel or physical hardware tested.');
} catch (error) {
  throw new Error(`${error.stack}\nISOLATED SERVER:\n${output}`, { cause: error });
} finally {
  if (bridge) await new Promise(resolve => { bridge.close(resolve); bridge.closeAllConnections?.(); });
  db?.close();
  if (child.exitCode === null) {
    await new Promise(resolve => {
      const timeout = setTimeout(() => { child.kill(); resolve(); }, 4000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
      if (child.connected) child.send({ type: 'telematics:shutdown' }); else child.kill();
    });
  }
  await rm(folder, { recursive: true, force: true });
}
