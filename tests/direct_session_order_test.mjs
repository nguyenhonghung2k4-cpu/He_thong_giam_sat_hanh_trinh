// Execute the shipped controller with a minimal DOM adapter. These tests delay
// real function promises; they do not substitute a separate ordering algorithm.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { createDirectDemo } from '../WebDashboard_Online/direct-demo.mjs';

const source = readFileSync(new URL('../WebDashboard_Online/public/direct-demo.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = session => ({ ok: true, json: async () => ({ ok: true, session }) });
const fixture = (overrides = {}) => ({ session_id: 'S', device_id: 'physical', virtual_device_id: 'physical-direct-demo',
  physical_boot_id: 'B', state: 'paused', revision: 1, updated_at: 100, pass_index: 1, command_id: null,
  route: { points: [[20, 105], [20, 105.01]], length_m: 1000 },
  last_snapshot: { capture_ms: 1000, pass_index: 1, distance_m: 500 }, ...overrides });
function ui() {
  const requests = [], applied = [], nodes = new Map(); let selected = 'physical-direct-demo';
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', classList: { toggle() {}, add() {}, remove() {} }, replaceChildren() {}, append() {} });
    return nodes.get(id);
  };
  const window = { TelematicsDirectGeometry: { confirmed: s => ['running', 'paused', 'completed', 'can_stale'].includes(s) },
    telematicsDashboard: { currentDeviceId: () => selected, setDirectDemoView: s => { applied.push(s); return true; },
      selectDevice: async id => { selected = id; }, clearDirectDemoView() {}, getDirectRealtime: () => null, refreshDirectRealtime() {} },
    dispatchEvent() {} };
  vm.runInNewContext(source.slice(0, source.indexOf('  $("direct-roads").addEventListener')) + '\nwindow.api={state,poll,control,applySession};})();', {
    window, document: { getElementById: node, body: { classList: { toggle() {} } } },
    fetch: (url, options) => { const pending = deferred(); requests.push({ url, options, ...pending }); return pending.promise; },
    AbortSignal, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }, console,
  });
  Object.assign(window.api.state, { session: fixture(), watch: 'S', view: 'S', available: true });
  return { ...window.api, window, requests, applied, nodes, setSelected: id => { selected = id; } };
}

// A GET sent before repeat must never roll the view back after its POST.
{
  const h = ui(), old = fixture(), next = fixture({ revision: 2, state: 'running', pass_index: 2, updated_at: 100,
    last_snapshot: { capture_ms: 2000, pass_index: 2, distance_m: 0 } });
  const pendingPoll = h.poll(), action = h.control('repeat');
  h.requests[1].resolve(response(next)); await action;
  h.requests[0].resolve(response(old)); await pendingPoll;
  assert.equal(h.state.session.pass_index, 2); assert.equal(h.state.session.state, 'running');
  assert.equal(h.applied.at(-1).pass_index, 2); assert.equal(h.state.polling, false);
  assert.equal(await h.applySession(old), false, 'revision guard also protects non-poll application');
  assert.equal(await h.applySession({ ...old, revision: 3 }), false, 'pass cannot regress even with an inconsistent higher revision');
  const freshPoll = h.poll(); h.requests.at(-1).resolve(response(next)); await freshPoll;
  assert.equal(h.state.available, true, 'polling survives rejected stale response');
}
// A delayed running response cannot reopen a stopped session or steal its map.
{
  const h = ui(), running = fixture({ state: 'running' }), stopped = fixture({ revision: 2, state: 'stopped' });
  h.state.session = running;
  const pendingPoll = h.poll(), action = h.control('stop');
  h.requests[1].resolve(response(stopped)); await action;
  h.requests[0].resolve(response(running)); await pendingPoll;
  assert.equal(h.state.session.state, 'stopped'); assert.equal(h.state.view, ''); assert.equal(h.state.watch, '');
  assert.equal(await h.applySession({ ...running, revision: 3 }), false);
  assert.equal(await h.applySession(null), false, 'delayed empty startup response cannot erase session');
  const newSession = fixture({ session_id: 'NEW', revision: 4, state: 'starting', pass_index: 0, last_snapshot: null });
  assert.equal(await h.applySession(newSession), true);
  assert.equal(await h.applySession(stopped), false, 'old session cannot displace new session');
}
// Old request failure also must not falsely mark a successful control offline.
{
  const h = ui(), pendingPoll = h.poll(), action = h.control('repeat');
  h.requests[1].resolve(response(fixture({ revision: 2, state: 'running', pass_index: 2 }))); await action;
  h.requests[0].reject(new Error('old connection closed')); await pendingPoll;
  assert.equal(h.state.available, true); assert.equal(h.state.polling, false);
  const fresh = h.poll(); h.requests.at(-1).reject(new Error('current request failed')); await fresh;
  assert.equal(h.state.available, false); assert.equal(h.state.polling, false);
  const recovered = h.poll(); h.requests.at(-1).resolve(response(h.state.session)); await recovered;
  assert.equal(h.state.available, true);
}
// An already-started device switch must not publish its old view after stop.
{
  const h = ui(), switching = deferred(); h.setSelected('physical');
  h.window.telematicsDashboard.selectDevice = () => switching.promise;
  const oldApply = h.applySession(fixture({ state: 'running', revision: 2 }));
  const stopped = fixture({ state: 'stopped', revision: 3 });
  await h.applySession(stopped); switching.resolve(); await oldApply;
  assert.equal(h.state.session.state, 'stopped'); assert.equal(h.applied.length, 0, 'old asynchronous view never paints');
}

// Upgrade a pre-revision database without rewriting its original session JSON.
// Constant wall time deliberately makes updated_at useless for ordering.
{
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE direct_demo_sessions(session_id TEXT PRIMARY KEY,device_id TEXT,state TEXT,updated_at INTEGER,data_json TEXT);
    CREATE TABLE device_commands(id INTEGER PRIMARY KEY,device_id TEXT,action TEXT,params_json TEXT,status TEXT,completed_at INTEGER,result_json TEXT);`);
  const legacy = fixture(); delete legacy.revision;
  const original = JSON.stringify(legacy);
  db.prepare('INSERT INTO direct_demo_sessions VALUES(?,?,?,?,?)').run('S', 'physical', 'paused', 100, original);
  const broadcasts = [];
  const options = { db, HttpError: class extends Error {}, now: () => 100, autoActive: () => false,
    queueCommand: (device, action, params) => {
      const result = db.prepare("INSERT INTO device_commands(device_id,action,params_json,status) VALUES(?,?,?,'pending')").run(device, action, JSON.stringify(params));
      return { id: Number(result.lastInsertRowid) };
    }, insertTelemetry() {}, startRoute() { return { route: { id: 1 } }; }, endRoute() {},
    broadcast: (id, type, payload) => broadcasts.push(payload.session),
  };
  let demo = createDirectDemo(options);
  assert.equal(demo.state().session.revision, 0);
  assert.equal(db.prepare('SELECT data_json FROM direct_demo_sessions').get().data_json, original);
  const repeat = demo.control({ session_id: 'S', operation: 'repeat' }).session;
  assert.equal(repeat.revision, 1); assert.equal(repeat.updated_at, 100);
  assert.equal(demo.control({ session_id: 'S', operation: 'repeat' }).session.revision, 1, 'idempotent request does not invent a change');
  const stop = demo.control({ session_id: 'S', operation: 'stop' }).session;
  assert.equal(stop.revision, 2); assert.equal(stop.updated_at, 100);
  assert.equal(broadcasts.at(-1).revision, stop.revision);
  db.prepare("UPDATE device_commands SET status='done'").run();
  demo = createDirectDemo(options); // Reconstruct service on the same stored DB.
  assert.equal(demo.state().session.revision, 2);
  assert.equal(demo.control({ session_id: 'S', operation: 'resume' }).session.revision, 3, 'revision survives service restart');
  db.close();
}
console.log('PASS direct session ordering: repeat/stop stale GET rejection, old failure fencing, polling recovery, async view guard, cross-session protection, legacy migration and persisted monotonic revision with tied timestamps.');
