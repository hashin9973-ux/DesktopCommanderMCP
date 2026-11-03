import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendMailboxGuideSection,
  MAILBOX_GUIDE_HEADING,
} from '../dist/bridge/guide.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-bridge-guide-'));

try {
  const guidePath = path.join(tempDir, 'README.md');
  const original = [
    '# Desktop Commander Cloud-Folder Bridge',
    '',
    'Existing generated guide content that must remain byte-for-byte unchanged.',
    '',
    '## Tool catalog',
    '',
    '### read_file',
    '',
    'Existing argument schema.',
    '',
  ].join('\n');

  await fs.writeFile(guidePath, original, 'utf8');
  assert.equal(await appendMailboxGuideSection(guidePath), 'appended');

  const appended = await fs.readFile(guidePath, 'utf8');
  assert.ok(appended.startsWith(original), 'existing guide content must be preserved exactly');
  assert.equal(appended.split(MAILBOX_GUIDE_HEADING).length - 1, 1);
  assert.match(appended, /shared by direct MCP clients and both file-queue bridge transports/);
  assert.match(appended, /message text, usernames, and mailbox IDs included in a bridge request or returned in a response/);
  assert.doesNotMatch(appended, /bridge request parser intentionally rejects the `mailbox` tool/);

  assert.equal(await appendMailboxGuideSection(guidePath), 'already_present');
  assert.equal(await fs.readFile(guidePath, 'utf8'), appended, 'a second run must not change the guide');

  // Existing installations may already have a stale MCP-only mailbox section.
  // Replace only that section and preserve the guide content around it.
  const legacyPath = path.join(tempDir, 'legacy-README.md');
  const beforeLegacySection = '# Desktop Commander Cloud-Folder Bridge\n\nIntro text.\n\n';
  const afterLegacySection = '\n## Tool catalog\n\n### read_file\n\nOld catalog remains.\n';
  const legacy = beforeLegacySection + [
    '## Optional local mailbox (direct MCP only)',
    '',
    '<!-- desktop-commander:local-mailbox-guide:v1 -->',
    '',
    'Old text: the bridge parser rejects the mailbox tool.',
    '',
  ].join('\n') + afterLegacySection + [
    '',
    '### Additional mailbox privacy boundary',
    '',
    '<!-- desktop-commander:local-mailbox-guide-supplement:v1 -->',
    '',
    'Old text: no mailbox access from the bridge.',
  ].join('\n');
  await fs.writeFile(legacyPath, legacy, 'utf8');
  assert.equal(await appendMailboxGuideSection(legacyPath), 'updated');

  const upgradedLegacy = await fs.readFile(legacyPath, 'utf8');
  assert.ok(upgradedLegacy.startsWith(beforeLegacySection), 'prefix before the old section must remain unchanged');
  assert.ok(upgradedLegacy.endsWith(afterLegacySection), 'content after the old section must remain unchanged');
  assert.equal(upgradedLegacy.split(MAILBOX_GUIDE_HEADING).length - 1, 1);
  assert.match(upgradedLegacy, /shared by direct MCP clients and the cloud-folder bridge/);
  assert.doesNotMatch(upgradedLegacy, /direct MCP only/);
  assert.doesNotMatch(upgradedLegacy, /bridge parser rejects the mailbox tool/);
  assert.doesNotMatch(upgradedLegacy, /no mailbox access from the bridge/);

  assert.equal(await appendMailboxGuideSection(legacyPath), 'already_present');
  assert.equal(await fs.readFile(legacyPath, 'utf8'), upgradedLegacy,
    'the upgraded mailbox section must be idempotent');

  const customPath = path.join(tempDir, 'custom-readme.md');
  const customReadme = '# My own bridge notes\n\nKeep this file unchanged.\n';
  await fs.writeFile(customPath, customReadme, 'utf8');
  assert.equal(await appendMailboxGuideSection(customPath), 'not_bridge_guide');
  assert.equal(await fs.readFile(customPath, 'utf8'), customReadme);

  assert.equal(await appendMailboxGuideSection(path.join(tempDir, 'missing.md')), 'missing');

  console.log('Bridge guide append tests passed.');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
