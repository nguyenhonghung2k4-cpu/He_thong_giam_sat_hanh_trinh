// Shared by the public relay and the loopback PC bridge. No browser secrets.
const encoder = new TextEncoder();
export const DEVICE_PATHS = new Set([
  '/api/telemetry', '/api/events', '/api/direct-demo/realtime',
  '/api/device-commands/next', '/api/device-commands/result', '/api/sd/export-chunk',
]);
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g), pair => parseInt(pair, 16));
const secretBytes = secret => {
  if (typeof secret !== 'string' || secret.length < 32 || encoder.encode(secret).length > 1024)
    throw new Error('Connector secret must contain at least 32 characters.');
  return encoder.encode(secret);
};
function canonical(fields) {
  const { purpose, method, path, origin, runId, timestamp, bodyHash } = fields || {};
  const verb = String(method || '').toUpperCase(), time = String(timestamp ?? '');
  if (!['health','proxy'].includes(purpose) || !/^[A-Z]{3,10}$/.test(verb) ||
      typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > 16384 || /[\r\n\0]/.test(path) ||
      typeof origin !== 'string' || /[\r\n\0]/.test(origin) ||
      typeof runId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(runId) ||
      !/^\d{1,16}$/.test(time) || !Number.isSafeInteger(Number(time)) ||
      typeof bodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(bodyHash)) throw new Error('Invalid relay signature fields.');
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('Invalid public origin.');
  if (purpose === 'health' && (verb !== 'GET' || path !== '/__relay/health')) throw new Error('Invalid health purpose.');
  return `v1\n${purpose}\n${verb}\n${path}\n${origin}\n${runId}\n${time}\n${bodyHash}`;
}
export async function sha256Hex(bytes) {
  if (typeof bytes === 'string') bytes = encoder.encode(bytes);
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}
async function key(secret, operation) {
  return crypto.subtle.importKey('raw', secretBytes(secret), { name:'HMAC', hash:'SHA-256' }, false, [operation]);
}
export async function signRelay(secret, fields) {
  return hex(await crypto.subtle.sign('HMAC', await key(secret, 'sign'), encoder.encode(canonical(fields))));
}
export async function verifyRelay(secret, fields, { now = Date.now(), maxAgeMs = 30000 } = {}) {
  try {
    const signature = fields?.signature, time = Number(fields?.timestamp);
    if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) ||
        !Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 ||
        time > now + 5000 || now - time > maxAgeMs) return false;
    return await crypto.subtle.verify('HMAC', await key(secret, 'verify'), unhex(signature), encoder.encode(canonical(fields)));
  } catch { return false; }
}
