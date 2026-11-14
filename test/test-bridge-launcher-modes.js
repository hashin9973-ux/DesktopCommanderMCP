import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const launcher = readFileSync(
  path.join(__dirname, '..', 'scripts', 'bridge-launcher.cjs'),
  'utf8'
);

// Execute the exact mode resolver embedded in the launcher's SEA entry script.
// Node's single-executable application embedder cannot require local JS files.
const resolverSource = launcher.match(/function resolveModeChoice\(choice\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(resolverSource, 'The launcher must contain an embedded resolveModeChoice function');

const sandbox = {};
vm.runInNewContext(
  `${resolverSource}\nglobalThis.resolveModeChoice = resolveModeChoice;`,
  sandbox
);
const resolveModeChoice = (choice) => [...sandbox.resolveModeChoice(choice)];

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
assert.match(launcher, /Select 1, 2, 3, 4, or 5 \[default 1\]/);

console.log('PASS portable launcher modes: embedded Remote MCP default, explicit stdio mode, and bridge modes');
