import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  extractQuickTunnelUrl,
  startCloudflareQuickTunnel,
  startGitHubWebhookServer,
} from '../dist/bridge/github-webhook.js';

const secret = 'test-webhook-secret-with-enough-randomness';
let syncCount = 0;
const errors = [];
const webhook = await startGitHubWebhookServer({
  repository: 'owner/repo',
  defaultBranch: 'main',
  secret,
  maxBodyBytes: 1_024,
  onPush: async () => { syncCount += 1; },
  onError: (error) => errors.push(error.message),
});

function signature(body) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

async function deliver(payload, {
  path = webhook.path,
  event = 'push',
  delivery = 'delivery-1',
  suppliedSignature,
} = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  return fetch(webhook.originUrl + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': delivery,
      'x-hub-signature-256': suppliedSignature || signature(body),
    },
    body,
  });
}

try {
  const wrongPath = await deliver({
    repository: { full_name: 'owner/repo' },
    ref: 'refs/heads/main',
  }, { path: '/github-webhook/not-the-random-route' });
  assert.equal(wrongPath.status, 404);

  const invalidSignature = await deliver({
    repository: { full_name: 'owner/repo' },
    ref: 'refs/heads/main',
  }, { suppliedSignature: 'sha256=' + '0'.repeat(64) });
  assert.equal(invalidSignature.status, 401);
  assert.equal(syncCount, 0);

  const wrongRepository = await deliver({
    repository: { full_name: 'someone/else' },
    ref: 'refs/heads/main',
  }, { delivery: 'delivery-other-repo' });
  assert.equal(wrongRepository.status, 202);

  const wrongBranch = await deliver({
    repository: { full_name: 'owner/repo' },
    ref: 'refs/heads/feature',
  }, { delivery: 'delivery-wrong-branch' });
  assert.equal(wrongBranch.status, 202);

  const ping = await deliver({ zen: 'Keep it logically awesome.' }, {
    event: 'ping',
    delivery: 'delivery-ping',
  });
  assert.equal(ping.status, 200);
  assert.equal(await ping.text(), 'pong');

  const payload = {
    repository: { full_name: 'owner/repo' },
    ref: 'refs/heads/main',
  };
  const accepted = await deliver(payload, { delivery: 'delivery-main-push' });
  assert.equal(accepted.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
  assert.equal(syncCount, 1, 'a valid default-branch push should trigger one synchronization');

  const duplicate = await deliver(payload, { delivery: 'delivery-main-push' });
  assert.equal(duplicate.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
  assert.equal(syncCount, 1, 'a duplicate delivery ID must not trigger a second synchronization');

  const oversized = await fetch(webhook.originUrl + webhook.path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-oversized',
      'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
    },
    body: 'x'.repeat(2_048),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(errors, []);
} finally {
  await webhook.close();
}

assert.equal(
  extractQuickTunnelUrl('Tunnel ready https://quiet-marble-otter.trycloudflare.com'),
  'https://quiet-marble-otter.trycloudflare.com',
);
assert.equal(extractQuickTunnelUrl('not a URL https://example.com'), undefined);
assert.equal(
  extractQuickTunnelUrl('https://quiet-marble-otter.trycloudflare.com.attacker.example'),
  undefined,
);


const fakeTunnelChild = new EventEmitter();
fakeTunnelChild.stdout = new PassThrough();
fakeTunnelChild.stderr = new PassThrough();
fakeTunnelChild.exitCode = null;
fakeTunnelChild.signalCode = null;
let tunnelSpawnCall;
fakeTunnelChild.kill = () => {
  fakeTunnelChild.signalCode = 'SIGTERM';
  fakeTunnelChild.emit('exit', null, 'SIGTERM');
  return true;
};

const tunnel = await startCloudflareQuickTunnel('http://127.0.0.1:43210', {
  executablePath: 'test-cloudflared',
  startupTimeoutMs: 1_000,
  spawnProcess: (executable, args, options) => {
    tunnelSpawnCall = { executable, args, options };
    setImmediate(() => {
      fakeTunnelChild.stderr.write('Your quick Tunnel has been created! Visit it at: https://quiet-marble-otter.trycloudflare.com');
    });
    return fakeTunnelChild;
  },
});
assert.equal(tunnel.url, 'https://quiet-marble-otter.trycloudflare.com');
assert.equal(tunnelSpawnCall.executable, 'test-cloudflared');
assert.deepEqual(tunnelSpawnCall.args, [
  'tunnel',
  '--url',
  'http://127.0.0.1:43210',
  '--no-autoupdate',
]);
assert.equal(tunnelSpawnCall.options.windowsHide, true);
await tunnel.close();

let invalidOriginSpawned = false;
await assert.rejects(
  () => startCloudflareQuickTunnel('http://0.0.0.0:43210', {
    spawnProcess: () => {
      invalidOriginSpawned = true;
      return fakeTunnelChild;
    },
  }),
  /must use plain HTTP on 127.0.0.1/,
);
assert.equal(invalidOriginSpawned, false, 'the tunnel must never proxy a non-loopback local origin');

console.log('GitHub webhook and Quick Tunnel tests passed.');
