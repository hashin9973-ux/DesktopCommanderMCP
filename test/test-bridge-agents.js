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
  assert.equal(agentsRoot, bridgeRoot);
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
  const chatgptConversationOneId = 'agent-7f3a91c2d4e6';
  const chatgptConversationTwoId = 'agent-2b8e4d6a1c9f';
  const plannerId = 'agent-05c4e7a19b2d';
  for (const agentId of [chatgptConversationOneId, chatgptConversationTwoId, plannerId]) {
    await fs.mkdir(path.join(agentsRoot, agentId), { recursive: true });
  }
  const agents = await discoverAgentQueuePaths(agentsRoot, stateRoot);
  assert.deepEqual(agents.map((agent) => agent.agentId), [
    plannerId, chatgptConversationTwoId, chatgptConversationOneId, 'agent-default',
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
  await fs.writeFile(path.join(chatgptConversationOne.responses, 'same-id.json'), 'response one');
  await fs.writeFile(path.join(chatgptConversationTwo.responses, 'same-id.json'), 'response two');
  await fs.writeFile(path.join(chatgptConversationOne.artifacts, 'same-id.bin'), 'artifact one');
  await fs.writeFile(path.join(chatgptConversationTwo.artifacts, 'same-id.bin'), 'artifact two');
  await fs.writeFile(path.join(chatgptConversationOne.ledgers, 'same-id.json'), 'ledger one');
  await fs.writeFile(path.join(chatgptConversationTwo.ledgers, 'same-id.json'), 'ledger two');
  assert.equal(
    await fs.readFile(path.join(chatgptConversationOne.requests, 'same-id.json'), 'utf8'),
    'conversation one',
  );
  assert.equal(
    await fs.readFile(path.join(chatgptConversationTwo.requests, 'same-id.json'), 'utf8'),
    'conversation two',
  );
  for (const [folder, expected] of [
    [chatgptConversationOne, ['response one', 'artifact one', 'ledger one']],
    [chatgptConversationTwo, ['response two', 'artifact two', 'ledger two']],
  ]) {
    assert.deepEqual([
      await fs.readFile(path.join(folder.responses, 'same-id.json'), 'utf8'),
      await fs.readFile(path.join(folder.artifacts, 'same-id.bin'), 'utf8'),
      await fs.readFile(path.join(folder.ledgers, 'same-id.json'), 'utf8'),
    ], expected, 'responses, artifacts, and durable ledgers are scoped to the same conversation folder');
  }

  // Migrate the previously released nested agents/<name>/ layout into
  // root-level agent-<name>/ folders without losing pending request bytes.
  const previousLayoutRoot = path.join(temporaryRoot, 'previous-layout');
  const previousStateRoot = path.join(temporaryRoot, 'previous-state');
  const previousAgentRequests = path.join(previousLayoutRoot, 'agents', 'chatgpt-old-conversation', 'requests');
  const previousPrefixedAgentRequests = path.join(previousLayoutRoot, 'agents', 'agent-cli-old', 'requests');
  const previousReservedNameRequests = path.join(previousLayoutRoot, 'agents', 'agent-default', 'requests');
  const previousDottedAgentRequests = path.join(previousLayoutRoot, 'agents', 'legacy_agent.v2', 'requests');
  const previousAgentsSentinel = path.join(previousLayoutRoot, 'agents', '.gitkeep');
  const previousAgentLedger = path.join(previousStateRoot, 'requests', 'chatgpt-old-conversation');
  const previousPrefixedAgentLedger = path.join(previousStateRoot, 'requests', 'agent-cli-old');
  const previousReservedNameLedger = path.join(previousStateRoot, 'requests', 'agent-default');
  await fs.mkdir(path.join(previousLayoutRoot, 'agents'), { recursive: true });
  await Promise.all([
    fs.mkdir(previousAgentRequests, { recursive: true }),
    fs.mkdir(previousPrefixedAgentRequests, { recursive: true }),
    fs.mkdir(previousReservedNameRequests, { recursive: true }),
    fs.writeFile(previousAgentsSentinel, 'Desktop Commander agent-scoped queues.\n'),
    fs.mkdir(previousAgentLedger, { recursive: true }),
    fs.mkdir(previousPrefixedAgentLedger, { recursive: true }),
    fs.mkdir(previousReservedNameLedger, { recursive: true }),
  ]);
  const firstLedgerBytes = Buffer.from('first conversation ledger');
  const secondLedgerBytes = Buffer.from('second conversation ledger');
  const reservedNameLedgerBytes = Buffer.from('old agent-default ledger');
  const flatLegacyLedgerBytes = Buffer.from('flat legacy ledger');
  await Promise.all([
    fs.writeFile(path.join(previousAgentRequests, 'legacy.json'), pendingRequest),
    fs.writeFile(path.join(previousPrefixedAgentRequests, 'prefixed-legacy.json'), pendingRequest),
    fs.writeFile(path.join(previousReservedNameRequests, 'reserved-legacy.json'), pendingRequest),
    fs.writeFile(path.join(previousDottedAgentRequests, 'dotted-legacy.json'), pendingRequest),
    fs.writeFile(path.join(previousAgentLedger, 'same-id.json'), firstLedgerBytes),
    fs.writeFile(path.join(previousPrefixedAgentLedger, 'same-id.json'), secondLedgerBytes),
    fs.writeFile(path.join(previousReservedNameLedger, 'same-id.json'), reservedNameLedgerBytes),
    fs.writeFile(path.join(previousStateRoot, 'requests', 'flat-legacy.json'), flatLegacyLedgerBytes),
  ]);
  await initializeAgentLayout(previousLayoutRoot, previousStateRoot);
  assert.deepEqual(
    await fs.readFile(path.join(previousLayoutRoot, 'agent-chatgpt-old-conversation', 'requests', 'legacy.json')),
    pendingRequest,
  );
  assert.deepEqual(
    await fs.readFile(path.join(previousLayoutRoot, 'agent-agent-cli-old', 'requests', 'prefixed-legacy.json')),
    pendingRequest,
  );
  assert.deepEqual(
    await fs.readFile(path.join(previousLayoutRoot, 'agent-agent-default', 'requests', 'reserved-legacy.json')),
    pendingRequest,
  );
  assert.deepEqual(
    await fs.readFile(path.join(previousLayoutRoot, 'agent-legacy_agent.v2', 'requests', 'dotted-legacy.json')),
    pendingRequest,
    'legacy agent folder names with dots and underscores must be preserved verbatim after the agent- prefix',
  );
  assert.deepEqual(
    await fs.readFile(path.join(previousStateRoot, 'requests', 'agent-chatgpt-old-conversation', 'same-id.json')),
    firstLedgerBytes,
    'the old per-conversation idempotency ledger must follow its migrated queue folder',
  );
  assert.deepEqual(
    await fs.readFile(path.join(previousStateRoot, 'requests', 'agent-agent-cli-old', 'same-id.json')),
    secondLedgerBytes,
    'old IDs beginning with agent- must not be mistaken for already-migrated root agent folder names',
  );
  assert.deepEqual(
    await fs.readFile(path.join(previousStateRoot, 'requests', 'agent-agent-default', 'same-id.json')),
    reservedNameLedgerBytes,
    'a legacy agent already named agent-default must remain distinct from the reserved flat-queue bucket',
  );
  assert.deepEqual(
    await fs.readFile(path.join(previousStateRoot, 'requests', 'agent-default', 'flat-legacy.json')),
    flatLegacyLedgerBytes,
    'flat legacy ledgers must remain paired with the agent-default migration bucket',
  );
  for (const oldLedgerPath of [previousAgentLedger, previousPrefixedAgentLedger]) {
    await assert.rejects(() => fs.access(oldLedgerPath), { code: 'ENOENT' });
  }
  await assert.rejects(
    () => fs.access(path.join(previousStateRoot, 'requests', 'agent-default', 'same-id.json')),
    { code: 'ENOENT' },
    'the old agent-default ledger must not be mistaken for the reserved flat-queue ledger folder',
  );
  await assert.rejects(() => fs.access(previousAgentsSentinel), { code: 'ENOENT' },
    'the known generated namespace sentinel is removed during migration');
  await assert.rejects(
    () => fs.access(path.join(previousLayoutRoot, 'agents')),
    { code: 'ENOENT' },
    'the obsolete agents/ wrapper is removed after its folders are migrated',
  );

  assert.equal(isValidAgentDirectoryName('agent-01'), true);
  assert.equal(isValidAgentDirectoryName('chatgpt.web'), false);
  assert.equal(isValidAgentDirectoryName('agent-chatgpt-web'), true);
  assert.equal(isValidAgentDirectoryName('agent-chatgpt.web'), true,
    'the root-level prefix must preserve legacy names containing dots');
  assert.equal(isValidAgentDirectoryName('agent-chat_gpt'), true,
    'the root-level prefix must preserve legacy names containing underscores');
  assert.equal(isValidAgentDirectoryName('agent-chatgpt-'), false,
    'trailing dots are not portable across Windows filesystems');
  assert.equal(isValidAgentDirectoryName('Agent'), false,
    'agent folder names are lowercase for cross-platform identity consistency');
  assert.equal(isValidAgentDirectoryName('../chatgpt'), false);
  assert.equal(isValidAgentDirectoryName('agent-con'), true,
    'the agent- prefix keeps names distinct from Windows reserved device names');

  // Conflicting legacy files must stop migration without overwriting either
  // side or deleting the old source.
  const conflictRoot = path.join(temporaryRoot, 'conflict-bridge');
  const conflictState = path.join(temporaryRoot, 'conflict-state');
  const conflictSource = path.join(conflictRoot, 'requests', 'task.json');
  const conflictDestination = path.join(conflictRoot, 'agent-default', 'requests', 'task.json');
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

  // An existing root-level agent-default is an identity, not the reserved
  // flat migration bucket. Flat queues and their ledgers must be isolated in a
  // newly generated root-level compatibility folder even when filenames match.
  const reservedDefaultRoot = path.join(temporaryRoot, 'reserved-default-bridge');
  const reservedDefaultState = path.join(temporaryRoot, 'reserved-default-state');
  const oldFlatRequests = path.join(reservedDefaultRoot, 'requests');
  const currentDefaultRequests = path.join(reservedDefaultRoot, 'agent-default', 'requests');
  const oldFlatArtifacts = path.join(reservedDefaultRoot, 'artifacts', 'shared-id');
  await Promise.all([
    fs.mkdir(oldFlatRequests, { recursive: true }),
    fs.mkdir(currentDefaultRequests, { recursive: true }),
    fs.mkdir(oldFlatArtifacts, { recursive: true }),
    fs.mkdir(path.join(reservedDefaultRoot, 'responses'), { recursive: true }),
    fs.mkdir(path.join(reservedDefaultState, 'requests'), { recursive: true }),
  ]);
  const flatRequestBytes = Buffer.from('legacy flat request');
  const defaultRequestBytes = Buffer.from('agent-default conversation request');
  const flatArtifactBytes = Buffer.from('legacy flat artifact');
  const flatLedgerBytes = Buffer.from('legacy flat ledger');
  await Promise.all([
    fs.writeFile(path.join(oldFlatRequests, 'shared-id.json'), flatRequestBytes),
    fs.writeFile(path.join(currentDefaultRequests, 'shared-id.json'), defaultRequestBytes),
    fs.writeFile(path.join(oldFlatArtifacts, 'output.bin'), flatArtifactBytes),
    fs.writeFile(path.join(reservedDefaultState, 'requests', 'shared-id.json'), flatLedgerBytes),
  ]);
  await initializeAgentLayout(reservedDefaultRoot, reservedDefaultState);
  const reservedEntries = await fs.readdir(reservedDefaultRoot);
  const compatibilityAgent = reservedEntries.find(name => /^agent-legacy-flat-[0-9a-f]{32}$/.test(name));
  assert.ok(compatibilityAgent,
    'legacy flat data must receive its own compatibility folder when agent-default already exists');
  assert.deepEqual(
    await fs.readFile(path.join(reservedDefaultRoot, 'agent-default', 'requests', 'shared-id.json')),
    defaultRequestBytes,
    'existing agent-default request data must not be merged with the legacy flat request',
  );
  assert.deepEqual(
    await fs.readFile(path.join(reservedDefaultRoot, compatibilityAgent, 'requests', 'shared-id.json')),
    flatRequestBytes,
  );
  assert.deepEqual(
    await fs.readFile(path.join(reservedDefaultRoot, compatibilityAgent, 'artifacts', 'shared-id', 'output.bin')),
    flatArtifactBytes,
  );
  assert.deepEqual(
    await fs.readFile(path.join(reservedDefaultState, 'requests', compatibilityAgent, 'shared-id.json')),
    flatLedgerBytes,
    'the old flat idempotency ledger must follow the same compatibility folder as its request',
  );

  // Simulate an interrupted migration after its stable marker was written but
  // before a conflicting file could be moved. Resolve the conflict and retry:
  // the same marker destination is reused, and no original data is lost.
  const interruptedRoot = path.join(temporaryRoot, 'interrupted-bridge');
  const interruptedState = path.join(temporaryRoot, 'interrupted-state');
  const interruptedSource = path.join(interruptedRoot, 'requests', 'resume.json');
  const interruptedDestination = path.join(interruptedRoot, 'agent-default', 'requests', 'resume.json');
  await fs.mkdir(path.dirname(interruptedSource), { recursive: true });
  await fs.mkdir(path.dirname(interruptedDestination), { recursive: true });
  const interruptedSourceBytes = Buffer.from('resume migration source');
  await fs.writeFile(interruptedSource, interruptedSourceBytes);
  await fs.writeFile(interruptedDestination, 'different destination bytes');
  await fs.writeFile(
    path.join(interruptedRoot, '.desktop-commander-flat-migration.json'),
    JSON.stringify({ version: 1, agentId: 'agent-default' }) + '\n',
  );
  await assert.rejects(
    () => initializeAgentLayout(interruptedRoot, interruptedState),
    /stopped rather than overwrite different data/,
  );
  assert.deepEqual(await fs.readFile(interruptedSource), interruptedSourceBytes,
    'an interrupted migration must preserve the legacy source');
  await fs.writeFile(interruptedDestination, interruptedSourceBytes);
  await initializeAgentLayout(interruptedRoot, interruptedState);
  assert.deepEqual(await fs.readFile(interruptedDestination), interruptedSourceBytes,
    'a retry must finish the same migration when the destination is byte-identical');
  await assert.rejects(() => fs.access(interruptedSource), { code: 'ENOENT' });
  await initializeAgentLayout(interruptedRoot, interruptedState);
  assert.deepEqual(await fs.readFile(interruptedDestination), interruptedSourceBytes,
    'repeated migration after recovery must remain idempotent');

  // Simulate a process stopping before it can atomically publish the
  // migration marker. A partial temporary marker is ignored and preserved;
  // the untouched legacy queue can safely start a new migration attempt.
  const markerInterruptedRoot = path.join(temporaryRoot, 'marker-interrupted-bridge');
  const markerInterruptedState = path.join(temporaryRoot, 'marker-interrupted-state');
  const markerInterruptedRequests = path.join(markerInterruptedRoot, 'requests');
  await fs.mkdir(markerInterruptedRequests, { recursive: true });
  const markerInterruptedBytes = Buffer.from('request survives incomplete marker write');
  await fs.writeFile(path.join(markerInterruptedRequests, 'marker-retry.json'), markerInterruptedBytes);
  const abandonedMarkerTemp = path.join(
    markerInterruptedRoot,
    '.desktop-commander-flat-migration.json.tmp-abandoned',
  );
  await fs.writeFile(abandonedMarkerTemp, '{"version":1,');
  await initializeAgentLayout(markerInterruptedRoot, markerInterruptedState);
  assert.deepEqual(
    await fs.readFile(path.join(markerInterruptedRoot, 'agent-default', 'requests', 'marker-retry.json')),
    markerInterruptedBytes,
    'a partial temporary migration marker must not strand the legacy request',
  );
  assert.equal(await fs.readFile(abandonedMarkerTemp, 'utf8'), '{"version":1,',
    'unrecognized temporary content is preserved rather than deleted');

  if (process.platform !== 'win32') {
    const symlinkRoot = path.join(temporaryRoot, 'symlink-bridge');
    const symlinkState = path.join(temporaryRoot, 'symlink-state');
    const outsidePath = path.join(temporaryRoot, 'outside-request.json');
    const symlinkQueue = path.join(symlinkRoot, 'requests');
    await fs.mkdir(symlinkQueue, { recursive: true });
    const outsideBytes = Buffer.from('outside user data');
    await fs.writeFile(outsidePath, outsideBytes);
    await fs.symlink(outsidePath, path.join(symlinkQueue, 'external.json'));
    await assert.rejects(() => initializeAgentLayout(symlinkRoot, symlinkState),
      /refuses to follow symbolic links/);
    assert.deepEqual(await fs.readFile(outsidePath), outsideBytes,
      'migration must not follow or modify a symlink target');
    assert.equal((await fs.lstat(path.join(symlinkQueue, 'external.json'))).isSymbolicLink(), true,
      'the unrecognized symlink itself remains in place for manual handling');
  }

  console.log('Agent queue layout and migration tests passed.');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
