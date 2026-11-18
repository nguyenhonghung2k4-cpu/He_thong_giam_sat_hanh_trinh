import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_MODEL, DEMO_INFERENCE_TTL_MS, loadDemoSamples, normalizeInferenceResult } from '../WebDashboard_Online/demo-tinyml.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const manifest = loadDemoSamples(path.join(base, '../WebDashboard_Online/demo_samples/manifest.json'));
assert.equal(manifest.samples.length, 2);
assert.deepEqual(DEMO_MODEL, { frequency_hz: 100, frame_samples: 200, axes: 3, units: 'g' });
assert.equal(DEMO_INFERENCE_TTL_MS, 45000);

const baseResult = {
  inference_ok: true, frame_samples: 200, frequency_hz: 100,
  units: 'g', model_version: 'telematics-ei-1.0.1',
  label: 'o_ga', confidence: 0.83984375,
  scores: { duong_bang_phang: 0.11328125, go_giam_toc: 0.046875, o_ga: 0.83984375 },
  inference_ms: 11, x_g: 0.1, y_g: 0.2, z_g: 0.88, hazard_accepted: true,
};
const result = normalizeInferenceResult(baseResult);
assert.equal(result.label, 'o_ga');
assert.equal(result.hazard_accepted, true);
assert.equal(result.source, 'esp32s3_raw_sample_inference');
assert.deepEqual(result.scores, baseResult.scores);
assert.equal(normalizeInferenceResult({ ...baseResult, hazard_accepted: false }).hazard_accepted, false);
assert.equal(normalizeInferenceResult({ ...baseResult, label: 'duong_bang_phang', confidence: 0.99609375,
  scores: { duong_bang_phang: 0.99609375, go_giam_toc: 0, o_ga: 0 }, hazard_accepted: true }).hazard_accepted, false);

for (const changes of [
  { inference_ok: false }, { inference_ok: 'true' }, { frame_samples: 199 }, { frequency_hz: 50 },
  { units: 'm/s2' }, { model_version: 'other-model' }, { inference_ms: -1 }, { inference_ms: 0.5 },
  { label: 'pothole' }, { confidence: '0.84' }, { confidence: NaN }, { confidence: Infinity },
  { confidence: -0.1 }, { confidence: 1.1 }, { confidence: 0.2 },
  { scores: { duong_bang_phang: 0.99, go_giam_toc: 0, o_ga: 0.84 } },
  { scores: { duong_bang_phang: 0.1, go_giam_toc: null, o_ga: 0.84 } },
]) assert.throws(() => normalizeInferenceResult({ ...baseResult, ...changes }));

assert.throws(() => normalizeInferenceResult(manifest.samples[0].host_validation), /contract mismatch/,
  'saved host scores alone must never be accepted as ESP32-S3 result');
console.log('PASS demo TinyML contract: raw sample dimensions, strict firmware result, invalid/mismatched result rejection, no hazard for flat road');
