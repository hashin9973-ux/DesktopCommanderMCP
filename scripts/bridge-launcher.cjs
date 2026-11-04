'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { createInterface } = require('node:readline/promises');

const distributionRoot = path.dirname(process.execPath);
const runtimePath = path.join(distributionRoot, 'runtime', 'node.exe');
const appRoot = path.join(distributionRoot, 'app');
const entryPoint = path.join(appRoot, 'dist', 'index.js');

for (const requiredPath of [runtimePath, entryPoint]) {
  if (!fs.existsSync(requiredPath)) {
    process.stderr.write('Desktop Commander portable files are incomplete. Missing: ' + requiredPath + '\n');
    process.exit(1);
  }
}

async function selectMode({ required = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (required) {
      throw new Error(
        'The mode menu requires an interactive terminal. Launch "Choose Desktop Commander Mode.cmd" ' +
        'from the portable folder, or run "DesktopCommanderBridge.exe local-api".',
      );
    }
    // MCP hosts launch this executable with piped stdio. Keep that path on
    // standard MCP transport rather than writing a menu into the protocol.
    return [];
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write('\nDesktop Commander — choose a mode\n');
    process.stdout.write('  1. MCP server (standard MCP stdio)\n');
    process.stdout.write('  2. Cloud-folder bridge\n');
    process.stdout.write('  3. GitHub repository bridge\n');
    process.stdout.write('  4. Local OpenAI-compatible API (KoboldCpp)\n\n');
    const choice = (await readline.question('Select 1, 2, 3, or 4 [default 1]: ')).trim();
    if (!choice || choice === '1') return [];
    if (choice === '2') return ['bridge', '--provider', 'cloud'];
    if (choice === '3') return ['bridge', '--provider', 'github'];
    if (choice === '4') return ['local-api'];
    throw new Error('Invalid mode selection. Choose 1, 2, 3, or 4.');
  } finally {
    readline.close();
  }
}

async function main() {
  const suppliedArgs = process.argv.slice(2);
  let forwardedArgs;

  if (suppliedArgs[0] === '--menu') {
    if (suppliedArgs.length !== 1) {
      throw new Error('--menu cannot be combined with another command-line argument.');
    }
    forwardedArgs = await selectMode({ required: true });
  } else {
    forwardedArgs = suppliedArgs.length === 0
      ? await selectMode()
      : suppliedArgs;
  }

  const child = spawn(runtimePath, [entryPoint, ...forwardedArgs], {
    cwd: appRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  });

  child.once('error', (error) => {
    process.stderr.write('Could not start the bundled Node runtime: ' + error.message + '\n');
    process.exitCode = 1;
  });

  child.once('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code === null ? 1 : code;
  });
}

main().catch((error) => {
  process.stderr.write('Desktop Commander startup failed: ' + error.message + '\n');
  process.exitCode = 1;
});
