// Source-contract checks complement (not replace) the compiled C++ sequencer
// fault-injection test and a full Arduino build. No hardware claim is made.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('../Arduino/ESP32S3_Telematics/', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');
const ino = read('ESP32S3_Telematics.ino');
const cpp = read('alerts.cpp');
assert.match(ino, /void setup\(\)\s*\{\s*alertsEarlyMute\(\);/);
const setup = ino.slice(ino.indexOf('void setup()'));
assert(setup.indexOf('canBegin()') < setup.indexOf('runtimeConfigBegin()'), 'CAN must start before NVS');
assert(setup.indexOf('canBegin()') < setup.indexOf('alertsBegin()'), 'CAN must start before I2S priming');
const early = cpp.slice(cpp.indexOf('void alertsEarlyMute()'), cpp.indexOf('bool alertsBegin()'));
assert.match(early, /if \(earlyMuteDone\) return/);
assert.match(early, /const int pins\[\] = \{PIN_MAX98357_SD_EN,/);
assert(early.indexOf('gpio_set_level(') < early.indexOf('pinMode('));
const begin = cpp.slice(cpp.indexOf('bool alertsBegin()'), cpp.indexOf('void alertPothole()'));
assert(begin.indexOf('alertsEarlyMute();') < begin.indexOf('i2s_driver_install('));
assert(begin.indexOf('i2s_set_pin(') < begin.indexOf('!primeMutedI2s()'));
assert.match(begin, /if \(i2sReady && !primeMutedI2s\(\)\)\s*\{\s*i2sReady = false;/);
assert.match(begin, /if \(installResult == ESP_OK && !i2sReady\) i2s_driver_uninstall/);
assert(!/digitalWrite\(PIN_MAX98357_SD_EN, HIGH\)/.test(begin));
const voice = cpp.slice(cpp.indexOf('static bool playEmbeddedWav('), cpp.indexOf('static void finishAlert('));
assert(voice.indexOf('i2s_set_clk(') < voice.indexOf('if (!primeMutedI2s())'));
assert(voice.indexOf('if (!primeMutedI2s())') < voice.indexOf('digitalWrite(PIN_MAX98357_SD_EN, HIGH)'));
assert.match(voice, /if \(!primeMutedI2s\(\)\)\s*\{[^}]*return false;/);
assert.match(voice, /if \(!requestIsCurrent\(request\)\) return false;\s*digitalWrite\(PIN_MAX98357_SD_EN, HIGH\)/);
assert.match(cpp, /i2s_write\([^;]*pdMS_TO_TICKS\(150\)/);
assert.match(cpp, /result == ESP_OK && written == count/);
assert.match(cpp,/static bool enqueueAlert\(/);
assert.match(cpp,/if \(duplicate\) return false/);
assert.match(cpp,/request\.directSession\[0\] \|\| directDemoAudioCurrent/);
assert.match(cpp,/request\.directSession\[0\] && maximumMs > 150\) maximumMs = 150/);
assert.match(ino,/if\(!hazard\.warningReported\)/);
assert.match(ino,/if\(queued \|\| !current\)\s*\{\s*directDemoDismissWarning/);
assert(!ino.includes('[DIRECT] VOICE |'),'Admission is not proof of playback');
for (const name of ['config.h', 'config.example.h']) {
  // Never print a whole private config in assertion diagnostics.
  assert(/constexpr\s+uint8_t\s+AUDIO_PCM_GAIN_PERCENT\s*=\s*100\b/.test(read(name)), `${name}: PCM gain must remain 100`);
  assert(/11\.6\.1-MARKER-FIFO-FIX/.test(read(name)), `${name}: version must match release`);
}
console.log('PASS audio boot source contract: first-action mute, silent DMA before enable, fail-closed, bounded writes, full PCM gain preserved.');
