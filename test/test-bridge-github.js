import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitHubApiError, GitHubRepositoryClient, MAX_GITHUB_BRIDGE_FILE_BYTES } from '../dist/bridge/github.js';
import { createGuideIfMissing } from '../dist/bridge/runtime.js';
import { GitHubBridgeSync } from '../dist/bridge/github-sync.js';
import { superviseBridgeWorker } from '../dist/bridge/github-runtime.js';
import { resolveRepositoryCacheRoots } from '../dist/bridge/github-runtime.js';
import { mailboxStore } from '../dist/mailbox.js';

// Test double for GitHub's Contents and Repositories REST APIs. No network calls are made.
function gitBlobSha(bytes) {
  return crypto.createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
}

function createGitHubApiDouble() {
  const files = new Map();
  const commits = [];
  const rawReads = new Map();
  const directoryListingCalls = [];
  let createdRepositoryPayload;
  const webhooks = new Map();
  let nextWebhookId = 1;
  let responseUploadGate;
  let staleHeadConflictPath;
  let truncateRecursiveTree = false;
  let failNextQueueTreeList = false;
  let queueTreeListGate;

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
        id: 1001,
        full_name: 'owner/repo',
        default_branch: 'main',
        archived: false,
        private: true,
        permissions: { push: true },
      });
    }

    if (url.pathname === '/repos/archived/repo' && method === 'GET') {
      return jsonResponse({
        id: 1002,
        full_name: 'archived/repo',
        default_branch: 'main',
        archived: true,
        permissions: { push: true },
      });
    }

    if (url.pathname === '/repos/read-only/repo' && method === 'GET') {
      return jsonResponse({
        id: 1003,
        full_name: 'read-only/repo',
        default_branch: 'main',
        archived: false,
        private: true,
        permissions: { push: false },
      });
    }

    if (url.pathname === '/repos/public/repo' && method === 'GET') {
      return jsonResponse({
        id: 1004,
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

    if (url.pathname === '/repos/owner/repo/commits/main' && method === 'GET') {
      return jsonResponse({ commit: { tree: { sha: 'root-tree-sha' } } });
    }

    const treeMatch = /^\/repos\/owner\/repo\/git\/trees\/([^/]+)$/.exec(url.pathname);
    if (treeMatch && method === 'GET') {
      const treeSha = decodeURIComponent(treeMatch[1]);
      const prefixPath = treeSha === 'root-tree-sha' ? '' : treeSha.startsWith('tree:') ? treeSha.slice(5) : undefined;
      if (prefixPath === undefined) return notFound();
      const recursive = url.searchParams.get('recursive') === '1';
      if (treeSha === 'root-tree-sha' && recursive && queueTreeListGate) {
        const gate = queueTreeListGate;
        queueTreeListGate = undefined;
        gate.signalStarted();
        await gate.wait;
      }
      if (treeSha === 'root-tree-sha' && recursive && failNextQueueTreeList) {
        failNextQueueTreeList = false;
        return jsonResponse({ message: 'temporary tree listing failure' }, 500);
      }
      if (treeSha === 'root-tree-sha' && recursive && truncateRecursiveTree) {
        return jsonResponse({ sha: treeSha, truncated: true, tree: [] });
      }

      const matchingFiles = [...files.entries()].filter(([filePath]) =>
        !prefixPath || filePath.startsWith(prefixPath + '/'),
      );
      if (recursive) {
        return jsonResponse({
          sha: treeSha,
          truncated: false,
          tree: matchingFiles.map(([filePath, value]) => ({
            path: prefixPath ? filePath.slice(prefixPath.length + 1) : filePath,
            type: 'blob',
            mode: '100644',
            sha: value.sha,
            size: value.bytes.length,
          })),
        });
      }

      const children = new Map();
      for (const [filePath, value] of matchingFiles) {
        const relative = prefixPath ? filePath.slice(prefixPath.length + 1) : filePath;
        if (!relative) continue;
        const separator = relative.indexOf('/');
        const childName = separator === -1 ? relative : relative.slice(0, separator);
        if (children.has(childName)) continue;
        if (separator === -1) {
          children.set(childName, {
            path: childName, type: 'blob', mode: '100644', sha: value.sha, size: value.bytes.length,
          });
        } else {
          const childPrefix = prefixPath ? prefixPath + '/' + childName : childName;
          children.set(childName, {
            path: childName, type: 'tree', mode: '040000', sha: 'tree:' + childPrefix,
          });
        }
      }
      return jsonResponse({ sha: treeSha, truncated: false, tree: [...children.values()] });
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
      if (repoPath === staleHeadConflictPath) {
        staleHeadConflictPath = undefined;
        return jsonResponse({ message: 'Update is not a fast forward' }, 422);
      }
      if (repoPath.includes('/responses/') && responseUploadGate) {
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
    directoryListingCalls.push(directory);
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
    getDirectoryListingCalls: () => [...directoryListingCalls],
    resetDirectoryListingCalls: () => { directoryListingCalls.length = 0; },
    getCreatedRepositoryPayload: () => createdRepositoryPayload,
    conflictNextCreateFile: (filePath) => { staleHeadConflictPath = filePath; },
    truncateNextRecursiveTree: () => { truncateRecursiveTree = true; },
    restoreRecursiveTree: () => { truncateRecursiveTree = false; },
    failNextQueueTreeList: () => { failNextQueueTreeList = true; },
    pauseNextQueueTreeList: () => {
      let release;
      let signalStarted;
      const started = new Promise((resolve) => { signalStarted = resolve; });
      const wait = new Promise((resolve) => { release = resolve; });
      queueTreeListGate = { wait, signalStarted };
      return { started, release };
    },
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
assert.equal(client.repositoryId, 1001, 'the connected repository exposes its immutable GitHub ID');
api.conflictNextCreateFile('agent-default/responses/stale-head-retry.json');
assert.equal(await client.createFileIfAbsent(
  'agent-default/responses/stale-head-retry.json',
  Buffer.from('retry after stale branch head'),
  'Test stale branch retry',
), true, 'a 422 stale-head conflict with an absent target must be retried');
assert.equal(api.files.get('agent-default/responses/stale-head-retry.json').bytes.toString('utf8'), 'retry after stale branch head');

api.truncateNextRecursiveTree();
const recoveredTreeListing = await client.listQueueFiles();
assert.ok(Array.isArray(recoveredTreeListing.requests));
assert.ok(Array.isArray(recoveredTreeListing.responses));
api.restoreRecursiveTree();
const dottedAgentRequest = Buffer.from(JSON.stringify({
  protocol_version: 1,
  id: 'dotted-id',
  commands: [{ tool: 'get_config', arguments: {} }],
}), 'utf8');
api.files.set('agent-client.one_test/requests/dotted-id.json', {
  bytes: dottedAgentRequest, sha: gitBlobSha(dottedAgentRequest),
});
const dottedQueue = await client.listQueueFiles();
assert.ok(dottedQueue.requests.some(entry =>
  entry.path === 'agent-client.one_test/requests/dotted-id.json'),
'GitHub queue discovery must accept valid root-level agent IDs containing dots and underscores');

const nestedRequestPath = 'agent-parent/subagents/agent-child/requests/child-task.json';
const nestedResponsePath = 'agent-parent/subagents/agent-child/responses/child-task.json';
const nestedArtifactPath = 'agent-parent/subagents/agent-child/artifacts/child-task/result.txt';
const nestedDeletionPath = 'agent-parent/subagents/agent-child/.subagent-deleted.json';
const nestedRequest = Buffer.from(JSON.stringify({
  protocol_version: 1,
  id: 'child-task',
  commands: [{ tool: 'get_config', arguments: {} }],
}), 'utf8');
const nestedResponse = Buffer.from(JSON.stringify({
  protocol_version: 1,
  id: 'child-task',
  request_hash: 'test-hash',
  status: 'completed',
  results: [],
}), 'utf8');
const nestedArtifact = Buffer.from('nested subagent artifact');
const nestedDeletionMarker = Buffer.from(JSON.stringify({
  id: 'agent-child',
  deleted_at: new Date(0).toISOString(),
}) + '\n');
for (const [filePath, bytes] of [
  [nestedRequestPath, nestedRequest],
  [nestedResponsePath, nestedResponse],
  [nestedArtifactPath, nestedArtifact],
  [nestedDeletionPath, nestedDeletionMarker],
]) {
  api.files.set(filePath, { bytes, sha: gitBlobSha(bytes) });
}
const nestedQueue = await client.listQueueFiles();
assert.ok(nestedQueue.requests.some(entry => entry.path === nestedRequestPath),
  'GitHub queue discovery must recognize requests below parent/subagents/agent-child');
assert.ok(nestedQueue.responses.some(entry => entry.path === nestedResponsePath),
  'GitHub queue discovery must recognize nested child responses');
assert.ok(nestedQueue.agentDirectories.includes('agent-parent/subagents/agent-child'),
  'GitHub queue discovery must record the complete hierarchical child identity');
assert.ok(nestedQueue.workspaceFiles.some(entry => entry.path === nestedArtifactPath),
  'GitHub queue discovery must index all nested workspace files for recursive deletion');
assert.ok(nestedQueue.deletedAgents.includes('agent-parent/subagents/agent-child'),
  'GitHub queue discovery must identify deletion markers at nested workspace roots');
for (const filePath of [nestedRequestPath, nestedResponsePath, nestedArtifactPath, nestedDeletionPath]) {
  api.files.delete(filePath);
}
api.files.delete('agent-client.one_test/requests/dotted-id.json');
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
assert.equal(publicClient.repositoryId, 1004);

await assert.rejects(
  () => GitHubRepositoryClient.connect('owner/repo', token, async () => new Response(JSON.stringify({
    default_branch: 'main',
    archived: false,
    private: true,
    permissions: { push: true },
  }), { status: 200, headers: { 'content-type': 'application/json' } })),
  /valid immutable repository ID/,
  'repository metadata without an immutable ID must not create an unisolated cache identity',
);


let rateLimitCalls = 0;
const rateLimitedClient = await GitHubRepositoryClient.connect('owner/repo', token, async () => {
  rateLimitCalls++;
  if (rateLimitCalls === 1) {
    return new Response(JSON.stringify({
      id: 1001,
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

const webhookSecretForRateLimitTest = 'b'.repeat(64);
let webhookRateLimitCalls = 0;
const webhookRateLimitedClient = await GitHubRepositoryClient.connect('owner/repo', token, async () => {
  webhookRateLimitCalls++;
  if (webhookRateLimitCalls === 1) {
    return new Response(JSON.stringify({
      id: 1001,
      default_branch: 'main',
      archived: false,
      private: true,
      permissions: { push: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'retry-after': '1' },
  });
});
await assert.rejects(
  () => webhookRateLimitedClient.upsertPushWebhook(
    undefined,
    'https://quiet-marble-otter.trycloudflare.com/github-webhook/rate-limit-test',
    webhookSecretForRateLimitTest,
  ),
  (error) => {
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.rateLimit?.kind, 'secondary',
      'webhook registration must preserve 403 rate-limit metadata instead of disguising it as missing permission');
    return true;
  },
);

let primaryLimitCalls = 0;
const primaryResetEpoch = Math.ceil(Date.now() / 1_000) + 1;
const primaryRateLimitedClient = await GitHubRepositoryClient.connect('owner/repo', token, async () => {
  primaryLimitCalls++;
  if (primaryLimitCalls === 1) {
    return new Response(JSON.stringify({
      id: 1001,
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
};
const defaultPaths = {
  root: path.join(paths.root, 'agent-default'),
  requests: path.join(paths.root, 'agent-default', 'requests'),
  responses: path.join(paths.root, 'agent-default', 'responses'),
  artifacts: path.join(paths.root, 'agent-default', 'artifacts'),
};

try {
  // Simulate a repository that already has both GitHub's initial README and
  // the legacy bridge-specific guide; initialization must leave only the AI README.
  const existingReadme = Buffer.from('# Existing repository README\n', 'utf8');
  const legacyGuide = Buffer.from('# Old bridge guide\n', 'utf8');
  api.files.set('README.md', { bytes: existingReadme, sha: gitBlobSha(existingReadme) });
  api.files.set('DESKTOP_COMMANDER_BRIDGE.md', { bytes: legacyGuide, sha: gitBlobSha(legacyGuide) });

  const legacyRequestBytes = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: 'legacy-pending',
    commands: [{ tool: 'get_config', arguments: {} }],
  }), 'utf8');
  const legacyResponseBytes = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: 'legacy-completed',
    request_hash: crypto.createHash('sha256').update('legacy-completed').digest('hex'),
    status: 'completed',
    results: [],
    artifacts: [{ path: 'artifacts/legacy-completed/output.bin', bytes: 4, sha256: 'legacy-hash' }],
  }), 'utf8');
  const legacyArtifactBytes = Buffer.from([4, 3, 2, 1]);
  for (const directory of ['requests', 'responses', 'artifacts']) {
    const sentinel = directory === 'responses'
      ? Buffer.from('user-owned sentinel\n')
      : Buffer.from('legacy queue sentinel\n');
    api.files.set(directory + '/.gitkeep', { bytes: sentinel, sha: gitBlobSha(sentinel) });
  }
  api.files.set('requests/legacy-pending.json', {
    bytes: legacyRequestBytes, sha: gitBlobSha(legacyRequestBytes),
  });
  api.files.set('responses/legacy-completed.json', {
    bytes: legacyResponseBytes, sha: gitBlobSha(legacyResponseBytes),
  });
  api.files.set('artifacts/legacy-completed/output.bin', {
    bytes: legacyArtifactBytes, sha: gitBlobSha(legacyArtifactBytes),
  });

  // Upgrade the previous nested agents/<name>/ layout into root-level
  // agent-<name>/ folders, including artifacts referenced by old responses.
  const previousAgentRequest = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: 'previous-agent-pending',
    commands: [{ tool: 'get_config', arguments: {} }],
  }), 'utf8');
  const previousAgentResponse = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: 'previous-agent-completed',
    request_hash: 'previous-agent-hash',
    status: 'completed',
    results: [],
    artifacts: [{
      path: 'artifacts/previous-agent-completed/output.bin',
      bytes: 4,
      sha256: crypto.createHash('sha256').update(legacyArtifactBytes).digest('hex'),
    }],
  }), 'utf8');
  const previousAgentsSentinel = Buffer.from('Desktop Commander agent-scoped queues.\n', 'utf8');
  api.files.set('agents/.gitkeep', {
    bytes: previousAgentsSentinel, sha: gitBlobSha(previousAgentsSentinel),
  });
  const previousAgentsUserFile = Buffer.from('user-owned note\n', 'utf8');
  api.files.set('agents/keep-me.txt', {
    bytes: previousAgentsUserFile, sha: gitBlobSha(previousAgentsUserFile),
  });
  api.files.set('agents/chatgpt-old/requests/previous-agent-pending.json', {
    bytes: previousAgentRequest, sha: gitBlobSha(previousAgentRequest),
  });
  api.files.set('agents/chatgpt-old/responses/previous-agent-completed.json', {
    bytes: previousAgentResponse, sha: gitBlobSha(previousAgentResponse),
  });
  api.files.set('agents/chatgpt-old/artifacts/previous-agent-completed/output.bin', {
    bytes: legacyArtifactBytes, sha: gitBlobSha(legacyArtifactBytes),
  });
  const legacyNamedRequestBytes = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: 'legacy-named-request',
    commands: [{ tool: 'get_config', arguments: {} }],
  }), 'utf8');
  api.files.set('agents/legacy_agent.v2/requests/legacy-named-request.json', {
    bytes: legacyNamedRequestBytes, sha: gitBlobSha(legacyNamedRequestBytes),
  });

  const workerStateDirectory = process.platform === 'win32'
    ? path.join(temporaryRoot, 'worker-state', 'localappdata', 'DesktopCommanderBridge')
    : path.join(temporaryRoot, 'worker-state', 'xdg-state', 'desktop-commander-bridge');
  const previousLocalAgentRoot = path.join(paths.root, 'agents', 'chatgpt-cache-old');
  const previousLocalRequests = path.join(previousLocalAgentRoot, 'requests');
  const previousLocalResponses = path.join(previousLocalAgentRoot, 'responses');
  const previousLocalArtifacts = path.join(previousLocalAgentRoot, 'artifacts', 'cached-task');
  const previousLocalLedger = path.join(workerStateDirectory, 'requests', 'chatgpt-cache-old');
  await Promise.all([
    fs.mkdir(previousLocalRequests, { recursive: true }),
    fs.mkdir(previousLocalResponses, { recursive: true }),
    fs.mkdir(previousLocalArtifacts, { recursive: true }),
    fs.mkdir(previousLocalLedger, { recursive: true }),
  ]);
  const previousLocalRequestBytes = Buffer.from('cached local request');
  const previousLocalResponseBytes = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: 'cached-task',
    request_hash: 'cached-request-hash',
    status: 'completed',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    results: [],
    artifacts: [],
  }), 'utf8');
  const previousLocalArtifactBytes = Buffer.from([9, 8, 7, 6]);
  const previousLocalLedgerBytes = Buffer.from('cached local processing ledger');
  await Promise.all([
    fs.writeFile(path.join(previousLocalRequests, 'cached-task.json'), previousLocalRequestBytes),
    fs.writeFile(path.join(previousLocalResponses, 'cached-task.json'), previousLocalResponseBytes),
    fs.writeFile(path.join(previousLocalArtifacts, 'result.bin'), previousLocalArtifactBytes),
    fs.writeFile(path.join(previousLocalLedger, 'cached-task.json'), previousLocalLedgerBytes),
  ]);
  const sync = new GitHubBridgeSync(client, paths, workerStateDirectory);
  api.resetDirectoryListingCalls();
  await sync.initialize();
  assert.deepEqual(
    await fs.readFile(path.join(paths.root, 'agent-chatgpt-cache-old', 'requests', 'cached-task.json')),
    previousLocalRequestBytes,
    'old local GitHub cache requests must move to root-level conversation folders',
  );
  assert.deepEqual(
    await fs.readFile(path.join(paths.root, 'agent-chatgpt-cache-old', 'responses', 'cached-task.json')),
    previousLocalResponseBytes,
    'old local GitHub cache responses must be preserved with their conversation',
  );
  assert.deepEqual(
    await fs.readFile(path.join(paths.root, 'agent-chatgpt-cache-old', 'artifacts', 'cached-task', 'result.bin')),
    previousLocalArtifactBytes,
    'old local GitHub cache artifacts must follow the same conversation folder',
  );
  assert.deepEqual(
    await fs.readFile(path.join(workerStateDirectory, 'requests', 'agent-chatgpt-cache-old', 'cached-task.json')),
    previousLocalLedgerBytes,
    'old local GitHub idempotency ledgers must follow their conversation cache',
  );
  await assert.rejects(() => fs.access(path.join(paths.root, 'agents')), { code: 'ENOENT' },
    'the obsolete local cache agents/ wrapper is removed when all known data migrates');
  assert.deepEqual(api.getDirectoryListingCalls().filter(Boolean), [],
    'initialization must not list the requests/responses directories through the 1,000-entry-limited Contents API');
  assert.ok(!api.files.has('agent-default/.gitkeep'),
    'the bridge must not create a synthetic shared conversation folder');
  assert.ok(!api.files.has('requests/.gitkeep'));
  assert.deepEqual(api.files.get('responses/.gitkeep')?.bytes, Buffer.from('user-owned sentinel\n'),
    'migration must preserve a same-named legacy sentinel with unknown user-owned content');
  assert.ok(!api.files.has('artifacts/.gitkeep'));
  const legacyCompatibilityAgent = [...api.files.keys()]
    .map(filePath => filePath.split('/')[0])
    .find(agentId => /^agent-legacy-flat-[0-9a-f]{32}$/.test(agentId));
  assert.ok(legacyCompatibilityAgent,
    'the existing agent-default identity must not receive unscoped flat queue data');
  const migratedLegacyRequest = legacyCompatibilityAgent + '/requests/legacy-pending.json';
  const migratedLegacyResponse = legacyCompatibilityAgent + '/responses/legacy-completed.json';
  const migratedLegacyArtifact = legacyCompatibilityAgent + '/artifacts/legacy-completed/output.bin';
  assert.ok(api.files.has(migratedLegacyRequest));
  assert.ok(api.files.has(migratedLegacyResponse));
  assert.ok(api.files.has(migratedLegacyArtifact));
  assert.ok(
    api.commits.findIndex((commit) => commit.path === migratedLegacyArtifact)
      < api.commits.findIndex((commit) => commit.path === migratedLegacyResponse),
    'legacy artifacts must be committed before the migrated response completion marker',
  );
  assert.ok(api.files.has('agent-default/responses/stale-head-retry.json'),
    'the pre-existing agent-default conversation and its request/response state must be preserved');
  assert.ok(!api.files.has('requests/legacy-pending.json'));
  assert.ok(!api.files.has('responses/legacy-completed.json'));
  assert.ok(!api.files.has('artifacts/legacy-completed/output.bin'),
    'legacy remote files are removed only after their compatibility-folder copies are verified');
  assert.ok(api.files.has('agent-chatgpt-old/requests/previous-agent-pending.json'));
  assert.ok(api.files.has('agent-chatgpt-old/responses/previous-agent-completed.json'));
  assert.ok(api.files.has('agent-chatgpt-old/artifacts/previous-agent-completed/output.bin'));
  assert.ok(api.files.has('agent-legacy_agent.v2/requests/legacy-named-request.json'),
    'legacy folder names containing dots and underscores must migrate without changing identity');
  assert.ok(!api.files.has('agents/legacy_agent.v2/requests/legacy-named-request.json'));
  assert.ok(!api.files.has('agents/chatgpt-old/requests/previous-agent-pending.json'));
  assert.ok(!api.files.has('agents/chatgpt-old/responses/previous-agent-completed.json'));
  assert.ok(!api.files.has('agents/chatgpt-old/artifacts/previous-agent-completed/output.bin'));
  assert.ok(!api.files.has('agents/.gitkeep'));
  assert.deepEqual(api.files.get('agents/keep-me.txt')?.bytes, previousAgentsUserFile,
    'migration must preserve unrelated files in the old agents namespace');
  assert.ok(api.files.has('README.md'));
  assert.ok(!api.files.has('DESKTOP_COMMANDER_BRIDGE.md'),
    'initialization must remove the obsolete separate bridge guide');
  const generatedReadme = api.files.get('README.md').bytes.toString('utf8');
  assert.ok(generatedReadme.startsWith('# Desktop Commander Bridge\n'));
  assert.ok(generatedReadme.includes('## AI Quick Start'));
  assert.ok(generatedReadme.includes('<your-workspace>/requests/'));
  assert.ok(generatedReadme.includes('<your-workspace>/responses/'));
  assert.ok(generatedReadme.includes('agent-<parent>/subagents/agent-<child>'));
  assert.ok(generatedReadme.includes('## Tool catalog'));
  assert.ok(!generatedReadme.includes('mailbox_user_id'));
  assert.ok(!generatedReadme.includes('## Optional local mailbox'));
  assert.ok(generatedReadme.includes('## Transport behavior'));
  assert.ok(generatedReadme.includes('### Cloud-folder synchronization'));
  assert.ok(generatedReadme.includes('### GitHub Repository Bridge'));
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

  // Unread-mail markers are paired workspace metadata. They are never
  // interpreted as executable request/response queue files.
  const notifyParent = 'agent-notify-parent';
  const notifyChild = notifyParent + '/subagents/agent-notify-child';
  const notificationMessages = [];
  const notificationRoots = [
    path.join(paths.root, notifyParent),
    path.join(paths.root, notifyParent, 'subagents', 'agent-notify-child'),
  ];
  for (const root of notificationRoots) {
    for (const directory of ['requests', 'responses', 'artifacts']) {
      await fs.mkdir(path.join(root, directory), { recursive: true });
    }
  }
  try {
    notificationMessages.push(await mailboxStore.send(notifyChild, notifyParent, 'First notification.'));
    notificationMessages.push(await mailboxStore.send(notifyChild, notifyParent, 'Second notification.'));
    notificationMessages.push(await mailboxStore.send(notifyChild, notifyParent, 'Third notification.'));
    await sync.syncOnce();

    const markerPath = count => notifyParent + '/requests/unread-messages-' + count + '.txt';
    const responseMarkerPath = count => notifyParent + '/responses/unread-messages-' + count + '.txt';
    const requestMarkerThree = api.files.get(markerPath(3));
    const responseMarkerThree = api.files.get(responseMarkerPath(3));
    assert.ok(requestMarkerThree && responseMarkerThree, 'both queue folders receive the unread count marker');
    assert.deepEqual(requestMarkerThree.bytes, responseMarkerThree.bytes,
      'requests and responses markers contain identical bytes');
    assert.match(requestMarkerThree.bytes.toString('utf8'), /Unread mailbox messages: 3/);

    const discoveredWithMarkers = await client.listQueueFiles();
    assert.ok(discoveredWithMarkers.workspaceFiles.some(entry => entry.path === markerPath(3)),
      'notification markers are discovered as ordinary workspace metadata');
    assert.ok(!discoveredWithMarkers.requests.some(entry => entry.path === markerPath(3)),
      'a .txt marker is never staged as an executable request');
    assert.ok(!discoveredWithMarkers.responses.some(entry => entry.path === responseMarkerPath(3)),
      'a .txt marker is never treated as a response completion record');

    const firstBatch = await mailboxStore.inboxUnread(notifyParent, 1);
    assert.equal(firstBatch.messages.length, 1);
    assert.equal(firstBatch.unreadCount, 2);
    await sync.syncOnce();
    assert.ok(api.files.has(markerPath(2)) && api.files.has(responseMarkerPath(2)),
      'partial inbox reads publish the reduced unread count to both queues');
    assert.ok(!api.files.has(markerPath(3)) && !api.files.has(responseMarkerPath(3)),
      'superseded count markers are deleted from both remote queues');
    assert.deepEqual(api.files.get(markerPath(2)).bytes, api.files.get(responseMarkerPath(2)).bytes);

    const rest = await mailboxStore.inboxUnread(notifyParent, 2);
    assert.equal(rest.messages.length, 2);
    assert.equal(rest.unreadCount, 0);
    await sync.syncOnce();
    assert.ok(api.files.has(markerPath(0)) && api.files.has(responseMarkerPath(0)),
      'the zero-unread state also has one matching marker in each queue');
    assert.ok(!api.files.has(markerPath(2)) && !api.files.has(responseMarkerPath(2)));

    const restartedSync = new GitHubBridgeSync(client, paths, workerStateDirectory);
    await restartedSync.syncOnce();
    assert.ok(api.files.has(markerPath(0)) && api.files.has(responseMarkerPath(0)),
      'a new sync instance reconstructs the current markers from persistent mailbox state');
    assert.deepEqual(api.files.get(markerPath(0)).bytes, api.files.get(responseMarkerPath(0)).bytes);
  } finally {
    await Promise.all(notificationMessages.map(message => mailboxStore.deleteMessage(message.id)));
    await sync.syncOnce();
  }

  // Two separate ChatGPT conversations share the same model/platform but
  // must never share queue, response, artifact, or durable-idempotency state.
  const sharedId = 'same-id';
  const chatgptConversationIds = ['agent-7f3a91c2d4e6', 'agent-2b8e4d6a1c9f'];
  const agentRequestBytes = new Map();
  for (const agentId of chatgptConversationIds) {
    const bytes = Buffer.from(JSON.stringify({
      protocol_version: 1,
      id: sharedId,
      commands: [{ tool: 'get_config', arguments: {} }],
    }), 'utf8');
    agentRequestBytes.set(agentId, bytes);
    const remotePath = agentId + '/requests/' + sharedId + '.json';
    api.files.set(remotePath, { bytes, sha: gitBlobSha(bytes) });
  }
  await sync.syncOnce();
  for (const agentId of chatgptConversationIds) {
    const agentRoot = path.join(paths.root, agentId);
    assert.deepEqual(
      await fs.readFile(path.join(agentRoot, 'requests', sharedId + '.json')),
      agentRequestBytes.get(agentId),
      'same request ID must be staged independently for conversation ' + agentId,
    );
    const artifactBytes = Buffer.from('artifact from ' + agentId, 'utf8');
    const artifactPath = 'artifacts/' + sharedId + '/same-name.bin';
    await fs.mkdir(path.join(agentRoot, 'artifacts', sharedId), { recursive: true });
    await fs.writeFile(path.join(agentRoot, artifactPath), artifactBytes);
    const artifact = {
      path: artifactPath,
      bytes: artifactBytes.length,
      sha256: crypto.createHash('sha256').update(artifactBytes).digest('hex'),
    };
    const responseHash = crypto.createHash('sha256').update(agentRequestBytes.get(agentId)).digest('hex');
    const localResponsePath = path.join(agentRoot, 'responses', sharedId + '.json');
    await fs.writeFile(localResponsePath, JSON.stringify({
      protocol_version: 1,
      id: sharedId,
      request_hash: responseHash,
      status: 'completed',
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:01.000Z',
      results: [{ index: 0, tool: 'get_config', status: 'succeeded', isError: false, artifacts: [artifact] }],
      artifacts: [artifact],
    }));
  }
  await sync.syncOnce();
  for (const agentId of chatgptConversationIds) {
    assert.ok(api.files.has(agentId + '/responses/' + sharedId + '.json'),
      'each ChatGPT conversation must receive its own response: ' + agentId);
    assert.ok(api.files.has(agentId + '/requests/' + sharedId + '.json'),
      'remote request history is retained for conversation ' + agentId);
    const uploadedArtifactPath = agentId + '/artifacts/' + sharedId + '/same-name.bin';
    assert.ok(api.files.has(uploadedArtifactPath),
      'artifacts must be uploaded inside their own conversation folder: ' + agentId);
    assert.equal(api.files.get(uploadedArtifactPath).bytes.toString('utf8'), 'artifact from ' + agentId,
      'two agents may reuse artifact filenames without sharing file contents');
    await assert.rejects(
      () => fs.access(path.join(paths.root, agentId, 'requests', sharedId + '.json')),
      /ENOENT/,
      'local staged request is removed after publishing that conversation response: ' + agentId,
    );
  }

  const requestBytes = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: 'sample-01',
    commands: [{ tool: 'get_config', arguments: {} }],
  }), 'utf8');
  const requestPath = 'agent-default/requests/request-sample-01.json';
  api.files.set(requestPath, { bytes: requestBytes, sha: gitBlobSha(requestBytes) });

  await sync.syncOnce();
  assert.deepEqual(
    await fs.readFile(path.join(defaultPaths.requests, 'request-sample-01.json')),
    requestBytes,
    'new GitHub requests should be staged in the local worker queue',
  );
  assert.equal(api.getRawReadCount(requestPath), 1);

  await sync.syncOnce();
  assert.equal(api.getRawReadCount(requestPath), 1,
    'unchanged staged requests should not be downloaded again on every poll');

  const cachedRequestId = 'cached-at-startup';
  const cachedRequestPath = 'agent-default/requests/request-' + cachedRequestId + '.json';
  const cachedRequestBytes = Buffer.from('already staged request bytes');
  api.files.set(cachedRequestPath, {
    bytes: cachedRequestBytes,
    sha: gitBlobSha(cachedRequestBytes),
  });
  await fs.writeFile(
    path.join(defaultPaths.requests, 'request-' + cachedRequestId + '.json'),
    cachedRequestBytes,
  );
  const cachedStartupSync = new GitHubBridgeSync(client, paths, workerStateDirectory);
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
  assert.equal(stagingLogs.filter((message) =>
    message.includes('agent-default/requests/request-' + cachedRequestId)
    && message.includes('staged ')
    && message.includes('locally for execution'),
  ).length, 1,
    'a cached request should produce one agent-scoped staging checkpoint when first observed');

  const artifactPath = 'artifacts/sample-01/output.bin';
  const artifactBytes = Buffer.from([0, 1, 2, 3, 255]);
  const localArtifactPath = path.join(defaultPaths.root, ...artifactPath.split('/'));
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
  const responsePath = path.join(defaultPaths.responses, 'response-sample-01.json');
  await fs.mkdir(defaultPaths.responses, { recursive: true });
  await fs.writeFile(responsePath, JSON.stringify(response));

  await sync.syncOnce();
  assert.deepEqual(api.files.get('agent-default/' + artifactPath).bytes, artifactBytes);
  assert.ok(api.files.has('agent-default/responses/response-sample-01.json'));
  assert.ok(
    api.commits.findIndex((commit) => commit.path === 'agent-default/' + artifactPath)
      < api.commits.findIndex((commit) => commit.path === 'agent-default/responses/response-sample-01.json'),
    'artifacts must be committed before the response completion marker',
  );
  await assert.rejects(
    () => fs.access(responsePath),
    /ENOENT/,
    'published response staging files should be removed locally',
  );
  await assert.rejects(
    () => fs.access(path.join(defaultPaths.requests, 'request-sample-01.json')),
    /ENOENT/,
    'published request staging files should be removed locally',
  );
  await sync.syncOnce();
  assert.equal(api.getRawReadCount(requestPath), 1,
    'unchanged completed requests should be skipped without downloading the request or response again');
  assert.equal(api.getRawReadCount('agent-default/responses/response-sample-01.json'), 0);

  const compactId = 'task-a1';
  const compactRequestBytes = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: compactId,
    commands: [{ tool: 'get_config', arguments: {} }],
  }), 'utf8');
  api.files.set('agent-default/requests/' + compactId + '.json', {
    bytes: compactRequestBytes,
    sha: gitBlobSha(compactRequestBytes),
  });
  await sync.syncOnce();
  assert.deepEqual(
    await fs.readFile(path.join(defaultPaths.requests, compactId + '.json')),
    compactRequestBytes,
    'GitHub sync must stage compact request filenames without a request- prefix',
  );
  const compactRequestHash = crypto.createHash('sha256').update(compactRequestBytes).digest('hex');
  await fs.writeFile(path.join(defaultPaths.responses, compactId + '.json'), JSON.stringify({
    protocol_version: 1,
    id: compactId,
    request_hash: compactRequestHash,
    status: 'completed',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    results: [],
    artifacts: [],
  }));
  await sync.syncOnce();
  assert.ok(api.files.has('agent-default/responses/' + compactId + '.json'),
    'GitHub sync must publish compact response filenames without a response- prefix');
  await assert.rejects(
    () => fs.access(path.join(defaultPaths.requests, compactId + '.json')),
    /ENOENT/,
    'compact local request staging files should be removed after response publication',
  );

  // Overwriting a request after its response exists must not re-execute it.
  // A changed blob under an already-completed ID should be explicitly diagnosed.
  const reusedRequestBytes = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: 'sample-01',
    commands: [{ tool: 'get_usage_stats', arguments: {} }],
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
    path.join(defaultPaths.responses, 'response-sample-02.json'),
    JSON.stringify(concurrentResponse('sample-02')),
  );
  const firstConcurrentSync = sync.syncOnce();
  await uploadGate.started;
  await fs.writeFile(
    path.join(defaultPaths.responses, 'response-sample-03.json'),
    JSON.stringify(concurrentResponse('sample-03')),
  );
  const secondConcurrentSignal = sync.syncOnce();
  uploadGate.release();
  await Promise.all([firstConcurrentSync, secondConcurrentSignal]);
  assert.ok(api.files.has('agent-default/responses/response-sample-02.json'));
  assert.ok(api.files.has('agent-default/responses/response-sample-03.json'),
    'a response arriving during synchronization must be published by the queued follow-up pass');
  await assert.rejects(
    () => fs.access(path.join(defaultPaths.responses, 'response-sample-03.json')),
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
  const largeSourceLocalPath = path.join(defaultPaths.root, ...largeSourceArtifactPath.split('/'));
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
  const largeResponsePath = path.join(defaultPaths.responses, 'response-' + largeResponseId + '.json');
  await fs.writeFile(largeResponsePath, JSON.stringify(largeResponse));
  await sync.syncOnce();

  const publishedLargeResponseBytes = api.files.get('agent-default/responses/response-' + largeResponseId + '.json')?.bytes;
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
      const stored = api.files.get('agent-default/' + part.path);
      assert.ok(stored, 'each declared artifact part must be uploaded: ' + part.path);
      assert.equal(stored.bytes.length, part.bytes);
      assert.equal(crypto.createHash('sha256').update(stored.bytes).digest('hex'), part.sha256);
      assert.ok(stored.bytes.length <= 32 * 1024 * 1024,
        'each uploaded artifact file must remain under the 32 MiB Contents API transport chunk size');
      return stored.bytes;
    });
    const reconstructed = Buffer.concat(chunks);
    assert.equal(reconstructed.length, reference.bytes);
    assert.equal(crypto.createHash('sha256').update(reconstructed).digest('hex'), reference.sha256);
    return reconstructed;
  };

  // The new automatic-dump threshold is 1 MB, not the old 32 MiB threshold.
  const autoDumpId = 'auto-dump-01';
  const autoDumpText = 'D'.repeat(1_000_100);
  const autoDumpResponsePath = path.join(defaultPaths.responses, 'response-' + autoDumpId + '.json');
  await fs.writeFile(autoDumpResponsePath, JSON.stringify({
    protocol_version: 1,
    id: autoDumpId,
    request_hash: crypto.createHash('sha256').update(autoDumpId).digest('hex'),
    status: 'completed',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    results: [{
      index: 0,
      tool: 'read_file',
      status: 'succeeded',
      isError: false,
      content: [{ type: 'text', text: autoDumpText }],
    }],
    artifacts: [],
  }));
  await sync.syncOnce();
  const autoDumpRemotePath = 'agent-default/responses/response-' + autoDumpId + '.json';
  const autoDumpMarker = api.files.get(autoDumpRemotePath)?.bytes;
  assert.ok(autoDumpMarker, 'a response slightly over 1 MB must still publish a completion marker');
  assert.ok(autoDumpMarker.length <= 1_000_000,
    'the serialized response marker must be capped at 1 MB by automatic dumping');
  const autoDumpPublished = JSON.parse(autoDumpMarker.toString('utf8'));
  const autoDumpReference = autoDumpPublished.results[0].artifacts.find((artifact) => artifact.mimeType === 'application/json');
  assert.ok(autoDumpReference, 'the oversized result must be replaced by a JSON artifact reference');
  const autoDumpContentBytes = autoDumpReference.parts
    ? reconstructArtifact(autoDumpReference)
    : api.files.get('agent-default/' + autoDumpReference.path).bytes;
  assert.deepEqual(
    JSON.parse(autoDumpContentBytes.toString('utf8')),
    [{ type: 'text', text: autoDumpText }],
    'automatic dumping must preserve the complete original tool content',
  );

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
    path.join(defaultPaths.responses, 'response-' + invalidResponseId + '.json'),
    '{invalid json',
  );
  await fs.writeFile(
    path.join(defaultPaths.responses, 'response-' + validResponseId + '.json'),
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
  assert.ok(api.files.has('agent-default/responses/response-' + validResponseId + '.json'),
    'a malformed response must not block another response from the same sync pass');
  await fs.access(path.join(defaultPaths.responses, 'response-' + invalidResponseId + '.json'));
  await fs.rm(path.join(defaultPaths.responses, 'response-' + invalidResponseId + '.json'), { force: true });

  const listingFailureId = 'listing-failure-01';
  await fs.writeFile(path.join(defaultPaths.responses, 'response-' + listingFailureId + '.json'), JSON.stringify({
    protocol_version: 1,
    id: listingFailureId,
    request_hash: crypto.createHash('sha256').update(listingFailureId).digest('hex'),
    status: 'completed',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    results: [],
    artifacts: [],
  }));
  api.failNextQueueTreeList();
  await assert.rejects(
    () => sync.syncOnce(),
    /local response publication was still attempted/,
    'remote queue discovery errors should still be reported after trying to publish completed local responses',
  );
  assert.ok(api.files.has('agent-default/responses/response-' + listingFailureId + '.json'),
    'a temporary remote request-listing failure must not block a completed response upload');

  const followupId = 'sync-followup-01';
  const followupRequestBytes = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: followupId,
    commands: [{ tool: 'get_config', arguments: {} }],
  }), 'utf8');
  const queueListGate = api.pauseNextQueueTreeList();
  api.failNextQueueTreeList();
  const failedPassWithQueuedSignal = sync.syncOnce();
  await queueListGate.started;
  api.files.set('agent-default/requests/' + followupId + '.json', {
    bytes: followupRequestBytes,
    sha: gitBlobSha(followupRequestBytes),
  });
  const queuedFollowupSignal = sync.syncOnce();
  queueListGate.release();
  await Promise.all([failedPassWithQueuedSignal, queuedFollowupSignal]);
  assert.deepEqual(
    await fs.readFile(path.join(defaultPaths.requests, followupId + '.json')),
    followupRequestBytes,
    'a queued sync signal must trigger a successful retry even when the preceding pass failed',
  );

  const restartRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-github-bridge-restart-'));
  try {
    const restartedPaths = {
      root: restartRoot,
    };
    const restartedDefaultPaths = {
      root: path.join(restartedPaths.root, 'agent-default'),
      requests: path.join(restartedPaths.root, 'agent-default', 'requests'),
      responses: path.join(restartedPaths.root, 'agent-default', 'responses'),
      artifacts: path.join(restartedPaths.root, 'agent-default', 'artifacts'),
    };
    const restartedSync = new GitHubBridgeSync(client, restartedPaths, workerStateDirectory);
    await restartedSync.initialize();
    await restartedSync.syncOnce();
    await assert.rejects(
      () => fs.access(path.join(restartedDefaultPaths.requests, 'request-sample-01.json')),
      /ENOENT/,
      'a request with an existing remote response must not be staged again after restart',
    );
    assert.equal(api.getRawReadCount(requestPath), 1,
      'a restarted bridge must not download a request whose response completion marker already exists');
    assert.equal(api.getRawReadCount('agent-default/responses/response-sample-01.json'), 0,
      'a restarted bridge must not download historical completed responses');
    await restartedSync.syncOnce();
    assert.equal(api.getRawReadCount(requestPath), 1,
      'completed request history must remain excluded from every later synchronization');
    assert.equal(api.getRawReadCount('agent-default/responses/response-sample-01.json'), 0,
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
    const requestName = 'agent-default/requests/request-' + id + '.json';
    const responseName = 'agent-default/responses/response-' + id + '.json';
    const oldRequest = Buffer.from('historical request ' + index);
    const oldResponse = Buffer.from('historical response ' + index);
    api.files.set(requestName, { bytes: oldRequest, sha: gitBlobSha(oldRequest) });
    api.files.set(responseName, { bytes: oldResponse, sha: gitBlobSha(oldResponse) });
    historicalReadRequests.add(requestName);
    historicalReadRequests.add(responseName);
  }
  const largeQueueListing = await client.listQueueFiles();
  assert.ok(largeQueueListing.requests.length >= historyCount,
    'Git Trees indexing must discover request files beyond the Contents API 1,000-entry limit');
  assert.ok(largeQueueListing.responses.length >= historyCount,
    'Git Trees indexing must discover response files beyond the Contents API 1,000-entry limit');
  const historySync = new GitHubBridgeSync(client, paths, workerStateDirectory);
  await historySync.syncOnce();
  for (const remotePath of historicalReadRequests) {
    assert.equal(api.getRawReadCount(remotePath), 0,
      'completed history must be indexed without downloading ' + remotePath);
  }

  // Backslashes are path separators on Windows and must not allow a remote
  // response to escape the artifact cache root.
  await fs.mkdir(defaultPaths.responses, { recursive: true });
  await fs.writeFile(path.join(defaultPaths.responses, 'response-sample-01.json'), JSON.stringify({
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

  const cacheStateRoot = path.join(temporaryRoot, 'repository-cache-state');
  const freshCache = await resolveRepositoryCacheRoots(cacheStateRoot, 'owner/fresh', 501);
  assert.equal(freshCache.cacheRoot, path.join(cacheStateRoot, 'github-cache', '501'));
  assert.equal(freshCache.workerStateRoot, path.join(cacheStateRoot, 'github-worker-state', '501'));
  assert.equal(
    (await fs.readFile(path.join(freshCache.cacheRoot, '.github-repository-id'), 'utf8')).trim(),
    '501',
    'new caches must persist the immutable repository ID',
  );

  const confirmedLegacyCache = path.join(cacheStateRoot, 'github-cache', 'owner--same');
  await fs.mkdir(confirmedLegacyCache, { recursive: true });
  await fs.writeFile(path.join(confirmedLegacyCache, '.github-repository-id'), '502\n');
  const sameRepositoryCache = await resolveRepositoryCacheRoots(cacheStateRoot, 'owner/same', 502);
  assert.equal(sameRepositoryCache.cacheRoot, confirmedLegacyCache,
    'an existing cache with the same immutable repository ID must be preserved');
  assert.equal(sameRepositoryCache.workerStateRoot, path.join(cacheStateRoot, 'github-worker-state', 'owner--same'));

  const recreatedRepositoryCache = await resolveRepositoryCacheRoots(cacheStateRoot, 'owner/same', 503);
  assert.equal(recreatedRepositoryCache.cacheRoot, path.join(cacheStateRoot, 'github-cache', '503'),
    'a recreated repository with the same name but a different ID must receive a fresh cache');

  const unmarkedLegacyCache = path.join(cacheStateRoot, 'github-cache', 'owner--legacy');
  await fs.mkdir(unmarkedLegacyCache, { recursive: true });
  await assert.rejects(
    () => resolveRepositoryCacheRoots(cacheStateRoot, 'owner/legacy', 504),
    /older local GitHub bridge cache exists/,
    'unmarked legacy caches require an explicit interactive decision rather than being reused silently',
  );

  // Verify legacy flat-queue migration does not collide with an existing
  // root-level agent-default conversation. This uses a fresh remote repository
  // state so no earlier migration marker can influence the result.
  const collisionApi = createGitHubApiDouble();
  const collisionClient = await GitHubRepositoryClient.connect('owner/repo', token, collisionApi.fetcher);
  const collisionCacheRoot = path.join(temporaryRoot, 'collision-github-cache');
  const collisionWorkerState = path.join(temporaryRoot, 'collision-worker-state');
  const existingDefaultBytes = Buffer.from('existing agent-default request');
  const newFlatBytes = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: 'collision-id',
    commands: [{ tool: 'get_config', arguments: {} }],
  }), 'utf8');
  collisionApi.files.set('agent-default/requests/collision-id.json', {
    bytes: existingDefaultBytes, sha: gitBlobSha(existingDefaultBytes),
  });
  collisionApi.files.set('requests/collision-id.json', {
    bytes: newFlatBytes, sha: gitBlobSha(newFlatBytes),
  });
  const collisionSync = new GitHubBridgeSync(
    collisionClient,
    { root: collisionCacheRoot },
    collisionWorkerState,
  );
  await collisionSync.initialize();
  const compatibilityPath = [...collisionApi.files.keys()].find(filePath =>
    filePath.startsWith('agent-legacy-flat-') && filePath.endsWith('/requests/collision-id.json'));
  assert.match(compatibilityPath.split('/')[0], /^agent-legacy-flat-[0-9a-f]{32}$/);
  assert.ok(compatibilityPath,
    'flat remote queues use a separate compatibility folder when agent-default already exists');
  assert.deepEqual(
    collisionApi.files.get('agent-default/requests/collision-id.json').bytes,
    existingDefaultBytes,
    'an existing agent-default request must not be overwritten or merged with flat legacy data',
  );
  assert.deepEqual(collisionApi.files.get(compatibilityPath).bytes, newFlatBytes);
  assert.ok(!collisionApi.files.has('requests/collision-id.json'),
    'the old flat request is removed only after its new compatibility copy is verified');
  const recordedCompatibility = JSON.parse(
    collisionApi.files.get('.desktop-commander-flat-migration.json').bytes.toString('utf8'),
  );
  assert.equal(recordedCompatibility.agentId, compatibilityPath.split('/')[0]);
  await collisionSync.initialize();
  assert.equal(
    JSON.parse(collisionApi.files.get('.desktop-commander-flat-migration.json').bytes.toString('utf8')).agentId,
    recordedCompatibility.agentId,
    'a GitHub restart must retain the same compatibility destination',
  );

} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}


function fakeWorkerChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

const firstWorker = fakeWorkerChild();
const restartedWorker = fakeWorkerChild();
let workerShouldStop = false;
let workerStartCount = 0;
let workerStartedResolve;
const workerStarted = new Promise((resolve) => { workerStartedResolve = resolve; });
const workerRestartDelays = [];
const workerExitEvents = [];
const workerSupervisor = superviseBridgeWorker({
  initialChild: firstWorker,
  start: async () => {
    workerStartCount++;
    return restartedWorker;
  },
  shouldStop: () => workerShouldStop,
  signal: new AbortController().signal,
  sleep: async (milliseconds) => { workerRestartDelays.push(milliseconds); },
  onChildStarted: (child) => workerStartedResolve(child),
  onWorkerExit: (event) => workerExitEvents.push(event),
});
await new Promise((resolve) => setImmediate(resolve));
firstWorker.emit('close', 1, null);
assert.equal(await workerStarted, restartedWorker,
  'the GitHub supervisor must replace a worker that exits unexpectedly');
assert.equal(workerStartCount, 1);
assert.deepEqual(workerRestartDelays, [1_000],
  'the first worker restart should use a short bounded backoff');
assert.equal(workerExitEvents.length, 1);
assert.equal(workerExitEvents[0].code, 1);
workerShouldStop = true;
restartedWorker.emit('close', 0, null);
await workerSupervisor;

console.log('GitHub repository bridge tests passed.');
