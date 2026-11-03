import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitHubRepositoryClient } from '../dist/bridge/github.js';
import { GitHubBridgeSync } from '../dist/bridge/github-sync.js';

// Test double for GitHub's Contents and Repositories REST APIs. No network calls are made.
function createGitHubApiDouble() {
  const files = new Map();
  const commits = [];
  let createdRepositoryPayload;

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
        permissions: { push: false },
      });
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

    if (url.pathname === '/repos/owner/repo/contents/requests' && method === 'GET') {
      return directoryListing('requests');
    }
    if (url.pathname === '/repos/owner/repo/contents/responses' && method === 'GET') {
      return directoryListing('responses');
    }

    if (repoPath && method === 'GET') {
      const value = files.get(repoPath);
      if (!value) return notFound();
      if ((headers.get('accept') || '').includes('raw')) {
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
      if (files.has(repoPath)) return jsonResponse({ message: 'already exists' }, 422);
      const payload = JSON.parse(String(init.body));
      const bytes = Buffer.from(payload.content, 'base64');
      const sha = crypto.createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
      files.set(repoPath, { bytes, sha });
      commits.push({ path: repoPath, branch: payload.branch, message: payload.message });
      return jsonResponse({ content: { path: repoPath, sha } }, 201);
    }

    return notFound();
  };

  function directoryListing(directory) {
    const entries = [];
    for (const [filePath, value] of files.entries()) {
      if (!filePath.startsWith(directory + '/')) continue;
      const rest = filePath.slice(directory.length + 1);
      if (rest.includes('/')) continue;
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
    getCreatedRepositoryPayload: () => createdRepositoryPayload,
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

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-github-bridge-'));
const paths = {
  root: temporaryRoot,
  requests: path.join(temporaryRoot, 'requests'),
  responses: path.join(temporaryRoot, 'responses'),
  artifacts: path.join(temporaryRoot, 'artifacts'),
};

try {
  const sync = new GitHubBridgeSync(client, paths);
  await sync.initialize();
  assert.ok(api.files.has('requests/.gitkeep'));
  assert.ok(api.files.has('responses/.gitkeep'));
  assert.ok(api.files.has('artifacts/.gitkeep'));
  assert.ok(api.files.has('DESKTOP_COMMANDER_BRIDGE.md'));

  const requestBytes = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: 'sample-01',
    commands: [{ tool: 'get_config', arguments: {} }],
  }), 'utf8');
  const requestPath = 'requests/request-sample-01.json';
  api.files.set(requestPath, { bytes: requestBytes, sha: 'remote-request' });

  await sync.syncOnce();
  assert.deepEqual(
    await fs.readFile(path.join(paths.requests, 'request-sample-01.json')),
    requestBytes,
    'new GitHub requests should be staged in the local worker queue',
  );

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
  } finally {
    await fs.rm(restartRoot, { recursive: true, force: true });
  }
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log('GitHub repository bridge tests passed.');
