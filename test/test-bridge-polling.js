import assert from 'node:assert/strict';
import { createBridgePollingTimer } from '../dist/bridge/runtime.js';

let scans = 0;
const timer = createBridgePollingTimer(() => { scans++; }, 10);

try {
  assert.equal(timer.hasRef(), true,
    'request polling must keep the bridge alive if the filesystem watcher closes');
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.ok(scans > 0, 'the fallback poll must continue scanning without filesystem notifications');
  console.log('Bridge polling fallback tests passed.');
} finally {
  clearInterval(timer);
}
