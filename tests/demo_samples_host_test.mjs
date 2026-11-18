import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const base = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(base, '../WebDashboard_Online/demo_samples/manifest.json'), 'utf8'));
const executable = process.argv[2];
assert(executable, 'Usage: node demo_samples_host_test.mjs <compiled-probe.exe>');
const child = spawnSync(executable, [], {
  input: manifest.samples.map(sample => sample.values.join(' ')).join('\n') + '\n',
  encoding: 'utf8', maxBuffer: 1024 * 1024,
});
assert.equal(child.status, 0, child.error?.message || child.stderr);
const outputs = child.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
assert.equal(outputs.length, manifest.samples.length);
outputs.forEach((output, index) => {
  const sample = manifest.samples[index];
  assert.equal(output.status, 0, 'Edge Impulse classifier must return EI_IMPULSE_OK');
  const entries = Object.entries(output.scores);
  assert.deepEqual(entries.map(([label]) => label), manifest.model.labels);
  const [label, confidence] = entries.reduce((best, entry) => entry[1] > best[1] ? entry : best);
  assert.equal(label, sample.source_category, 'selected demo sample must actually infer its source category');
  assert(confidence >= 0.99, 'selected demo sample must reach >=99% in the real host classifier');
  for (const [key, value] of entries) {
    assert(Number.isFinite(value) && value >= 0 && value <= 1);
    assert(Math.abs(value - sample.host_validation.scores[key]) <= 0.02, 'host result changed beyond quantization tolerance');
  }
  console.log(`HOST ${sample.id}: actual run_classifier => ${label} ${(confidence * 100).toFixed(2)}%, scores=${JSON.stringify(output.scores)}`);
});
console.log('PASS real host inference. This is not a test of physical ESP32-S3, sensors, CAN, SD, speaker, or model generalization.');
