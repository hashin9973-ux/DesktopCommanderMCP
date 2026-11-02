'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

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

const forwardedArgs = process.argv.slice(1);
if (forwardedArgs[0] !== 'bridge') {
  forwardedArgs.unshift('bridge');
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
