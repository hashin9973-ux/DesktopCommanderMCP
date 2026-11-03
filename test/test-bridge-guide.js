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
  assert.match(appended, /bridge request parser intentionally rejects the `mailbox` tool/);
  assert.match(appended, /separate direct local Desktop Commander MCP connection/);

  assert.equal(await appendMailboxGuideSection(guidePath), 'already_present');
  assert.equal(await fs.readFile(guidePath, 'utf8'), appended, 'a second run must not change the guide');

  const existingSectionPath = path.join(tempDir, 'README-with-existing-section.md');
  const existingSection = original + '\n' + MAILBOX_GUIDE_HEADING + '\n\nAlready documented.\n';
  await fs.writeFile(existingSectionPath, existingSection, 'utf8');
  assert.equal(await appendMailboxGuideSection(existingSectionPath), 'already_present');
  assert.equal(await fs.readFile(existingSectionPath, 'utf8'), existingSection);

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
