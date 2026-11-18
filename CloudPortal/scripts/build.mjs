import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root,'.openai/hosting.json'),'utf8'));
if (!manifest.project_id || manifest.r2 !== 'BUCKET' || manifest.d1 !== null)
  throw new Error('Expected the existing Site identity and BUCKET-only relay manifest.');
await mkdir(join(root,'dist/server'),{recursive:true});
await mkdir(join(root,'dist/.openai'),{recursive:true});
for (const file of ['index.js','protocol.js','map-tiles.js']) await copyFile(join(root,'worker',file),join(root,'dist/server',file));
await copyFile(join(root,'.openai/hosting.json'),join(root,'dist/.openai/hosting.json'));
console.log('Built fixed public relay: Worker ESM + existing hosting manifest. No credentials or PC data packaged.');
