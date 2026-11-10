import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  discoverAgentQueuePaths,
  initializeAgentLayout,
  isValidAgentDirectoryName,
  LEGACY_DEFAULT_AGENT,
} from '../dist/bridge/agents.js';

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-agent-queues-'));

try {
  const bridgeRoot = path.join(temporaryRoot, 'bridge');
  const stateRoot = path.join(temporaryRoot, 'state');
  await fs.mkdir(bridgeRoot, { recursive: true });

  const legacyRequests = path.join(bridgeRoot, 'requests');
  const legacyResponses = path.join(bridgeRoot, 'responses');
  const legacyArtifacts = path.join(bridgeRoot, 'artifacts');
  const legacyLedgers = path.join(stateRoot, 'requests');
  await Promise.all([
    fs.mkdir(legacyRequests, { recursive: true }),
    fs.mkdir(legacyResponses, { recursive: true }),
    fs.mkdir(path.join(legacyArtifacts, 'completed-task'), { recursive: true }),
    fs.mkdir(legacyLedgers, { recursive: true }),
  ]);

  const pendingRequest = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: 'pending-task',
    commands: [{ tool: 'get_config', arguments: {} }],
  }));
  const completedResponse = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: 'completed-task',
    status: 'completed',
    results: [],
  }));
  const artifactBytes = Buffer.from([0, 1, 2, 3, 255]);
  const ledgerBytes = Buffer.from(JSON.stringify({
    protocol_version: 1,
    id: 'pending-task',
    request_hash: 'legacy-hash',
    state: 'running',
    commands: [{ state: 'pending' }],
  }));

  await Promise.all([
    fs.writeFile(path.join(legacyRequests, 'pending-task.json'), pendingRequest),
    fs.writeFile(path.join(legacyResponses, 'completed-task.json'), completedResponse),
    fs.writeFile(path.join(legacyArtifacts, 'completed-task', 'report.bin'), artifactBytes),
    fs.writeFile(path.join(legacyLedgers, 'pending-task.json'), ledgerBytes),
  ]);

  const agentsRoot = await initializeAgentLayout(bridgeRoot, stateRoot);
  assert.equal(agentsRoot, path.join(bridgeRoot, 'agents'));
  const defaultRoot = path.join(agentsRoot, LEGACY_DEFAULT_AGENT);
  assert.deepEqual(await fs.readFile(path.join(defaultRoot, 'requests', 'pending-task.json')), pendingRequest);
  assert.deepEqual(await fs.readFile(path.join(defaultRoot, 'responses', 'completed-task.json')), completedResponse);
  assert.deepEqual(await fs.readFile(path.join(defaultRoot, 'artifacts', 'completed-task', 'report.bin')), artifactBytes);
  assert.deepEqual(
    await fs.readFile(path.join(legacyLedgers, LEGACY_DEFAULT_AGENT, 'pending-task.json')),
    ledgerBytes,
  );
  for (const legacyPath of [legacyRequests, legacyResponses, legacyArtifacts]) {
    await assert.rejects(() => fs.access(legacyPath), { code: 'ENOENT' },
      'the old flat queue folder must be moved rather than left active');
  }
  await assert.rejects(() => fs.access(path.join(legacyLedgers, 'pending-task.json')), { code: 'ENOENT' });

  // A second start must be idempotent and must not move or rewrite agent data.
  await initializeAgentLayout(bridgeRoot, stateRoot);
  assert.deepEqual(await fs.readFile(path.join(defaultRoot, 'requests', 'pending-task.json')), pendingRequest);

  // Independent agents may reuse the same request ID. Their request, response,
  // artifact, and ledger roots remain separate.
  for (const agentId of ['chatgpt', 'claude', 'planner']) {
    await fs.mkdir(path.join(agentsRoot, agentId), { recursive: true });
  }
  const agents = await discoverAgentQueuePaths(agentsRoot, stateRoot);
  assert.deepEqual(agents.map((agent) => agent.agentId), ['chatgpt', 'claude', 'default', 'planner']);
  const chatgpt = agents.find((agent) => agent.agentId === 'chatgpt');
  const claude = agents.find((agent) => agent.agentId === 'claude');
  assert.ok(chatgpt && claude);
  assert.notEqual(chatgpt.requests, claude.requests);
  assert.notEqual(chatgpt.responses, claude.responses);
  assert.notEqual(chatgpt.artifacts, claude.artifacts);
  assert.notEqual(chatgpt.ledgers, claude.ledgers);
  assert.equal(chatgpt.requests, path.join(agentsRoot, 'chatgpt', 'requests'));
  assert.equal(chatgpt.responses, path.join(agentsRoot, 'chatgpt', 'responses'));
  assert.equal(chatgpt.artifacts, path.join(agentsRoot, 'chatgpt', 'artifacts'));

  await fs.writeFile(path.join(chatgpt.requests, 'same-id.json'), 'chatgpt');
  await fs.writeFile(path.join(claude.requests, 'same-id.json'), 'claude');
  assert.equal(await fs.readFile(path.join(chatgpt.requests, 'same-id.json'), 'utf8'), 'chatgpt');
  assert.equal(await fs.readFile(path.join(claude.requests, 'same-id.json'), 'utf8'), 'claude');

  assert.equal(isValidAgentDirectoryName('agent-01'), true);
  assert.equal(isValidAgentDirectoryName('chatgpt.web'), true);
  assert.equal(isValidAgentDirectoryName('Agent'), false,
    'agent folder names are lowercase for cross-platform identity consistency');
  assert.equal(isValidAgentDirectoryName('../chatgpt'), false);
  assert.equal(isValidAgentDirectoryName('con'), false,
    'Windows reserved device names cannot be agent folder names');
  assert.equal(isValidAgentDirectoryName('nul.txt'), false,
    'Windows reserved device names remain prohibited when followed by an extension');

  // Conflicting legacy files must stop migration without overwriting either
  // side or deleting the old source.
  const conflictRoot = path.join(temporaryRoot, 'conflict-bridge');
  const conflictState = path.join(temporaryRoot, 'conflict-state');
  const conflictSource = path.join(conflictRoot, 'requests', 'task.json');
  const conflictDestination = path.join(conflictRoot, 'agents', 'default', 'requests', 'task.json');
  await fs.mkdir(path.dirname(conflictSource), { recursive: true });
  await fs.mkdir(path.dirname(conflictDestination), { recursive: true });
  await fs.writeFile(conflictSource, 'legacy-content');
  await fs.writeFile(conflictDestination, 'different-new-content');
  await assert.rejects(
    () => initializeAgentLayout(conflictRoot, conflictState),
    /stopped rather than overwrite different data/,
  );
  assert.equal(await fs.readFile(conflictSource, 'utf8'), 'legacy-content');
  assert.equal(await fs.readFile(conflictDestination, 'utf8'), 'different-new-content');

  console.log('Agent queue layout and migration tests passed.');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
