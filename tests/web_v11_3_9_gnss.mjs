import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Isolated regression test: random loopback port, disposable synthetic SQLite
// database, no live server, no hardware, no SD export or speaker commands.
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(PROJECT, "WebDashboard_Online");
const DEVICE = "gnss-v1139-test-only";
const KEY = "gnss-regression-dummy-key";
const delay = ms => new Promise(done => setTimeout(done, ms));
const tempRoot = await mkdtemp(join(tmpdir(), "telematics-v1139-gnss-"));
const databaseFile = join(tempRoot, "test.db");
let child, exited, database, output = "", base, sequence = 0;
let abort, collector;

const source = await readFile(join(WEB, "server.mjs"), "utf8");
const seed = new DatabaseSync(databaseFile);
// The initial CREATE schema intentionally remains pre-V11.3.9. Running the
// real server then exercises its additive migration on populated old tables.
seed.exec(source.match(/db\.exec\(`([\s\S]*?)`\);/)[1]);
const now = Date.now();
seed.prepare(`INSERT INTO telemetry (device_id,boot_id,sequence,recorded_at,
  ingested_at,location_valid,lat,lon,ecu_online,raw_json)
  VALUES ('legacy-fixture','old-boot',1,?, ?,1,20.9,105.8,1,?)`)
  .run(new Date(now).toISOString(), now, '{"legacy":"preserve-me"}');
seed.prepare(`INSERT INTO routes (device_id,route_no,status,started_at,ended_at,distance_km,point_count)
  VALUES ('legacy-fixture',1,'completed',?,?,0.25,1)`).run(now - 1000, now);
seed.prepare(`INSERT INTO route_points (route_id,telemetry_id,recorded_at,ingested_at,lat,lon,speed_kph)
  VALUES (1,1,?,?,20.9,105.8,12)`).run(new Date(now).toISOString(), now);
assert.ok(!seed.prepare("PRAGMA table_info(telemetry)").all().some(row => row.name === "gnss_fix_seq"));
assert.ok(!seed.prepare("PRAGMA table_info(route_points)").all().some(row => row.name === "segment_start"));
seed.close();

async function startServer() {
  const listener = createServer();
  await new Promise((done, reject) => listener.once("error", reject).listen(0, "127.0.0.1", done));
  const port = listener.address().port;
  await new Promise(done => listener.close(done));
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(WEB, "server.mjs")], {
    cwd: WEB, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATABASE_FILE: databaseFile,
      INGEST_API_KEY: KEY, DEMO_SPEAKER_ENABLED: "false", DEMO_SPEAKER_DEVICE_ID: DEVICE },
  });
  exited = new Promise(done => child.once("exit", done));
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) return; }
    catch { /* Starting. */ }
    if (child.exitCode !== null) break;
    await delay(50);
  }
  throw new Error("Isolated GNSS server failed to start");
}
async function stopServer() {
  abort?.abort();
  if (collector) await collector;
  abort = collector = undefined;
  if (child?.exitCode === null) child.kill("SIGTERM");
  if (exited) await Promise.race([exited, delay(3500)]);
}
async function request(path, body, headers = {}, expected = body ? 201 : 200) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET", signal: AbortSignal.timeout(3000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, expected, `${path}: HTTP ${response.status}`);
  const result = await response.json();
  assert.equal(result.ok, true);
  return result;
}
function sample(fix, { lat = 20.9057, lon = 105.8276, valid = true, state = "stationary",
  stationary = state === "stationary", epoch = 1, segment = true, boot = "boot-a",
  version = 1, device = DEVICE, legacy = false, rawLat = lat + 0.00002 } = {}) {
  return {
    type: "telemetry", device_id: device, boot_id: boot, seq: ++sequence,
    ts: new Date().toISOString(), uptime_ms: 20000 + sequence * 1000,
    location: { valid, lat, lon, speed_kph: stationary ? 0 : 12, satellites: 10, hdop: 1.1,
      ...(legacy ? {} : { raw_lat: rawLat, raw_lon: lon, raw_speed_kph: 0.7,
        filter: { version, state, stationary, segment_valid: segment,
          fix_seq: fix, position_epoch: epoch, rejected_fixes: 4 } }) },
    // Simulated CAN speed must NOT cause a stationary GNSS fix to move.
    ecu: { online: true, speed_kph: 150, dtc_active: false },
    road: { valid: true, label: "duong_bang_phang", confidence: 0.99 },
    system: { sd_ok: true, sd_state: "online", firmware_version: "11.3.9" },
  };
}
async function send(fix, options, resend = false) {
  const body = sample(fix, options);
  await request("/api/telemetry", body, resend ? { "X-Telematics-Resend": "1" } : {});
  return body;
}

try {
  await startServer();
  database = new DatabaseSync(databaseFile, { readOnly: true });
  assert.equal(database.prepare("SELECT raw_json FROM telemetry WHERE id=1").get().raw_json, '{"legacy":"preserve-me"}');
  assert.equal(database.prepare("SELECT gnss_filter_version FROM telemetry WHERE id=1").get().gnss_filter_version, null);
  assert.equal(database.prepare("SELECT segment_start FROM route_points WHERE id=1").get().segment_start, 0);
  const legacyReport = await request("/api/routes/1");
  assert.equal(legacyReport.route.distance_km, 0.25);
  assert.equal(legacyReport.points.length, 1);
  const page = await fetch(base + "/");
  assert.equal(page.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal((await fetch(base + "/route-geometry.js")).status, 200);

  abort = new AbortController();
  const stream = await fetch(`${base}/api/stream?device_id=${DEVICE}`, { signal: abort.signal });
  let packets = "";
  collector = (async () => {
    try { for await (const chunk of stream.body) packets += new TextDecoder().decode(chunk); }
    catch (error) { if (!abort?.signal.aborted) throw error; }
  })();
  const routeId = (await request("/api/routes/start", { device_id: DEVICE })).route.id;
  const detail = () => request(`/api/routes/${routeId}`);
  await send(1, { segment: false });
  const duplicate = await send(1, { rawLat: 20.9059 });
  assert.equal((await request("/api/telemetry", duplicate)).duplicate, true);
  for (let fix = 2; fix <= 22; fix++) await send(fix, { rawLat: 20.9057 + fix / 1000000 });
  let route = await detail();
  assert.equal(route.points.length, 1, "Stationary fixes and repeated source fix must not make route dots");
  assert.equal(route.route.distance_km, 0, "CAN 150 km/h is not GNSS movement");
  let latest = (await request(`/api/dashboard?device_id=${DEVICE}`)).latest;
  assert.equal(latest.gnss_raw_lat, 20.905722);
  assert.equal(latest.gnss_raw_speed_kph, 0.7);
  assert.equal(latest.gnss_rejected_fixes, 4);
  assert.equal(latest.gnss_stationary, 1);
  assert.equal(latest.speed_kph, 0);
  assert.ok(packets.includes('"kind":"telemetry"'), "SSE invalidation must continue working");

  await send(23, { state: "moving", epoch: 2, segment: false, lat: 20.90572 });
  await send(24, { state: "moving", epoch: 2, lat: 20.90574 });
  route = await detail();
  assert.equal(route.points.length, 3);
  assert.deepEqual(route.points.map(row => row.segment_start), [1, 1, 0]);
  const firstDistance = route.route.distance_km;
  assert.ok(firstDistance > 0.002 && firstDistance < 0.0024);
  await send(24, { state: "moving", epoch: 2, lat: 21 });
  await send(23, { state: "moving", epoch: 2, lat: 21 });
  assert.equal((await detail()).points.length, 3, "Repeated/regressed fix ID is ignored");
  await send(25, { state: "moving", epoch: 2, lat: 20.90576 });
  assert.equal((await detail()).points.at(-1).segment_start, 1, "Regressed fix breaks next segment");
  await send(26, { valid: false, state: "rejected", epoch: 2, lat: null });
  assert.equal((await detail()).route.distance_km, firstDistance);
  assert.equal(database.prepare("SELECT gap_pending FROM route_navigation_state WHERE route_id=?").get(routeId).gap_pending, 1);
  await stopServer();
  await startServer();
  await send(27, { state: "moving", epoch: 3, segment: false, lat: 20.9067 });
  route = await detail();
  assert.equal(route.points.at(-1).segment_start, 1, "GPS gap survives server restart");
  assert.equal(route.route.distance_km, firstDistance, "No distance bridge after reacquisition");
  await send(28, { state: "moving", epoch: 3, lat: 20.90672 });
  const movingDistance = (await detail()).route.distance_km;
  assert.ok(movingDistance > firstDistance);

  // Contradictory payloads cannot make stale/rejected fixes valid again.
  for (const state of ["stale", "acquiring", "rejected", "invalid"]) {
    await send(29, { state, epoch: 3, valid: true, lat: 20.91 });
    latest = (await request(`/api/dashboard?device_id=${DEVICE}`)).latest;
    assert.equal(latest.location_valid, 0);
  }
  await send(30, { state: "moving", epoch: 3, lat: 20.907 });
  assert.equal((await detail()).points.at(-1).segment_start, 1);
  assert.equal((await detail()).route.distance_km, movingDistance);
  await send(31, { state: "moving", epoch: 4, lat: 20.9075 });
  assert.equal((await detail()).points.at(-1).segment_start, 1, "Epoch change must split");
  await send(1, { state: "moving", epoch: 4, boot: "boot-b", lat: 20.908 });
  assert.equal((await detail()).points.at(-1).segment_start, 1, "Gateway reboot must split");
  const beforeResend = (await detail()).points.length;
  await send(100, { state: "moving", epoch: 99, boot: "old-boot", lat: 21 }, true);
  assert.equal((await detail()).points.length, beforeResend);
  assert.equal((await request(`/api/dashboard?device_id=${DEVICE}`)).latest.boot_id, "boot-b");
  await request("/api/routes/end", { device_id: DEVICE, route_id: routeId }, {}, 200);
  route = await detail();
  assert.equal(route.points.length, beforeResend, "Ending route cannot append same fix twice");

  // Legacy telemetry and automatic demo retain their existing route contract.
  const legacyDevice = "legacy-demo-test-only";
  const legacyId = (await request("/api/routes/start", { device_id: legacyDevice })).route.id;
  await send(1, { legacy: true, device: legacyDevice, lat: 20.8 });
  await send(2, { legacy: true, device: legacyDevice, lat: 20.80002 });
  const legacy = await request(`/api/routes/${legacyId}`);
  assert.equal(legacy.points.length, 2);
  assert.deepEqual(legacy.points.map(row => row.segment_start), [1, 0]);
  assert.ok(legacy.route.distance_km > 0);
  latest = (await request(`/api/dashboard?device_id=${legacyDevice}`)).latest;
  assert.equal(latest.gnss_filter_version, null);
  await send(3, { legacy: true, device: legacyDevice, lat: null });
  assert.equal((await request(`/api/dashboard?device_id=${legacyDevice}`)).latest.location_valid, 0);
  assert.equal((await request(`/api/routes/${legacyId}`)).points.length, 2, "Null latitude cannot become zero");

  // Execute the exact shared browser geometry helper used by map AND PDF.
  const sandbox = {};
  vm.runInNewContext(await readFile(join(WEB, "public", "route-geometry.js"), "utf8"), sandbox);
  const split = sandbox.TelematicsRouteGeometry.splitRouteSegments;
  const segments = split(route.points);
  assert.ok(segments.length >= 6);
  const edges = segments.flatMap(segment => segment.slice(1).map((point, i) => [segment[i], point]));
  assert.equal(edges.length, 2, "Only the two observed moving edges may appear on map or PDF");
  assert.deepEqual(Array.from(split([{ lat: 1, lon: 1 }, { lat: null, lon: 1 }, { lat: 2, lon: 2 }]), s => s.length), [1, 1]);
  assert.deepEqual(Array.from(split([{ lat: 1, lon: 1 }, { lat: 3, lon: 3, location_valid: 0 }, { lat: 2, lon: 2 }]), s => s.length), [1, 1]);
  assert.equal(split([]).length, 0);
  assert.equal(split([{ lat: 1, lon: 1 }])[0].length, 1, "Singleton segment remains unconnected");
  for (const file of ["index.html", "trip-report.html"]) {
    const html = await readFile(join(WEB, "public", file), "utf8");
    assert.ok(html.includes('/route-geometry.js?v=11.3.9'));
  }
  const dashboardSource = await readFile(join(WEB, "public", "dashboard.js"), "utf8");
  assert.ok(dashboardSource.includes("setLatLngs(segments)"));
  assert.ok(dashboardSource.includes("Giữ vị trí"));
  const reportSource = await readFile(join(WEB, "public", "trip-report.js"), "utf8");
  assert.ok(reportSource.includes("for (const segment of routeSegments)"));
  assert.ok(reportSource.includes("leaflet.polyline(routeLatLngs"));
  console.log("PASS V11.3.9: additive populated-DB migration, raw/filter JSON, stationary/source dedup, invalid-gap/reboot/epoch segments, restart persistence, resend isolation, legacy/demo, SSE, map/PDF shared geometry and referrer policy (isolated loopback only).");
} catch (error) {
  throw new Error(`${error.stack || error.message}\n${output}`);
} finally {
  await stopServer();
  database?.close();
  const safeTemp = resolve(tempRoot);
  assert.equal(dirname(safeTemp), resolve(tmpdir()));
  assert.ok(safeTemp.startsWith(join(resolve(tmpdir()), "telematics-v1139-gnss-")));
  await rm(safeTemp, { recursive: true, force: true });
}
