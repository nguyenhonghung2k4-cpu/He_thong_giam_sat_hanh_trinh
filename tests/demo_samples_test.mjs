import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

// Reject a bad row instead of removing it and accidentally stitching unrelated
// time intervals into an apparently valid model input window.
function parseStrictWindow(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line, row) => {
    const fields = line.split(',').map(value => value.trim());
    assert.equal(fields.length, 3, `CSV row ${row + 1}: expected x,y,z`);
    for (const value of fields) {
      assert(numeric.test(value), `CSV row ${row + 1}: malformed number '${value}'`);
      assert(Number.isFinite(Number(value)), `CSV row ${row + 1}: non-finite number`);
    }
    return fields.map(Number);
  });
}

assert.throws(() => parseStrictWindow('0,0,1\n-0.253.25350,0,1\n0,0,1\n'), /malformed number/);
assert.throws(() => parseStrictWindow('0,0,1\n\n0,0,1\n'), /expected x,y,z/);
assert.throws(() => parseStrictWindow('0,0,1\nNaN,0,1\n'), /malformed number/);
assert.throws(() => parseStrictWindow('0,0,1\n1e999,0,1\n'), /non-finite number/);
assert.deepEqual(parseStrictWindow('-0.25350,0.00000,0.88140\r\n'), [[-0.2535, 0, 0.8814]]);

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../WebDashboard_Online/demo_samples');
const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
assert.equal(manifest.model.frequency_hz, 100);
assert.equal(manifest.model.frame_samples, 200);
assert.equal(manifest.model.axes, 3);
assert.equal(manifest.model.units, 'g');
assert.deepEqual(manifest.model.labels, ['duong_bang_phang', 'go_giam_toc', 'o_ga']);
assert.equal(manifest.samples.length, 2);
assert.deepEqual(manifest.samples.map(sample => sample.id).sort(), ['pothole', 'speed_bump']);

for (const sample of manifest.samples) {
  assert.equal(sample.frequency_hz, manifest.model.frequency_hz);
  assert.equal(sample.frame_samples, manifest.model.frame_samples);
  assert.equal(sample.units, 'g');
  assert.equal(sample.values.length, manifest.model.frame_samples * manifest.model.axes);
  assert(sample.values.every(Number.isFinite));
  assert(sample.values.every(value => Math.abs(value) <= 16), 'outside original ADXL345 +/-16g range');
  assert.match(sample.source_file, /\.csv$/);
  assert(Number.isSafeInteger(sample.source_start_row) && sample.source_start_row >= 1);
  assert.equal(sample.source_end_row, sample.source_start_row + sample.frame_samples - 1);
  assert.match(sample.source_sha256, /^[a-f0-9]{64}$/);
  assert.match(sample.excerpt_sha256, /^[a-f0-9]{64}$/);
  const excerptPath = path.resolve(base, sample.excerpt_file);
  assert(excerptPath.startsWith(base + path.sep), 'excerpt must remain in demo_samples');
  const excerpt = fs.readFileSync(excerptPath);
  assert.equal(crypto.createHash('sha256').update(excerpt).digest('hex'), sample.excerpt_sha256);
  const rows = parseStrictWindow(excerpt.toString('utf8'));
  assert.equal(rows.length, sample.frame_samples);
  assert.deepEqual(rows.flat(), sample.values, 'JSON input must preserve every CSV value and axis order');
  assert.match(sample.notes, /training|huấn luyện|train/i, 'must not claim these are independent test data');
  console.log(`PASS ${sample.id}: ${sample.source_file}, original rows ${sample.source_start_row}-${sample.source_end_row}, ${rows.length} adjacent XYZ samples`);
}

// Optional local check against original full recordings, never required for
// users who only have the delivered ZIP. No modifications to source recordings.
const originalDir = process.env.DEMO_ORIGINAL_CSV_DIR;
if (originalDir) {
  for (const sample of manifest.samples) {
    const bytes = fs.readFileSync(path.join(originalDir, sample.source_file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sample.source_sha256);
    const lines = bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    const excerpt = lines.slice(sample.source_start_row - 1, sample.source_end_row).join('\n') + '\n';
    assert.equal(excerpt, fs.readFileSync(path.join(base, sample.excerpt_file), 'utf8'));
  }
  console.log('PASS original recording hashes and exact contiguous source rows');
}
console.log('PASS strict parser rejects malformed rows; bundled demo samples and provenance verified');
