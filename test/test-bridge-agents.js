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

  // Separate ChatGPT conversations must use separate folders even though
  // they share the same model/platform. Request, response, artifact, and
  // processing-ledger state must not collide when their request IDs match.
  const chatgptConversationOneId = 'chatgpt-7f3a91c2d4e6';
  const chatgptConversationTwoId = 'chatgpt-2b8e4d6a1c9f';
  const plannerId = 'planner-05c4e7a19b2d';
  for (const agentId of [chatgptConversationOneId, chatgptConversationTwoId, plannerId]) {
    await fs.mkdir(path.join(agentsRoot, agentId), { recursive: true });
  }
  const agents = await discoverAgentQueuePaths(agentsRoot, stateRoot);
  assert.deepEqual(agents.map((agent) => agent.agentId), [
    chatgptConversationTwoId, chatgptConversationOneId, 'default', plannerId,
  ]);
  const chatgptConversationOne = agents.find((agent) => agent.agentId === chatgptConversationOneId);
  const chatgptConversationTwo = agents.find((agent) => agent.agentId === chatgptConversationTwoId);
  assert.ok(chatgptConversationOne && chatgptConversationTwo);
  assert.notEqual(chatgptConversationOne.requests, chatgptConversationTwo.requests);
  assert.notEqual(chatgptConversationOne.responses, chatgptConversationTwo.responses);
  assert.notEqual(chatgptConversationOne.artifacts, chatgptConversationTwo.artifacts);
  assert.notEqual(chatgptConversationOne.ledgers, chatgptConversationTwo.ledgers);
  assert.equal(chatgptConversationOne.requests,
    path.join(agentsRoot, chatgptConversationOneId, 'requests'));
  assert.equal(chatgptConversationTwo.requests,
    path.join(agentsRoot, chatgptConversationTwoId, 'requests'));

  await fs.writeFile(path.join(chatgptConversationOne.requests, 'same-id.json'), 'conversation one');
  await fs.writeFile(path.join(chatgptConversationTwo.requests, 'same-id.json'), 'conversation two');
  assert.equal(
    await fs.readFile(path.join(chatgptConversationOne.requests, 'same-id.json'), 'utf8'),
    'conversation one',
  );
  assert.equal(
    await fs.readFile(path.join(chatgptConversationTwo.requests, 'same-id.json'), 'utf8'),
    'conversation two',
  );

  assert.equal(isValidAgentDirectoryName('agent-01'), true);
  assert.equal(isValidAgentDirectoryName('chatgpt.web'), true);
  assert.equal(isValidAgentDirectoryName('chatgpt.'), false,
    'trailing dots are not portable across Windows filesystems');
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
