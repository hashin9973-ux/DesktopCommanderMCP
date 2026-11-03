import assert from 'node:assert/strict';
import { parseBridgeRequest } from '../dist/bridge/protocol.js';

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

console.log('Bridge protocol tests passed.');
