import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BRIDGE_TOOL_NAMES } from '../dist/bridge/protocol.js';
import { createGuideIfMissing } from '../dist/bridge/runtime.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-bridge-guide-'));

try {
  const generatedRoot = path.join(tempDir, 'generated');
  await fs.mkdir(generatedRoot, { recursive: true });
  await createGuideIfMissing(generatedRoot);
  assert.deepEqual(await fs.readdir(generatedRoot), ['README.md'],
    'README.md must be the only generated agent-facing guide file');

  const generatedGuidePath = path.join(generatedRoot, 'README.md');
  const generatedGuide = await fs.readFile(generatedGuidePath, 'utf8');
  assert.match(generatedGuide, /desktop-commander:bridge-guide:v5/);
  assert.match(generatedGuide, /agent-<uniqueid>\//);
  assert.match(generatedGuide, /agent-7f3a91c2d4e6\/requests\/task-a1\.json/);
  assert.match(generatedGuide, /agent-<uniqueid>\/responses\/<id>\.json/);
  assert.match(generatedGuide, /agent-<uniqueid>\/artifacts/);
  assert.match(generatedGuide, /folder identifies this agent instance/);
  assert.match(generatedGuide, /Request IDs need only be unique within this conversation's folder/);
  assert.match(generatedGuide, /one isolated workspace per conversation or subagent instance/);
  assert.match(generatedGuide, /NEW unique folder for this conversation/);
  assert.match(generatedGuide, /Never share a folder between conversations/);
  assert.match(generatedGuide, /reuse it only when continuing that same conversation/);
  assert.match(generatedGuide, /only agent-facing guide/);
  assert.doesNotMatch(generatedGuide, /(?:^|\n)- requests\//);
  assert.doesNotMatch(generatedGuide, /(?:^|\n)- responses\//);
  assert.doesNotMatch(generatedGuide, /(?:^|\n)- artifacts\//);
  assert.doesNotMatch(generatedGuide, /mailbox_user_id|mailbox identity|## Optional local mailbox/);
  assert.ok(!BRIDGE_TOOL_NAMES.includes('mailbox'),
    'the generated bridge catalog must not advertise mailbox identity registration');

  // Existing generated README content must be replaced when the guide changes,
  // even if it already contains a version marker from an earlier release.
  const oldGeneratedRoot = path.join(tempDir, 'old-generated');
  await fs.mkdir(oldGeneratedRoot, { recursive: true });
  const staleGeneratedGuide = [
    '# Desktop Commander Bridge',
    '',
    '<!-- desktop-commander:bridge-guide:v2 -->',
    '',
    'This README is the AI-facing operating guide for Desktop Commander file-queue bridges.',
    '',
    'Old structure: requests/ and responses/.',
    '',
  ].join('\n');
  await fs.writeFile(path.join(oldGeneratedRoot, 'README.md'), staleGeneratedGuide, 'utf8');
  await createGuideIfMissing(oldGeneratedRoot);
  const upgradedGuide = await fs.readFile(path.join(oldGeneratedRoot, 'README.md'), 'utf8');
  assert.notEqual(upgradedGuide, staleGeneratedGuide,
    'an existing generated README with the previous marker must be refreshed');
  assert.match(upgradedGuide, /desktop-commander:bridge-guide:v5/);
  assert.match(upgradedGuide, /agent-<uniqueid>/);
  assert.doesNotMatch(upgradedGuide, /Old structure: requests\//);

  // Custom user-authored README files are deliberately preserved.
  const customRoot = path.join(tempDir, 'custom');
  await fs.mkdir(customRoot, { recursive: true });
  const customReadme = '# My own bridge notes\n\nKeep this file unchanged.\n';
  await fs.writeFile(path.join(customRoot, 'README.md'), customReadme, 'utf8');
  await createGuideIfMissing(customRoot);
  assert.equal(await fs.readFile(path.join(customRoot, 'README.md'), 'utf8'), customReadme,
    'custom README files must not be overwritten');

  console.log('Agent-scoped bridge README tests passed.');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
