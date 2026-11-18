import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = name => readFileSync(new URL('../WebDashboard_Online/public/' + name, import.meta.url), 'utf8');
const context = { URLSearchParams, AbortController };
vm.runInNewContext(source('live-poll.js'), context);
const create = context.TelematicsLivePolling.create;
const flush = () => new Promise(resolve => setImmediate(resolve));
let clock = 100000, timerId = 0, inFlight = 0, maximum = 0;
const timers = new Map(), pending = [], calls = [], snapshots = [], updates = [], statuses = [];
const later = (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; };
const cancel = id => timers.delete(id);
const poll = create({ now: () => clock, setTimeout: later, clearTimeout: cancel,
  fetch: (url, options) => { calls.push({ url, options }); inFlight++; maximum = Math.max(maximum, inFlight); return new Promise(resolve => pending.push(value => { inFlight--; resolve(value); })); },
  onSnapshot: value => snapshots.push(value), onUpdate: value => updates.push(value),
  onStatus: live => statuses.push(live), onUnauthorized: () => statuses.push('login'),
});
const reply = async (data, status = 200) => { pending.shift()({ ok: status === 200, status, json: async () => data }); await flush(); };
const next = async () => { const [id, timer] = [...timers].sort((a,b) => a[1].delay-b[1].delay)[0]; timers.delete(id); clock += timer.delay; timer.fn(); await flush(); };
poll.start('car-direct-demo');
assert.equal(calls.length, 1);
assert(!calls[0].url.includes('motion_only'));
assert.equal(timers.size, 1, 'pending fetch only has a timeout, not a recurring request');
await reply({ ok: true, device_id: 'car-direct-demo', cursor: 'one', latest: {}, direct_active: true, refresh_required: true });
assert.equal(updates[0].kind, 'sync');
await next();
assert(calls[1].url.includes('motion_only=1'));
assert(calls[1].url.includes('cursor=one'));
assert.equal(maximum, 1);
await reply({ ok: true, device_id: 'car-direct-demo', cursor: 'two', direct_active: true, updates: [{ kind: 'event' }] });
assert.equal(updates[1].kind, 'event');
for (let i = 0; i < 4; i++) { await next(); await reply({ ok: true, device_id: 'car-direct-demo', cursor: String(i), direct_active: true }); }
assert(!calls.at(-1).url.includes('motion_only'), 'durable sensor lane refreshed at 1 Hz');
assert.equal(maximum, 1);
await next(); const oldSignal = calls.at(-1).options.signal;
poll.start('other');
assert(oldSignal.aborted, 'source switch aborts previous request');
const before = snapshots.length;
await reply({ ok: true, device_id: 'car-direct-demo', cursor: 'late', latest: {} });
assert.equal(snapshots.length, before, 'late old-source response ignored');
await reply({ ok: true, device_id: 'other', cursor: 'fresh', direct_active: false });
await next();
await reply({}, 401);
assert.equal(statuses.at(-1), 'login');
assert.equal(timers.size, 0, 'expired session stops polling');
poll.start('other'); await reply({}, 503);
assert.equal(statuses.at(-1), false); assert.equal(timers.size, 1);
poll.stop(); assert.equal(timers.size, 0);

// Production-default RTT and polling cadence must use elapsed time, not a
// phone's wall clock. No real browser clock, network or production DB is used.
async function defaultClockCase(withPerformance) {
  let wall=1700000000000,monotonic=1000,nextId=0;
  const scheduled=new Map(),responses=[],frames=[],requests=[];
  const sandbox={URLSearchParams,AbortController,Date:{now:()=>wall}};
  if(withPerformance)sandbox.performance={now:()=>monotonic};
  vm.runInNewContext(source('live-poll.js'),sandbox);
  const instance=sandbox.TelematicsLivePolling.create({
    setTimeout:(fn,delay)=>{scheduled.set(++nextId,{fn,delay});return nextId;},
    clearTimeout:id=>scheduled.delete(id),
    fetch:url=>{requests.push(url);return new Promise(resolve=>responses.push(resolve));},
    onSnapshot:frame=>frames.push(frame),
  });
  const response=async cursor=>{
    responses.shift()({ok:true,status:200,json:async()=>({ok:true,cursor,device_id:'clock-car',direct_active:true})});
    await flush();
  };
  instance.start('clock-car');
  monotonic+=120;wall+=withPerformance?50000:120;
  await response('forward');
  assert.equal(frames[0].transport_delay_ms,120,'wall-clock jump forward cannot inflate measured RTT');
  let [timerId,timer]=[...scheduled][0];
  assert.equal(timer.delay,80,'200 ms motion cadence subtracts actual 120 ms transport only');
  scheduled.delete(timerId);monotonic+=80;wall+=80;timer.fn();await flush();
  assert(requests[1].includes('motion_only=1'),'clock correction does not force a history request');
  monotonic+=80;wall+=withPerformance?-100000:80;
  await response('backward');
  assert.equal(frames[1].transport_delay_ms,80,'wall-clock jump backward cannot zero measured RTT');
  [,timer]=[...scheduled][0];
  assert.equal(timer.delay,120,'backward wall correction cannot delay polling by minutes');
  instance.stop();assert.equal(scheduled.size,0);
}
await defaultClockCase(true);
await defaultClockCase(false); // Date.now remains a compatibility fallback.

// Verify actual mode selection: Internet never opens EventSource; LAN keeps SSE.
async function modeCase(remote, failFirst = false) {
  const events = [], sources = [], starts = [], nodes = { 'device-select': { value: 'car' } };
  const retry = []; let attempts = 0, generation = 7, stops = 0;
  const window = { dispatchEvent: event => events.push(event), location: { assign: value => events.push(value) },
    telematicsDashboard: { getSourceGeneration: () => generation },
    TelematicsLivePolling: { create: options => ({ start: value => starts.push({ value, options }), stop() { stops++; } }) },
    setTimeout: fn => { retry.push(fn); return retry.length; },
    EventSource: class {},
  };
  const script = source('v11.js');
  vm.runInNewContext(script.slice(0, script.indexOf('  function updateReportButton')) + '\nwindow.test={connectSse};})();', {
    window, document: { getElementById: id => nodes[id] || null },
    fetch: async () => { if (failFirst && attempts++ === 0) throw new Error('offline'); return { ok: true, json: async () => ({ mode: remote ? 'internet' : 'local', authenticated: true }) }; },
    AbortSignal, clearTimeout() {},
    EventSource: class { constructor(url) { sources.push(url); } addEventListener() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  });
  await window.test.connectSse();
  if (failFirst) { assert.equal(retry.length, 1, 'failed access discovery schedules recovery'); await retry.shift()(); }
  assert.equal(window.TelematicsAccess.remote, remote);
  assert.equal(sources.length, remote ? 0 : 1);
  assert.equal(starts.length, remote ? 1 : 0);
  if (remote) {
    starts[0].options.onSnapshot({ latest: {}, direct_realtime: { kind: 'direct_realtime' } });
    const snapshot = events.find(event => event.type === 'telematics:live-snapshot');
    assert.equal(snapshot.detail.source_generation, 7);
    assert(events.some(event => event.type === 'telematics:direct-realtime'));
    generation++; await window.test.connectSse();
    assert.equal(starts.length, 2, 'same device with a new source generation restarts polling');
    assert.equal(stops, 1);
  }
}
await modeCase(true); await modeCase(false); await modeCase(true, true);
console.log('PASS Internet transport: bounded polling, separate 5 Hz motion / 1 Hz durable data, monotonic default RTT/cadence through phone-clock jumps, injected/legacy clock compatibility, no overlap, abort/source guards, expiry/backoff, Internet HTTP and preserved LAN SSE.');
