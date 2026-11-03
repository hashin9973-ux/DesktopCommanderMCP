import assert from 'node:assert/strict';
import { BRIDGE_TOOL_NAMES, parseBridgeRequest } from '../dist/bridge/protocol.js';
import { createBridgePollingTimer } from '../dist/bridge/runtime.js';

const json = JSON.stringify({
  protocol_version: 1,
  id: 'basic-001',
  command_delay_ms: 0,
  commands: [
    { tool: 'list_directory', arguments: { path: 'C:/Projects', depth: 2 } },
    { tool: 'get_config', arguments: {} },
  ],
});

const parsedJson = parseBridgeRequest('request-basic-001.json', json);
assert.equal(parsedJson.id, 'basic-001');
assert.equal(parsedJson.commands.length, 2);
assert.equal(parsedJson.commands[0].tool, 'list_directory');
assert.equal(parsedJson.commands[1].tool, 'get_config');
assert.equal(parsedJson.command_delay_ms, 0);
assert.ok(BRIDGE_TOOL_NAMES.includes('mailbox'), 'mailbox is a supported bridge tool');

const mailboxId = 'f5f9ecf0-1b22-4d15-9911-ec2b39d4c8bf';
const mailboxRequest = parseBridgeRequest('request-mailbox-01.json', JSON.stringify({
  protocol_version: 1,
  id: 'mailbox-01',
  commands: [
    { tool: 'mailbox', arguments: { action: 'register', username: 'Bridge Alice' } },
    { tool: 'get_config', arguments: { mailbox_user_id: mailboxId } },
  ],
}));
assert.equal(mailboxRequest.commands[0].tool, 'mailbox');
assert.equal(mailboxRequest.commands[0].arguments.action, 'register');
assert.equal(mailboxRequest.commands[1].arguments.mailbox_user_id, mailboxId,
  'the common mailbox_user_id argument must be preserved on non-mailbox bridge calls');

const tick = String.fromCharCode(96);
const markdown = [
  '# Inspect this project',
  '',
  tick.repeat(3) + 'javascript',
  'console.log("not executable");',
  tick.repeat(3),
  '',
  tick.repeat(4) + 'markdown',
  tick.repeat(3) + 'desktop-commander-v1',
  JSON.stringify({ tool: 'get_config', arguments: {} }),
  tick.repeat(3),
  tick.repeat(4),
  '',
  tick.repeat(3) + 'desktop-commander-v1',
  JSON.stringify({ tool: 'list_directory', arguments: { path: 'C:/Projects', depth: 1 } }),
  tick.repeat(3),
  '',
  'Ordinary prose is ignored.',
  '',
  tick.repeat(3) + 'desktop-commander-v1',
  JSON.stringify({ tool: 'get_config', arguments: {} }),
  tick.repeat(3),
].join('\n');

const parsedMarkdown = parseBridgeRequest('request-markdown-01.md', markdown);
assert.equal(parsedMarkdown.commands.length, 2);
assert.equal(parsedMarkdown.commands[0].tool, 'list_directory');
assert.equal(parsedMarkdown.commands[1].tool, 'get_config');

assert.throws(
  () => parseBridgeRequest('request-wrong-id.json', json),
  /match the filename id/,
);
assert.throws(
  () => parseBridgeRequest('request-unknown.json', JSON.stringify({
    protocol_version: 1,
    id: 'unknown',
    commands: [{ tool: 'run_anything', arguments: {} }],
  })),
  /unknown or unavailable tool/,
);
assert.throws(
  () => parseBridgeRequest('request-extra-arg.json', JSON.stringify({
    protocol_version: 1,
    id: 'extra-arg',
    commands: [{ tool: 'list_directory', arguments: { path: 'C:/Projects', unexpected: true } }],
  })),
  /unsupported argument/,
);
assert.throws(
  () => parseBridgeRequest('request-bad-mailbox-id.json', JSON.stringify({
    protocol_version: 1,
    id: 'bad-mailbox-id',
    commands: [{ tool: 'get_config', arguments: { mailbox_user_id: 42 } }],
  })),
  /mailbox_user_id must be a string/,
);
assert.throws(
  () => parseBridgeRequest('request-bad-delay.json', JSON.stringify({
    protocol_version: 1,
    id: 'bad-delay',
    command_delay_ms: 60_001,
    commands: [{ tool: 'get_config', arguments: {} }],
  })),
  /command_delay_ms/,
);
assert.throws(
  () => parseBridgeRequest('request-empty.md', '# no commands'),
  /no executable/,
);
assert.throws(
  () => parseBridgeRequest('request-ui-origin.json', JSON.stringify({
    protocol_version: 1,
    id: 'ui-origin',
    commands: [{ tool: 'read_file', arguments: { path: 'C:/Projects/a.png', origin: 'ui' } }],
  })),
  /origin "ui"/,
);
assert.throws(
  () => parseBridgeRequest('request-unclosed.md', [
    tick.repeat(3) + 'desktop-commander-v1',
    JSON.stringify({ tool: 'get_config', arguments: {} }),
  ].join('\n')),
  /Unterminated/,
);
assert.throws(
  () => parseBridgeRequest('request-bad-block.md', [
    tick.repeat(3) + 'desktop-commander-v1',
    '{ invalid json',
    tick.repeat(3),
  ].join('\n')),
  /Invalid JSON/,
);


// The polling fallback must remain referenced so a closed fs.watch handle
// cannot let the bridge process exit before the next queue scan.
let pollingScans = 0;
const pollingTimer = createBridgePollingTimer(() => { pollingScans++; }, 10);
try {
  assert.equal(pollingTimer.hasRef(), true,
    'request polling must keep the bridge alive if filesystem notifications fail');
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.ok(pollingScans > 0, 'fallback polling should run independently of fs.watch');
} finally {
  clearInterval(pollingTimer);
}

console.log('Bridge protocol and polling fallback tests passed.');
