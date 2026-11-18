import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

// This test never contacts the default server or any device. The server is
// loopback-only, uses a random port and disposable database, and receives no
// speaker/export commands. New counters remain in raw_json; the public SSE
// contract remains an invalidation carrying device_id/kind/sequence.
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(PROJECT, "WebDashboard_Online");
const DEVICE = "v1138-diagnostics-test-only";
const KEY = "v1138-diagnostics-dummy-key";
const DIAGNOSTICS = {
  sd_log_ram_depth: 1,
  sd_offline_ram_depth: 1,
  sd_event_ram_depth: 4,
  sd_log_coalesced: 300,
  sd_offline_coalesced: 250,
  sd_queue_alloc_failures: 2,
  sd_worker_stage: "idle",
  sd_worker_stage_age_ms: 75,
  audio_pcm_gain_percent: 100,
  network_backoff_ms: 1000,
  network_coalesced_telemetry: 800,
  network_queue_alloc_failures: 3,
};
const delay = ms => new Promise(done => setTimeout(done, ms));

async function freePort() {
  const listener = createServer();
  await new Promise((done, reject) => listener.once("error", reject).listen(0, "127.0.0.1", done));
  const port = listener.address().port;
  await new Promise(done => listener.close(done));
  assert.notEqual(port, 3000, "Never use the live dashboard port");
  return port;
}

async function waitUntil(check, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(label);
}

function payload(sequence, extra = {}) {
  return {
    type: "telemetry", device_id: DEVICE, boot_id: "v1138-test-boot", seq: sequence,
    ts: new Date().toISOString(), uptime_ms: 10000 + sequence * 1000,
    location: { valid: true, lat: 20.905712, lon: 105.82755, speed_kph: 36 },
    ecu: { online: true, speed_kph: 36, dtc_active: false },
    road: { valid: true, label: "duong_bang_phang", confidence: 0.99 },
    system: { sd_ok: true, sd_state: "online", wifi_rssi: -45, firmware_version: "11.3.8", ...extra },
  };
}

async function main() {
  const firmware = await readFile(join(PROJECT, "Arduino", "ESP32S3_Telematics", "ESP32S3_Telematics.ino"), "utf8");
  for (const field of Object.keys(DIAGNOSTICS)) {
    assert.ok(firmware.includes(`\\"${field}\\"`), `Test field ${field} must exist in firmware JSON`);
  }
  const exportsBefore = await readdir(join(PROJECT, "SD_Logs"), { recursive: true });
  const tempRoot = await mkdtemp(join(tmpdir(), "telematics-v1138-diagnostics-"));
  const databaseFile = join(tempRoot, "test.db");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(WEB, "server.mjs")], {
    cwd: WEB,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATABASE_FILE: databaseFile,
      INGEST_API_KEY: KEY, DEMO_SPEAKER_ENABLED: "false", DEMO_SPEAKER_DEVICE_ID: DEVICE },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise(done => child.once("exit", done));
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  let database;
  let collector;
  const abort = new AbortController();
  try {
    await waitUntil(async () => {
      try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok; }
      catch { return false; }
    }, "Disposable server did not become ready");
    const stream = await fetch(`${base}/api/stream?device_id=${DEVICE}`, { signal: abort.signal });
    assert.equal(stream.status, 200);
    let packets = "";
    collector = (async () => {
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          packets += decoder.decode(value, { stream: true });
        }
      } catch (error) { if (!abort.signal.aborted) throw error; }
    })();
    const post = async (body, expectedDuplicate = false) => {
      const response = await fetch(`${base}/api/telemetry`, { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 201);
      const result = await response.json();
      assert.equal(result.ok, true);
      assert.equal(result.duplicate, expectedDuplicate);
    };
    const sample = payload(1, DIAGNOSTICS);
    await post(sample);
    await post(sample, true);
    database = new DatabaseSync(databaseFile, { readOnly: true });
    const rows = database.prepare("SELECT raw_json FROM telemetry WHERE device_id=? AND sequence=1").all(DEVICE);
    assert.equal(rows.length, 1, "Retry must not duplicate the diagnostic sample");
    const stored = JSON.parse(rows[0].raw_json);
    for (const [field, expected] of Object.entries(DIAGNOSTICS)) assert.equal(stored.system[field], expected);
    await waitUntil(() => packets.includes('"kind":"telemetry"') && packets.includes('"sequence":1'),
      "Diagnostic sample did not produce the existing SSE invalidation");
    const dashboard = await (await fetch(`${base}/api/dashboard?device_id=${DEVICE}`)).json();
    assert.equal(dashboard.ok, true);
    assert.equal(dashboard.device_id, DEVICE);
    assert.equal(dashboard.latest.firmware_version, "11.3.8");
    assert.equal(dashboard.latest.sd_state, "online");
    assert.equal(dashboard.latest.sequence, 1);
    await post(payload(2));
    const legacy = database.prepare("SELECT raw_json FROM telemetry WHERE device_id=? AND sequence=2").get(DEVICE);
    for (const field of Object.keys(DIAGNOSTICS)) assert.equal(JSON.parse(legacy.raw_json).system[field], undefined);
    await waitUntil(() => packets.includes('"sequence":2'), "Legacy-compatible sample did not produce SSE");
    assert.deepEqual((await readdir(join(PROJECT, "SD_Logs"), { recursive: true })).sort(), exportsBefore.sort(),
      "Telemetry diagnostics must not create SD exports");
    console.log(`PASS V11.3.8: ${Object.keys(DIAGNOSTICS).length} firmware diagnostics preserved in raw JSON; HTTP, deduplication, dashboard, legacy compatibility and SSE passed (loopback port ${port}).`);
  } catch (error) {
    throw new Error(`${error.message}\n${output}`);
  } finally {
    abort.abort();
    if (collector) await collector;
    database?.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([exited, delay(3500)]);
    const safeTemp = resolve(tempRoot);
    assert.equal(dirname(safeTemp), resolve(tmpdir()));
    assert.ok(safeTemp.startsWith(join(resolve(tmpdir()), "telematics-v1138-diagnostics-")));
    await rm(safeTemp, { recursive: true, force: true });
  }
}

await main();
