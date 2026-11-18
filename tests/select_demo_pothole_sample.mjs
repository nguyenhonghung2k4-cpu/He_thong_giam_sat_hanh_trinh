// Read-only search over REAL contiguous windows. Uses the supplied original
// run_classifier host probe; never synthesizes input or changes a score/model.
// Usage: node select_demo_pothole_sample.mjs <original CSV directory> <host probe> [stride rows=20]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const [sourceDir, probe, strideArg = '20'] = process.argv.slice(2);
if (!sourceDir || !probe) throw new Error('Provide original CSV directory and compiled host probe');
const stride = Number(strideArg);
if (!Number.isSafeInteger(stride) || stride < 1 || stride > 200) throw new Error('Stride must be 1..200 physical rows');
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const results = [];
let considered = 0, rejected = 0, evaluated = 0, aboveThreshold = 0;
for (const name of fs.readdirSync(sourceDir).filter(name => /^o_ga.*\.csv$/i.test(name)).sort()) {
  const bytes = fs.readFileSync(path.join(sourceDir, name));
  const lines = bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const rows = lines.map(line => {
    const fields = line.trim().split(',');
    return fields.length === 3 && fields.every(v => numeric.test(v.trim()) && Number.isFinite(Number(v)) && Math.abs(Number(v)) <= 16) ? fields.map(Number) : null;
  });
  const fileHash = sha(bytes);
  let batch = [];
  const runBatch = () => {
    if (!batch.length) return;
    const child = spawnSync(probe, [], { input: batch.map(c => c.values.join(' ')).join('\n') + '\n', encoding: 'utf8', maxBuffer: 2 ** 22 });
    if (child.status !== 0) throw new Error(child.error?.message || child.stderr || `probe status ${child.status}`);
    const outputs = child.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    if (outputs.length !== batch.length) throw new Error('probe/window count mismatch');
    outputs.forEach((result, index) => {
      if (result.status !== 0) throw new Error('run_classifier failed');
      evaluated++;
      const scores = result.scores;
      if (scores.o_ga >= 0.99 && scores.o_ga > scores.duong_bang_phang && scores.o_ga > scores.go_giam_toc) {
        aboveThreshold++;
        const c = batch[index];
        results.push({ file: name, source_sha256: fileHash, start_row: c.start_row, end_row: c.start_row + 199, energy_g2: c.energy, peak_centered_g: c.peak, scores });
      }
    });
    batch = [];
  };
  // Evaluate across the entire recording, not just the largest-energy impacts.
  // Every window preserves 200 physically adjacent rows; overlap is allowed.
  for (let start = 0; start + 200 <= rows.length; start += stride) {
    considered++;
    const window = rows.slice(start, start + 200);
    if (window.some(row => !row)) { rejected++; continue; }
    const means = [0, 0, 0];
    for (const row of window) row.forEach((v, i) => means[i] += v / 200);
    let energy = 0, peak = 0;
    for (const row of window) row.forEach((v, i) => { energy += (v - means[i]) ** 2; peak = Math.max(peak, Math.abs(v - means[i])); });
    batch.push({ start_row: start + 1, values: window.flat(), energy, peak });
    if (batch.length === 256) runBatch();
  }
  runBatch();
  process.stderr.write(`${name}: scanned ${rows.length} physical rows\n`);
}
// Prefer a visibly dynamic window among >=99% candidates; no waveform edits.
results.sort((a, b) => b.energy_g2 - a.energy_g2 || a.file.localeCompare(b.file) || a.start_row - b.start_row);
console.log(JSON.stringify({ considered, rejected, evaluated, aboveThreshold, stride_rows: stride, threshold: 0.99, selected: results[0] ?? null, top_candidates: results.slice(0, 20) }, null, 2));
