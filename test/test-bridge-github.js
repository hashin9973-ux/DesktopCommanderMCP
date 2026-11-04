import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitHubApiError, GitHubRepositoryClient, MAX_GITHUB_BRIDGE_FILE_BYTES } from '../dist/bridge/github.js';
import { createGuideIfMissing } from '../dist/bridge/runtime.js';
import { GitHubBridgeSync } from '../dist/bridge/github-sync.js';

// Test double for GitHub's Contents and Repositories REST APIs. No network calls are made.
function gitBlobSha(bytes) {
  return crypto.createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
}

function createGitHubApiDouble() {
  const files = new Map();
  const commits = [];
  const rawReads = new Map();
  let createdRepositoryPayload;
  const webhooks = new Map();
  let nextWebhookId = 1;
  let responseUploadGate;

  const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  const notFound = () => jsonResponse({ message: 'Not Found' }, 404);

  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);
    const prefix = '/repos/owner/repo/contents/';
    const repoPath = url.pathname.startsWith(prefix)
      ? decodeURIComponent(url.pathname.slice(prefix.length))
      : undefined;

    if (url.pathname === '/repos/owner/repo' && method === 'GET') {
      return jsonResponse({
        full_name: 'owner/repo',
        default_branch: 'main',
        archived: false,
        private: true,
        permissions: { push: true },
      });
    }

    if (url.pathname === '/repos/archived/repo' && method === 'GET') {
      return jsonResponse({
        full_name: 'archived/repo',
        default_branch: 'main',
        archived: true,
        permissions: { push: true },
      });
    }

    if (url.pathname === '/repos/read-only/repo' && method === 'GET') {
      return jsonResponse({
        full_name: 'read-only/repo',
        default_branch: 'main',
        archived: false,
        private: true,
        permissions: { push: false },
      });
    }

    if (url.pathname === '/repos/public/repo' && method === 'GET') {
      return jsonResponse({
        full_name: 'public/repo',
        default_branch: 'main',
        archived: false,
        private: false,
        permissions: { push: true },
      });
    }

    if (url.pathname === '/repos/owner/repo/hooks' && method === 'POST') {
      const payload = JSON.parse(String(init.body));
      const id = nextWebhookId++;
      webhooks.set(id, { id, ...payload });
      return jsonResponse({ id }, 201);
    }

    const hookMatch = /^\/repos\/owner\/repo\/hooks\/(\d+)$/.exec(url.pathname);
    if (hookMatch && method === 'PATCH') {
      const id = Number(hookMatch[1]);
      if (!webhooks.has(id)) return notFound();
      const payload = JSON.parse(String(init.body));
      webhooks.set(id, { id, ...payload });
      return jsonResponse({ id }, 200);
    }

    if (url.pathname === '/user/repos' && method === 'POST') {
      createdRepositoryPayload = JSON.parse(String(init.body));
      return jsonResponse({
        full_name: 'owner/private-mailbox',
        private: true,
        default_branch: 'main',
      }, 201);
    }

    if (url.pathname === '/user/repos' && method === 'GET') {
      return jsonResponse([
        {
          full_name: 'owner/repo',
          private: true,
          archived: false,
          permissions: { push: true },
        },
        {
          full_name: 'owner/read-only',
          private: true,
          archived: false,
          permissions: { push: false },
        },
      ]);
    }

    if (url.pathname === '/repos/owner/repo/contents' && method === 'GET') {
      return directoryListing('');
    }
    if (url.pathname === '/repos/owner/repo/contents/requests' && method === 'GET') {
      return directoryListing('requests');
    }
    if (url.pathname === '/repos/owner/repo/contents/responses' && method === 'GET') {
      return directoryListing('responses');
    }
    if (url.pathname === '/repos/owner/repo/contents/artifacts' && method === 'GET') {
      return directoryListing('artifacts');
    }

    if (repoPath && method === 'GET') {
      const value = files.get(repoPath);
      if (!value) return notFound();
      if ((headers.get('accept') || '').includes('raw')) {
        rawReads.set(repoPath, (rawReads.get(repoPath) || 0) + 1);
        return new Response(Buffer.from(value.bytes));
      }
      return jsonResponse({
        name: path.posix.basename(repoPath),
        path: repoPath,
        sha: value.sha,
        size: value.bytes.length,
        type: 'file',
        content: value.bytes.toString('base64'),
        encoding: 'base64',
      });
    }

    if (repoPath && method === 'PUT') {
      if (repoPath.startsWith('responses/') && responseUploadGate) {
        const gate = responseUploadGate;
        responseUploadGate = undefined;
        gate.signalStarted();
        await gate.wait;
      }
      const payload = JSON.parse(String(init.body));
      const existing = files.get(repoPath);
      if (existing && payload.sha !== existing.sha) {
        return jsonResponse({ message: 'sha does not match' }, 409);
      }
      if (!existing && payload.sha) {
        return jsonResponse({ message: 'file does not exist' }, 409);
      }
      const bytes = Buffer.from(payload.content, 'base64');
      const sha = gitBlobSha(bytes);
      files.set(repoPath, { bytes, sha });
      commits.push({ path: repoPath, branch: payload.branch, message: payload.message });
      return jsonResponse({ content: { path: repoPath, sha } }, existing ? 200 : 201);
    }

    if (repoPath && method === 'DELETE') {
      const payload = JSON.parse(String(init.body));
      const existing = files.get(repoPath);
      if (!existing) return notFound();
      if (payload.sha !== existing.sha) {
        return jsonResponse({ message: 'sha does not match' }, 409);
      }
      files.delete(repoPath);
      commits.push({ path: repoPath, branch: payload.branch, message: payload.message, deleted: true });
      return jsonResponse({ commit: { message: payload.message } });
    }

    return notFound();
  };

  function directoryListing(directory) {
    const entries = [];
    const prefix = directory ? directory + '/' : '';
    for (const [filePath, value] of files.entries()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      entries.push({
        name: rest,
        path: filePath,
        sha: value.sha,
        size: value.bytes.length,
        type: 'file',
      });
    }
    return jsonResponse(entries);
  }

  return {
    fetcher,
    files,
    commits,
    getRawReadCount: (filePath) => rawReads.get(filePath) || 0,
    getCreatedRepositoryPayload: () => createdRepositoryPayload,
    pauseNextResponseUpload: () => {
      let release;
      let signalStarted;
      const started = new Promise((resolve) => { signalStarted = resolve; });
      const wait = new Promise((resolve) => { release = resolve; });
      responseUploadGate = { wait, signalStarted };
      return { started, release };
    },
    webhooks,
  };
}

const api = createGitHubApiDouble();
const token = 'test-token';

const privateRepository = await GitHubRepositoryClient.createPrivateRepository(
  'private-mailbox',
  token,
  api.fetcher,
);
assert.equal(privateRepository, 'owner/private-mailbox');
assert.equal(api.getCreatedRepositoryPayload().private, true);
assert.equal(api.getCreatedRepositoryPayload().auto_init, true);
assert.equal(api.getCreatedRepositoryPayload().has_issues, false);

const listed = await GitHubRepositoryClient.listAccessibleRepositories(token, api.fetcher);
assert.equal(listed.length, 2);
assert.equal(listed[0].push, true);
assert.equal(listed[1].push, false);

const client = await GitHubRepositoryClient.connect('owner/repo', token, api.fetcher);
assert.equal(client.defaultBranch, 'main');
await assert.rejects(
  () => GitHubRepositoryClient.connect('archived/repo', token, api.fetcher),
  /archived/,
);
await assert.rejects(
  () => GitHubRepositoryClient.connect('read-only/repo', token, api.fetcher),
  /write access/,
);
const publicClient = await GitHubRepositoryClient.connect('public/repo', token, api.fetcher);
assert.equal(publicClient.isPrivate, false, 'public repository visibility must be returned for startup consent');

let rateLimitCalls = 0;
const rateLimitedClient = await GitHubRepositoryClient.connect('owner/repo', token, async () => {
  rateLimitCalls++;
  if (rateLimitCalls === 1) {
    return new Response(JSON.stringify({
      default_branch: 'main',
      archived: false,
      private: true,
      permissions: { push: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (rateLimitCalls === 2) {
    return new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }), {
      status: 403,
      headers: { 'content-type': 'application/json', 'retry-after': '1' },
    });
  }
  return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
});
await assert.rejects(
  () => rateLimitedClient.listDirectory('requests'),
  (error) => {
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.rateLimit?.kind, 'secondary');
    assert.ok(Number.isFinite(error.rateLimit?.retryAt));
    assert.match(error.message, /paused until/);
    return true;
  },
  'secondary rate-limit responses should expose their retry time',
);
const rateLimitWaitStartedAt = Date.now();
const recoveredListing = await rateLimitedClient.listDirectory('requests');
assert.deepEqual(recoveredListing, []);
assert.ok(Date.now() - rateLimitWaitStartedAt >= 800,
  'the next GitHub API request must honor Retry-After instead of immediately retrying');
assert.equal(rateLimitCalls, 3);

let primaryLimitCalls = 0;
const primaryResetEpoch = Math.ceil(Date.now() / 1_000) + 1;
const primaryRateLimitedClient = await GitHubRepositoryClient.connect('owner/repo', token, async () => {
  primaryLimitCalls++;
  if (primaryLimitCalls === 1) {
    return new Response(JSON.stringify({
      default_branch: 'main',
      archived: false,
      private: true,
      permissions: { push: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('[]', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(primaryResetEpoch),
    },
  });
});
assert.deepEqual(await primaryRateLimitedClient.listDirectory('requests'), []);
const primaryRateLimitWaitStartedAt = Date.now();
assert.deepEqual(await primaryRateLimitedClient.listDirectory('responses'), []);
assert.ok(Date.now() - primaryRateLimitWaitStartedAt >= 800,
  'a successful response with zero primary quota remaining must pause the next API request');
assert.equal(primaryLimitCalls, 3);

const webhookSecret = 'a'.repeat(64);
const initialHookId = await client.upsertPushWebhook(
  undefined,
  'https://quiet-marble-otter.trycloudflare.com/github-webhook/random-route',
  webhookSecret,
);
assert.equal(initialHookId, 1);
assert.equal(api.webhooks.size, 1);
assert.deepEqual(api.webhooks.get(initialHookId).events, ['push']);
assert.equal(api.webhooks.get(initialHookId).config.secret, webhookSecret);
assert.equal(api.webhooks.get(initialHookId).config.insecure_ssl, '0');

const updatedHookId = await client.upsertPushWebhook(
  initialHookId,
  'https://new-tunnel.trycloudflare.com/github-webhook/another-route',
  webhookSecret,
);
assert.equal(updatedHookId, initialHookId);
assert.equal(api.webhooks.size, 1, 'restarting the bridge should update its saved webhook rather than create duplicates');
assert.equal(api.webhooks.get(updatedHookId).config.url, 'https://new-tunnel.trycloudflare.com/github-webhook/another-route');

await assert.rejects(
  () => client.upsertPushWebhook(undefined, 'https://example.com/webhook', webhookSecret),
  /Cloudflare Quick Tunnel URL/,
);
await assert.rejects(
  () => client.upsertPushWebhook(undefined, 'https://tunnel.trycloudflare.com/webhook', 'short'),
  /at least 32 characters/,
);


const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-github-bridge-'));
const paths = {
  root: temporaryRoot,
  requests: path.join(temporaryRoot, 'requests'),
  responses: path.join(temporaryRoot, 'responses'),
  artifacts: path.join(temporaryRoot, 'artifacts'),
};

try {
  // Simulate a repository that already has both GitHub's initial README and
  // the legacy bridge-specific guide; initialization must leave only the AI README.
  const existingReadme = Buffer.from('# Existing repository README\n', 'utf8');
  const legacyGuide = Buffer.from('# Old bridge guide\n', 'utf8');
  api.files.set('README.md', { bytes: existingReadme, sha: gitBlobSha(existingReadme) });
  api.files.set('DESKTOP_COMMANDER_BRIDGE.md', { bytes: legacyGuide, sha: gitBlobSha(legacyGuide) });

  const sync = new GitHubBridgeSync(client, paths);
  await sync.initialize();
  assert.ok(api.files.has('requests/.gitkeep'));
  assert.ok(api.files.has('responses/.gitkeep'));
  assert.ok(api.files.has('artifacts/.gitkeep'));
  assert.ok(api.files.has('README.md'));
  assert.ok(!api.files.has('DESKTOP_COMMANDER_BRIDGE.md'),
    'initialization must remove the obsolete separate bridge guide');
  const generatedReadme = api.files.get('README.md').bytes.toString('utf8');
  assert.ok(generatedReadme.startsWith('# Desktop Commander Bridge\n'));
  assert.ok(generatedReadme.includes('## AI Quick Start'));
  assert.ok(generatedReadme.includes('## Tool catalog'));
  assert.ok(generatedReadme.includes('### read_file'));
  assert.ok(generatedReadme.includes('cloud-folder and GitHub repository transports'));
  assert.ok(!generatedReadme.includes('cloud-storage connector'));
  const expectedGuideRoot = path.join(temporaryRoot, 'expected-guide');
  await fs.mkdir(expectedGuideRoot, { recursive: true });
  await createGuideIfMissing(expectedGuideRoot);
  assert.deepEqual(
    api.files.get('README.md').bytes,
    await fs.readFile(path.join(expectedGuideRoot, 'README.md')),
    'GitHub mode must publish the exact README generated by cloud-folder mode',
  );
  await fs.rm(expectedGuideRoot, { recursive: true, force: true });
  const commitsAfterFirstInitialize = api.commits.length;
  await sync.initialize();
  assert.equal(api.commits.length, commitsAfterFirstInitialize,
    'routine initialization must not commit or rewrite already initialized queue directories or README');
  assert.equal(api.getRawReadCount('README.md'), 1,
    'routine initialization must use the local generated-guide digest instead of downloading README again');

  const requestBytes = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: 'sample-01',
    commands: [{ tool: 'get_config', arguments: {} }],
  }), 'utf8');
  const requestPath = 'requests/request-sample-01.json';
  api.files.set(requestPath, { bytes: requestBytes, sha: gitBlobSha(requestBytes) });

  await sync.syncOnce();
  assert.deepEqual(
    await fs.readFile(path.join(paths.requests, 'request-sample-01.json')),
    requestBytes,
    'new GitHub requests should be staged in the local worker queue',
  );
  assert.equal(api.getRawReadCount(requestPath), 1);

  await sync.syncOnce();
  assert.equal(api.getRawReadCount(requestPath), 1,
    'unchanged staged requests should not be downloaded again on every poll');

  const cachedRequestId = 'cached-at-startup';
  const cachedRequestPath = 'requests/request-' + cachedRequestId + '.json';
  const cachedRequestBytes = Buffer.from('already staged request bytes');
  api.files.set(cachedRequestPath, {
    bytes: cachedRequestBytes,
    sha: gitBlobSha(cachedRequestBytes),
  });
  await fs.writeFile(
    path.join(paths.requests, 'request-' + cachedRequestId + '.json'),
    cachedRequestBytes,
  );
  const cachedStartupSync = new GitHubBridgeSync(client, paths);
  const stagingLogs = [];
  const originalLog = console.log;
  console.log = (...args) => stagingLogs.push(args.join(' '));
  try {
    await cachedStartupSync.syncOnce();
    await cachedStartupSync.syncOnce();
  } finally {
    console.log = originalLog;
  }
  assert.equal(api.getRawReadCount(cachedRequestPath), 0,
    'a verified local cache entry must not be downloaded again after restart');
  assert.equal(stagingLogs.filter((message) => message.includes('request-' + cachedRequestId) && message.includes('staged locally')).length, 1,
    'a cached request should produce one staging checkpoint when first observed');

  const artifactPath = 'artifacts/sample-01/output.bin';
  const artifactBytes = Buffer.from([0, 1, 2, 3, 255]);
  const localArtifactPath = path.join(paths.root, ...artifactPath.split('/'));
  await fs.mkdir(path.dirname(localArtifactPath), { recursive: true });
  await fs.writeFile(localArtifactPath, artifactBytes);

  const requestHash = crypto.createHash('sha256').update(requestBytes).digest('hex');
  const response = {
    protocol_version: 1,
    id: 'sample-01',
    request_hash: requestHash,
    status: 'completed',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    results: [],
    artifacts: [{
      path: artifactPath,
      mimeType: 'application/octet-stream',
      bytes: artifactBytes.length,
      sha256: crypto.createHash('sha256').update(artifactBytes).digest('hex'),
    }],
  };
  const responsePath = path.join(paths.responses, 'response-sample-01.json');
  await fs.mkdir(paths.responses, { recursive: true });
  await fs.writeFile(responsePath, JSON.stringify(response));

  await sync.syncOnce();
  assert.deepEqual(api.files.get(artifactPath).bytes, artifactBytes);
  assert.ok(api.files.has('responses/response-sample-01.json'));
  assert.ok(
    api.commits.findIndex((commit) => commit.path === artifactPath)
      < api.commits.findIndex((commit) => commit.path === 'responses/response-sample-01.json'),
    'artifacts must be committed before the response completion marker',
  );
  await assert.rejects(
    () => fs.access(responsePath),
    /ENOENT/,
    'published response staging files should be removed locally',
  );
  await assert.rejects(
    () => fs.access(path.join(paths.requests, 'request-sample-01.json')),
    /ENOENT/,
    'published request staging files should be removed locally',
  );
  await sync.syncOnce();
  assert.equal(api.getRawReadCount(requestPath), 1,
    'unchanged completed requests should be skipped without downloading the request or response again');
  assert.equal(api.getRawReadCount('responses/response-sample-01.json'), 0);

  // Overwriting a request after its response exists must not re-execute it.
  // A changed blob under an already-completed ID should be explicitly diagnosed.
  const reusedRequestBytes = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: 'sample-01',
    commands: [{ tool: 'get_config', arguments: {} }],
  }), 'utf8');
  api.files.set(requestPath, { bytes: reusedRequestBytes, sha: gitBlobSha(reusedRequestBytes) });
  const duplicateIdWarnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => duplicateIdWarnings.push(args.join(' '));
  try {
    await sync.syncOnce();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(api.getRawReadCount(requestPath), 1,
    'a reused completed request ID must not be downloaded or executed again');
  assert.ok(duplicateIdWarnings.some((message) => message.toLowerCase().includes('request id') && message.toLowerCase().includes('cannot be reused')),
    'overwriting a completed request ID while the bridge is running must produce an explicit warning');

  // Hold the first local response upload after syncInternal has taken its
  // response-directory snapshot. A second response arriving during that pass
  // must trigger a follow-up pass rather than waiting for the poll timer.
  const uploadGate = api.pauseNextResponseUpload();
  const concurrentResponse = (id) => ({
    protocol_version: 1,
    id,
    request_hash: crypto.createHash('sha256').update(id).digest('hex'),
    status: 'completed',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    results: [],
    artifacts: [],
  });
  await fs.writeFile(
    path.join(paths.responses, 'response-sample-02.json'),
    JSON.stringify(concurrentResponse('sample-02')),
  );
  const firstConcurrentSync = sync.syncOnce();
  await uploadGate.started;
  await fs.writeFile(
    path.join(paths.responses, 'response-sample-03.json'),
    JSON.stringify(concurrentResponse('sample-03')),
  );
  const secondConcurrentSignal = sync.syncOnce();
  uploadGate.release();
  await Promise.all([firstConcurrentSync, secondConcurrentSignal]);
  assert.ok(api.files.has('responses/response-sample-02.json'));
  assert.ok(api.files.has('responses/response-sample-03.json'),
    'a response arriving during synchronization must be published by the queued follow-up pass');
  await assert.rejects(
    () => fs.access(path.join(paths.responses, 'response-sample-03.json')),
    /ENOENT/,
    'the follow-up pass should remove the second published response from local staging',
  );

  // A response larger than GitHub's per-file limit must keep its complete
  // tool output by externalizing JSON and publishing it as ordered chunks.
  const largeResponseId = 'large-response-01';
  const largeText = 'L'.repeat(MAX_GITHUB_BRIDGE_FILE_BYTES + 1_024);
  const largeContent = [{ type: 'text', text: largeText }];

  // Also exercise splitting an existing local artifact produced by the worker.
  // A sparse file keeps the fixture small while preserving a real >32 MiB size.
  const largeSourceArtifactPath = 'artifacts/' + largeResponseId + '/large-source.bin';
  const largeSourceLocalPath = path.join(paths.root, ...largeSourceArtifactPath.split('/'));
  const largeSourceBytes = 32 * 1024 * 1024 + 1;
  await fs.mkdir(path.dirname(largeSourceLocalPath), { recursive: true });
  const largeSourceHandle = await fs.open(largeSourceLocalPath, 'w');
  try {
    await largeSourceHandle.truncate(largeSourceBytes);
  } finally {
    await largeSourceHandle.close();
  }
  const zeroBlock = Buffer.alloc(1024 * 1024);
  const largeSourceHash = crypto.createHash('sha256');
  let sourceRemaining = largeSourceBytes;
  while (sourceRemaining > 0) {
    const length = Math.min(sourceRemaining, zeroBlock.length);
    largeSourceHash.update(zeroBlock.subarray(0, length));
    sourceRemaining -= length;
  }
  const largeSourceArtifact = {
    path: largeSourceArtifactPath,
    mimeType: 'application/octet-stream',
    bytes: largeSourceBytes,
    sha256: largeSourceHash.digest('hex'),
  };

  const largeResponse = {
    protocol_version: 1,
    id: largeResponseId,
    request_hash: crypto.createHash('sha256').update(largeResponseId).digest('hex'),
    status: 'completed',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    results: [{
      index: 0,
      tool: 'read_file',
      status: 'succeeded',
      isError: false,
      content: largeContent,
      artifacts: [largeSourceArtifact],
    }],
    artifacts: [largeSourceArtifact],
  };
  const largeResponsePath = path.join(paths.responses, 'response-' + largeResponseId + '.json');
  await fs.writeFile(largeResponsePath, JSON.stringify(largeResponse));
  await sync.syncOnce();

  const publishedLargeResponseBytes = api.files.get('responses/response-' + largeResponseId + '.json')?.bytes;
  assert.ok(publishedLargeResponseBytes, 'the compact response marker should be committed to GitHub');
  assert.ok(publishedLargeResponseBytes.length < MAX_GITHUB_BRIDGE_FILE_BYTES,
    'the response marker must stay below the GitHub per-file limit');
  const publishedLargeResponse = JSON.parse(publishedLargeResponseBytes.toString('utf8'));
  const publishedLargeResult = publishedLargeResponse.results[0];
  assert.match(publishedLargeResult.content[0].text, /too large to include in the response and was moved to a JSON artifact/,
    'oversized text content should be replaced with a retrieval instruction');
  const contentArtifact = publishedLargeResult.artifacts.find((artifact) => artifact.mimeType === 'application/json');
  assert.ok(contentArtifact?.parts?.length >= 2,
    'oversized JSON content should be represented by an ordered chunk list');

  const reconstructArtifact = (reference) => {
    assert.ok(Array.isArray(reference.parts) && reference.parts.length > 0,
      'chunked artifacts must expose their remote parts');
    const chunks = reference.parts.map((part) => {
      const stored = api.files.get(part.path);
      assert.ok(stored, 'each declared artifact part must be uploaded: ' + part.path);
      assert.equal(stored.bytes.length, part.bytes);
      assert.equal(crypto.createHash('sha256').update(stored.bytes).digest('hex'), part.sha256);
      assert.ok(stored.bytes.length <= 32 * 1024 * 1024,
        'each uploaded artifact file must remain under the transport chunk size');
      return stored.bytes;
    });
    const reconstructed = Buffer.concat(chunks);
    assert.equal(reconstructed.length, reference.bytes);
    assert.equal(crypto.createHash('sha256').update(reconstructed).digest('hex'), reference.sha256);
    return reconstructed;
  };

  assert.deepEqual(
    JSON.parse(reconstructArtifact(contentArtifact).toString('utf8')),
    largeContent,
    'reassembling the JSON artifact must restore the complete tool content',
  );
  const publishedSourceArtifact = publishedLargeResult.artifacts.find((artifact) => artifact.path === largeSourceArtifactPath);
  assert.ok(publishedSourceArtifact?.parts?.length >= 2,
    'a pre-existing local binary artifact larger than one chunk should be split before upload');
  const reconstructedSource = reconstructArtifact(publishedSourceArtifact);
  assert.equal(reconstructedSource.length, largeSourceBytes);
  assert.ok(reconstructedSource.every((byte) => byte === 0),
    'the original artifact bytes must be preserved across chunk uploads');
  await assert.rejects(
    () => fs.access(largeResponsePath),
    /ENOENT/,
    'the local response should be removed only after the response and all artifacts are durable remotely',
  );

  // A malformed response must be reported, but it must not prevent a
  // separate valid response in the same queue snapshot from being published.
  const invalidResponseId = 'invalid-response-01';
  const validResponseId = 'valid-response-02';
  await fs.writeFile(
    path.join(paths.responses, 'response-' + invalidResponseId + '.json'),
    '{invalid json',
  );
  await fs.writeFile(
    path.join(paths.responses, 'response-' + validResponseId + '.json'),
    JSON.stringify({
      protocol_version: 1,
      id: validResponseId,
      request_hash: crypto.createHash('sha256').update(validResponseId).digest('hex'),
      status: 'completed',
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:01.000Z',
      results: [],
      artifacts: [],
    }),
  );
  await assert.rejects(
    () => sync.syncOnce(),
    /Could not synchronize 1 local response file/,
  );
  assert.ok(api.files.has('responses/response-' + validResponseId + '.json'),
    'a malformed response must not block another response from the same sync pass');
  await fs.access(path.join(paths.responses, 'response-' + invalidResponseId + '.json'));
  await fs.rm(path.join(paths.responses, 'response-' + invalidResponseId + '.json'), { force: true });

  const restartRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-github-bridge-restart-'));
  try {
    const restartedPaths = {
      root: restartRoot,
      requests: path.join(restartRoot, 'requests'),
      responses: path.join(restartRoot, 'responses'),
      artifacts: path.join(restartRoot, 'artifacts'),
    };
    const restartedSync = new GitHubBridgeSync(client, restartedPaths);
    await restartedSync.initialize();
    await restartedSync.syncOnce();
    await assert.rejects(
      () => fs.access(path.join(restartedPaths.requests, 'request-sample-01.json')),
      /ENOENT/,
      'a request with an existing remote response must not be staged again after restart',
    );
    assert.equal(api.getRawReadCount(requestPath), 1,
      'a restarted bridge must not download a request whose response completion marker already exists');
    assert.equal(api.getRawReadCount('responses/response-sample-01.json'), 0,
      'a restarted bridge must not download historical completed responses');
    await restartedSync.syncOnce();
    assert.equal(api.getRawReadCount(requestPath), 1,
      'completed request history must remain excluded from every later synchronization');
    assert.equal(api.getRawReadCount('responses/response-sample-01.json'), 0,
      'completed response history must remain excluded from every later synchronization');
  } finally {
    await fs.rm(restartRoot, { recursive: true, force: true });
  }

  // A repository with a large completed history should require no per-item
  // request/response downloads. The remote directory indexes are sufficient
  // to identify response-backed, already completed request IDs.
  const historicalReadRequests = new Set();
  const historyCount = 2_000;
  for (let index = 0; index < historyCount; index++) {
    const id = 'history-' + String(index).padStart(4, '0');
    const requestName = 'requests/request-' + id + '.json';
    const responseName = 'responses/response-' + id + '.json';
    const oldRequest = Buffer.from('historical request ' + index);
    const oldResponse = Buffer.from('historical response ' + index);
    api.files.set(requestName, { bytes: oldRequest, sha: gitBlobSha(oldRequest) });
    api.files.set(responseName, { bytes: oldResponse, sha: gitBlobSha(oldResponse) });
    historicalReadRequests.add(requestName);
    historicalReadRequests.add(responseName);
  }
  const historySync = new GitHubBridgeSync(client, paths);
  await historySync.syncOnce();
  for (const remotePath of historicalReadRequests) {
    assert.equal(api.getRawReadCount(remotePath), 0,
      'completed history must be indexed without downloading ' + remotePath);
  }

  // Backslashes are path separators on Windows and must not allow a remote
  // response to escape the artifact cache root.
  await fs.mkdir(paths.responses, { recursive: true });
  await fs.writeFile(path.join(paths.responses, 'response-sample-01.json'), JSON.stringify({
    ...response,
    artifacts: [{
      path: 'artifacts/sample-01/..\\\\outside.bin',
      bytes: 1,
      sha256: 'not-used',
    }],
  }));
  await assert.rejects(
    () => sync.syncOnce(),
    /unsafe artifact path/,
    'artifact paths containing Windows traversal separators must be rejected',
  );
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log('GitHub repository bridge tests passed.');
