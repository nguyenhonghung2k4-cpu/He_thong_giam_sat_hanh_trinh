// Isolated synthetic transport fixtures only: no physical ESP, OSM, inference,
// production server or project database is contacted by this test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import { createDirectDemo, routeLength } from '../WebDashboard_Online/direct-demo.mjs';
import { createUpdateFeed } from '../WebDashboard_Online/live-feed.mjs';

const root = fileURLToPath(new URL('../WebDashboard_Online/', import.meta.url));
const device = 'realtime-test-physical', virtual = device + '-direct-demo', sessionId = 'realtime-session-1';
const road = { id: 'fixture-road', name: 'SYNTHETIC TEST FIXTURE', points: [[20.9,105.82],[20.9,105.821]] };
road.length_m = routeLength(road.points);
const snapshot = (capture = 1000, distance = 0, pass = 1, state = 'running') => ({
  session_id: sessionId, active: state !== 'stopped', state, pass_index: pass,
  lat: 20.9, lon: 105.82 + .001 * distance / road.length_m, distance_m: distance,
  route_length_m: road.length_m, speed_kph: state === 'running' ? 40 : 0,
  input_speed_kph: 20, speed_multiplier: 2, capture_ms: capture,
});
const session = () => ({ session_id: sessionId, device_id: device, virtual_device_id: virtual,
  physical_boot_id: 'physical-boot', state: 'running', route: road, speed_multiplier: 2,
  created_at: 1, updated_at: 1, last_telemetry: 1, last_snapshot: snapshot(1000), last_sequence: 1,
  pass_index: 1, route_id: 1, error: '', pending_operation: null, command_delivered_at: 1 });
const frame = (seq = 1, capture = 1200, distance = 2) => ({ type: 'direct_realtime', device_id: device,
  boot_id: 'physical-boot', seq, uptime_ms: capture, direct_demo: snapshot(capture, distance),
  ecu: { online: true, speed_kph: 20, adc_raw: 1024 }, audio_active: true });
const seed = (db, s) => db.prepare('INSERT OR REPLACE INTO direct_demo_sessions VALUES(?,?,?,?,?)')
  .run(s.session_id, s.device_id, s.state, s.updated_at, JSON.stringify(s));
class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

// Deterministic source ordering, rollover, TTL and persistence tests.
{
  const db = new DatabaseSync(':memory:'); let clock = 10000; const messages = [];
  const forbidden = () => { throw Error('Realtime attempted a durable or lifecycle side effect'); };
  const direct = createDirectDemo({ db, HttpError, now: () => clock, queueCommand: forbidden,
    insertTelemetry: forbidden, startRoute: forbidden, endRoute: forbidden,
    broadcast: (...message) => messages.push(message), autoActive: () => false });
  let s = session(); seed(db, s);
  const before = db.prepare('SELECT total_changes() AS count').get().count;
  assert.equal(direct.realtime(frame()).accepted, true);
  assert.equal(messages.length, 1); assert.equal(messages[0][0], virtual); assert.equal(messages[0][1], 'direct_realtime');
  assert.equal(messages[0][2].ecu.adc_raw, 1024); assert.equal(messages[0][2].audio_active, true);
  assert.equal(direct.state().session.realtime.uptime_ms, 1200);
  assert.equal(direct.realtime(frame()).reason, 'old_direct_realtime_sequence');
  assert.equal(direct.realtime(frame(2, 1400)).reason, 'direct_realtime_rate_limited');
  clock += 200;
  assert.equal(direct.realtime(frame(2, 1400)).accepted, true);
  assert.equal(direct.realtime(frame(3, 1300)).reason, 'old_direct_realtime_sequence');
  assert.equal(direct.realtime(frame(1, 1600)).reason, 'old_direct_realtime_sequence');
  assert.equal(direct.realtime({ ...frame(3, 1600), direct_demo: snapshot(1600, 0, 2) }).reason, 'direct_realtime_pass_mismatch');
  assert.throws(() => direct.realtime(frame(), true), error => error.status === 422);
  assert.throws(() => direct.realtime({ ...frame(), device_id: virtual }), error => error.status === 422);
  assert.throws(() => direct.realtime({ ...frame(), boot_id: 'wrong-boot' }), error => error.status === 409);
  assert.throws(() => direct.realtime({ ...frame(), device_id: 'other-physical' }), error => error.status === 409);
  assert.throws(() => direct.realtime({ ...frame(), direct_demo: { ...snapshot(), session_id: 'unknown' } }), error => error.status === 409);
  assert.throws(() => direct.realtime({ ...frame(), direct_demo: null }), error => error.status === 422);
  assert.throws(() => direct.realtime({ ...frame(), uptime_ms: 1201 }), error => error.status === 422);
  assert.throws(() => direct.realtime({ ...frame(), direct_demo: { ...snapshot(1200), lat: 0 } }), error => error.status === 422);
  assert.throws(() => direct.realtime({ ...frame(), direct_demo: { ...snapshot(1200), capture_ms: undefined } }), error => error.status === 422);
  clock += 200;
  assert.throws(() => direct.realtime({ ...frame(3, 1600), ecu: { online: true, speed_kph: 181, adc_raw: 1 } }), error => error.status === 422);
  assert.throws(() => direct.realtime({ ...frame(3, 1600), audio_active: 'true' }), error => error.status === 422);
  // Extra input fields are never forwarded as events, commands, or samples.
  assert.equal(direct.realtime({ ...frame(3, 1600), event: { name: 'pothole_detected' },
    direct_demo: { ...snapshot(1600, 3), untrusted: 'discard' } }).accepted, true);
  assert.equal(messages.at(-1)[2].event, undefined); assert.equal(messages.at(-1)[2].direct_demo.untrusted, undefined);
  clock += 1501;
  assert.equal(direct.state().session.realtime, null);
  assert.equal(direct.realtime(frame(3, 1600)).accepted, false, 'expired frames retain replay cursor');
  assert.equal(db.prepare('SELECT total_changes() AS count').get().count, before, 'fast traffic and state reads write zero SQLite rows');
  // A late durable snapshot must not replace a newer fast display snapshot.
  s.last_snapshot = snapshot(1500, 2); seed(db, s);
  assert.equal(direct.realtime(frame(4, 1800, 5)).accepted, true);
  s.last_snapshot = snapshot(1700, 4); seed(db, s);
  assert.equal(direct.state().session.realtime.uptime_ms, 1800);
  s.last_snapshot = snapshot(1800, 5); seed(db, s);
  assert.equal(direct.state().session.realtime, null, 'equal/newer durable capture retires fast display');
  assert.equal(direct.realtime(frame(5, 1799)).reason, 'older_than_durable_snapshot');
  s.pass_index = 2; s.last_snapshot = snapshot(1800, 0, 2); seed(db, s);
  assert.equal(direct.state().session.realtime, null);
  assert.equal(direct.realtime(frame(5, 2000)).reason, 'direct_realtime_pass_mismatch');
  s.state = 'stopped'; seed(db, s);
  assert.throws(() => direct.realtime(frame(5, 2000)), error => error.status === 409);
  s = session(); s.session_id = 'wrap-session'; s.last_snapshot = { ...snapshot(0xffffff00), session_id: s.session_id }; seed(db, s);
  clock += 200;
  const wrap = (seq, capture) => ({ ...frame(seq, capture), direct_demo: { ...snapshot(capture), session_id: s.session_id } });
  assert.equal(direct.realtime(wrap(0xffffffff, 0xffffff80)).accepted, true);
  clock += 200;
  assert.equal(direct.realtime(wrap(0, 100)).accepted, true, 'uint32 clock/sequence wrap remains forward');
  assert.equal(direct.realtime(wrap(0xfffffffe, 0xffffff70)).accepted, false);
  db.close();
}

// A delayed durable packet captured before an applied ACK is historical only;
// it cannot undo a pause, repeat or the source-time fence used by live frames.
{
  const db = new DatabaseSync(':memory:'), inserted = [];
  const forbidden = () => { throw Error('Old durable capture changed lifecycle'); };
  const direct = createDirectDemo({ db, HttpError, now: () => 10000, queueCommand: forbidden,
    insertTelemetry: (payload, old) => inserted.push({ payload, old }), startRoute: forbidden,
    endRoute: forbidden, broadcast: forbidden, autoActive: () => false });
  const s = session(); s.state = 'paused'; s.last_snapshot = snapshot(2000, 20, 1, 'paused'); seed(db, s);
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  direct.telemetry({ device_id: device, boot_id: 'physical-boot', seq: 2, uptime_ms: 1900,
    direct_demo: snapshot(1900, 18), location: {} }, false);
  assert.equal(inserted.length, 1); assert.equal(inserted[0].old, true);
  assert.equal(direct.state().session.state, 'paused');
  assert.equal(direct.state().session.last_snapshot.capture_ms, 2000);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
  db.close();
}

// HTTP auth/bounded body/SSE transport and real schema no-growth check.
const folder = await mkdtemp(join(tmpdir(), 'direct-realtime-http-'));
const dbFile = join(folder, 'test.db'), key = 'isolated-realtime-test-key';
const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`, wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, db, reader, streamController, output = '', streamText = '', readerDone;
const request = async (path, body, status = 200, headers = {}) => {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json(); assert.equal(response.status, status, `${path}: ${JSON.stringify(json)}`); return json;
};
const counts = () => Object.fromEntries(['telemetry','events','routes','route_points','device_commands','direct_demo_sessions','direct_demo_passes']
  .map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
try {
  child = spawn(process.execPath, [join(root, 'server.mjs')], { cwd: root, windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_FILE: dbFile, INGEST_API_KEY: key,
      DEMO_SPEAKER_ENABLED: 'false', DEMO_SPEAKER_DEVICE_ID: device }, stdio: ['ignore','pipe','pipe'] });
  child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {} await wait(50); }
  assert(ready, output);
  db = new DatabaseSync(dbFile); db.exec('PRAGMA busy_timeout=5000'); seed(db, session());
  await request('/api/direct-demo/realtime', frame(), 401, { Authorization: '' });
  await request('/api/direct-demo/realtime', frame(), 401, { Authorization: 'Bearer incorrect' });
  await request('/api/direct-demo/realtime', { ...frame(), padding: 'x'.repeat(4096) }, 413);
  await request('/api/direct-demo/realtime', frame(), 422, { 'X-Telematics-Resend': '1' });
  await request('/api/direct-demo/realtime', { ...frame(), device_id: virtual }, 422);
  await request('/api/direct-demo/realtime', { ...frame(), boot_id: 'old-boot' }, 409);
  streamController = new AbortController();
  const stream = await fetch(base + '/api/stream?device_id=' + virtual, { signal: streamController.signal });
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  reader = stream.body.getReader(); const decoder = new TextDecoder();
  readerDone = (async () => { try { while (true) { const { done, value } = await reader.read(); if (done) break; streamText += decoder.decode(value); } } catch {} })();
  const initialCounts = counts(), initialSession = db.prepare('SELECT data_json FROM direct_demo_sessions').get().data_json;
  assert.equal((await request('/api/direct-demo/realtime', frame())).accepted, true);
  for (let i = 0; i < 30 && !streamText.includes('"kind":"direct_realtime"'); i++) await wait(20);
  assert.match(streamText, /event: update/); assert.match(streamText, /"kind":"direct_realtime"/);
  const fastEvent = streamText.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    .find(event => event.kind === 'direct_realtime');
  assert.equal(fastEvent.device_id, virtual); assert.equal(fastEvent.source_device_id, device);
  assert.equal(fastEvent.direct_demo.capture_ms, 1200); assert.equal(fastEvent.audio_active, true);
  assert.equal((await request('/api/direct-demo/state')).session.realtime.sequence, 1);
  assert.equal((await request('/api/direct-demo/realtime', frame())).accepted, false);
  await wait(120);
  assert.equal((await request('/api/direct-demo/realtime', frame(2, 1400, 5))).accepted, true);
  assert.deepEqual(counts(), initialCounts); assert.equal(db.prepare('SELECT data_json FROM direct_demo_sessions').get().data_json, initialSession);
  // Browser disconnection does not block producer ingestion or leak a durable queue.
  streamController.abort(); await readerDone; await wait(120);
  assert.equal((await request('/api/direct-demo/realtime', frame(3, 1600, 8))).accepted, true);
  assert.deepEqual(counts(), initialCounts);
  await wait(1550); assert.equal((await request('/api/direct-demo/state')).session.realtime, null);
  assert.equal((await request('/api/direct-demo/realtime', frame(3, 1600))).accepted, false);
  console.log('PASS direct realtime server: auth, bounded body, physical session/boot/pass, capture/sequence ordering and rollover, TTL/replay, ECU validation, immediate SSE, disconnect, zero durable growth; synthetic fixtures only.');
} catch (error) { throw new Error(error.message + '\n' + output, { cause: error }); }
finally {
  streamController?.abort(); await readerDone; db?.close();
  child?.kill(); if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 2000).unref(); });
}

// Exercise the actual SSE functions against a deterministic blocked socket.
// Real TCP buffers vary by OS, so flooding localhost is not a reliable test.
const serverSource = await readFile(join(root, 'server.mjs'), 'utf8');
const sseSource = serverSource.slice(serverSource.indexOf('const sseClients = new Set();'), serverSource.indexOf('function broadcastUpdate('));
const { writeSse, openSse, sseClients } = runInNewContext(sseSource + '\n({writeSse,openSse,sseClients})', { Date, text: String, createUpdateFeed });
class SlowResponse extends EventEmitter {
  writableLength = 0; writableNeedDrain = false; destroyed = false; writableEnded = false; writes = [];
  writeHead() {} flushHeaders() {} write(value) { this.writes.push(value); return !this.writableNeedDrain; }
  end() { this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}
const response = new SlowResponse(), req = new EventEmitter(); openSse(req, response, virtual);
const client = [...sseClients][0]; response.writes.length = 0; response.writableNeedDrain = true;
for (let sequence = 1; sequence <= 10000; sequence++) {
  writeSse(client, 'update', { kind: 'direct_realtime', sequence, received_at_ms: Date.now() });
}
assert.equal(response.writes.length, 0, 'blocked fast traffic never enters the socket queue');
assert.equal(client.pendingRealtime.sequence, 10000, 'only one newest pending frame survives');
response.writableNeedDrain = false; response.emit('drain');
assert.equal(response.writes.length, 1); assert.match(response.writes[0], /"sequence":10000/);
assert.equal(client.pendingRealtime, null);
response.writableNeedDrain = true;
writeSse(client, 'update', { kind: 'direct_realtime', sequence: 10001, received_at_ms: Date.now() - 1501 });
response.writableNeedDrain = false; response.emit('drain');
assert.equal(response.writes.length, 1, 'expired motion is never replayed after drain');
response.writableLength = 65537;
assert.equal(writeSse(client, 'update', { kind: 'telemetry' }), false);
assert.equal(response.destroyed, true); assert.equal(sseClients.size, 0);
const disconnected = new SlowResponse(); openSse(new EventEmitter(), disconnected, virtual);
assert.equal(sseClients.size, 1); disconnected.end(); assert.equal(sseClients.size, 0);
console.log('PASS SSE backpressure: 10000 blocked frames coalesce to one newest frame, stale drain drops, 64KiB cap closes, disconnect cleans clients.');
