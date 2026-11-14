import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveModeChoice } = require('../scripts/bridge-launcher-modes.cjs');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const launcher = readFileSync(
  path.join(__dirname, '..', 'scripts', 'bridge-launcher.cjs'),
  'utf8'
);

assert.match(launcher, /require\(['"]\.\/bridge-launcher-modes\.cjs['"]\)/);
assert.match(launcher, /return resolveModeChoice\(choice\)/);
assert.match(launcher, /if \(!process\.stdin\.isTTY \|\| !process\.stdout\.isTTY\) return \[\]/);

assert.deepEqual(resolveModeChoice(''), ['remote'], 'Pressing Enter must start Remote MCP');
assert.deepEqual(resolveModeChoice('   '), ['remote'], 'Whitespace-only input must start Remote MCP');
assert.deepEqual(resolveModeChoice('1'), ['remote'], 'Option 1 must start Remote MCP');
assert.deepEqual(resolveModeChoice('2'), [], 'Option 2 must preserve standard MCP stdio');
assert.deepEqual(resolveModeChoice('3'), ['bridge', '--provider', 'cloud']);
assert.deepEqual(resolveModeChoice('4'), ['bridge', '--provider', 'github']);
assert.deepEqual(resolveModeChoice('5'), ['local-api']);

for (const invalid of ['0', '6', 'remote', '1x']) {
  assert.throws(
    () => resolveModeChoice(invalid),
    /Invalid mode selection/,
    `Invalid selection ${JSON.stringify(invalid)} must be rejected`
  );
}

assert.match(launcher, /Remote MCP device \(ChatGPT \/ Claude web\)/);
assert.match(launcher, /Local MCP server \(stdio; launched by an MCP host\)/);

console.log('PASS portable launcher modes: Remote MCP default, explicit stdio mode, and bridge modes');
