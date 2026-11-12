import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BRIDGE_TOOL_NAMES, getBridgeToolNames } from '../dist/bridge/protocol.js';
import { createGuideIfMissing } from '../dist/bridge/runtime.js';
import { buildBrowserLaunchArgs, shouldUseHeadlessBrowser } from '../dist/subagents.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-bridge-guide-'));

try {
  const generatedRoot = path.join(tempDir, 'generated');
  await fs.mkdir(generatedRoot, { recursive: true });
  await createGuideIfMissing(generatedRoot);
  assert.deepEqual(await fs.readdir(generatedRoot), ['README.md'],
    'README.md must be the only generated agent-facing guide file');

  const generatedGuidePath = path.join(generatedRoot, 'README.md');
  const generatedGuide = await fs.readFile(generatedGuidePath, 'utf8');
  assert.match(generatedGuide, /desktop-commander:bridge-guide:v9/);
  assert.match(generatedGuide, /agent-<uniqueid>\/\{requests,responses,artifacts\}/);
  assert.match(generatedGuide, /agent-<parent>\/subagents\/agent-<child>/);
  assert.match(generatedGuide, /agent-4l\/requests\/task-a1\.json/);
  assert.match(generatedGuide, /<your-workspace>\/responses\/<id>\.json/);
  assert.match(generatedGuide, /<your-workspace>\/artifacts/);
  assert.match(generatedGuide, /Request IDs need only be unique within your own workspace/);
  assert.match(generatedGuide, /child agents may create subagents recursively/);
  assert.match(generatedGuide, /## Subagents and parent coordination/);
  assert.match(generatedGuide, /continue action sends only/);
  assert.match(generatedGuide, /runs headlessly by default/);
  assert.match(generatedGuide, /DC_SUBAGENT_HEADLESS=0/);
  assert.match(generatedGuide, /Browser.getBrowserCommandLine/);

  // The browser defaults to headless, but an explicit one-time sign-in
  // override may launch the same persistent profile with a visible UI.
  assert.equal(shouldUseHeadlessBrowser(undefined), true);
  assert.equal(shouldUseHeadlessBrowser('1'), true);
  assert.equal(shouldUseHeadlessBrowser('0'), false);
  assert.equal(shouldUseHeadlessBrowser('false'), false);
  const headlessArgs = buildBrowserLaunchArgs('C:/subagent-profile');
  assert.ok(headlessArgs.includes('--headless'));
  assert.ok(headlessArgs.includes('--enable-automation'));
  assert.ok(headlessArgs.includes('--remote-debugging-port=0'));
  assert.ok(headlessArgs.includes('--user-data-dir=C:/subagent-profile'));
  assert.equal(headlessArgs[headlessArgs.length - 1], 'https://chatgpt.com/');
  const visibleArgs = buildBrowserLaunchArgs('C:/subagent-profile', false);
  assert.ok(!visibleArgs.includes('--headless'));
  assert.ok(visibleArgs.includes('--user-data-dir=C:/subagent-profile'));
  assert.match(generatedGuide, /cloud-folder Bridge protocol intentionally does not expose `mailbox`/);
  assert.doesNotMatch(generatedGuide, /normal direct MCP `mailbox` tool/);
  assert.doesNotMatch(generatedGuide, /^### mailbox$/m);
  assert.match(generatedGuide, /Never share a workspace between conversations/);
  assert.match(generatedGuide, /Keep your assigned workspace path/);
  assert.match(generatedGuide, /## Transport behavior/);
  assert.match(generatedGuide, /### Cloud-folder synchronization/);
  assert.match(generatedGuide, /### GitHub Repository Bridge/);
  assert.match(generatedGuide, /immutable GitHub repository ID/);
  assert.match(generatedGuide, /Durable processing ledgers are stored locally under that repository worker state/);
  assert.match(generatedGuide, /Files are committed directly to the repository default branch/);
  assert.match(generatedGuide, /one-second fallback scan/);
  assert.match(generatedGuide, /signed push webhooks/);
  assert.match(generatedGuide, /only agent-facing guide/);
  assert.doesNotMatch(generatedGuide, /(?:^|\n)- requests\//);
  assert.doesNotMatch(generatedGuide, /(?:^|\n)- responses\//);
  assert.doesNotMatch(generatedGuide, /(?:^|\n)- artifacts\//);
  assert.doesNotMatch(generatedGuide, /mailbox_user_id|mailbox identity|## Optional local mailbox/);
  assert.ok(!BRIDGE_TOOL_NAMES.includes('mailbox'),
    'the default generated cloud-folder catalog must not advertise mailbox');
  assert.ok(!getBridgeToolNames('cloud').includes('mailbox'),
    'cloud-folder guide generation must keep mailbox excluded');
  assert.ok(getBridgeToolNames('github').includes('mailbox'),
    'GitHub guide generation must expose mailbox');
  assert.ok(BRIDGE_TOOL_NAMES.includes('subagent'),
    'the generated bridge catalog must include subagent lifecycle actions');

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
  assert.match(upgradedGuide, /desktop-commander:bridge-guide:v9/);
  assert.match(upgradedGuide, /agent-<uniqueid>/);
  assert.match(upgradedGuide, /subagents\/agent-<id>/);
  assert.doesNotMatch(upgradedGuide, /Old structure: requests\//);

  // GitHub mode generates an explicit mailbox queue tool and directs
  // parent/child messaging through GitHub request/response files.
  const githubRoot = path.join(tempDir, 'github');
  await fs.mkdir(githubRoot, { recursive: true });
  await createGuideIfMissing(githubRoot, 'github');
  const githubGuide = await fs.readFile(path.join(githubRoot, 'README.md'), 'utf8');
  assert.match(githubGuide, /desktop-commander:bridge-guide:v9/);
  assert.match(githubGuide, /^### mailbox$/m);
  assert.match(githubGuide, /Parent-child messages in GitHub mode use the `mailbox` tool through ordinary GitHub Bridge request\/response files/);
  assert.match(githubGuide, /private repository/);
  assert.doesNotMatch(githubGuide, /Use the normal direct MCP `mailbox` tool/);
  assert.ok(getBridgeToolNames('github').includes('mailbox'),
    'GitHub guide generation must expose the mailbox schema');

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
