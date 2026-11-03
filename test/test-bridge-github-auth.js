import assert from 'node:assert/strict';
import { getGitHubAccessToken, refreshGitHubAccessTokenForWebhooks } from '../dist/bridge/github.js';

// Injected auth operations are test doubles: these checks never open a browser
// or execute the real GitHub CLI.
const environmentToken = await getGitHubAccessToken({
  env: { GITHUB_TOKEN: '  environment-token  ' },
  interactive: false,
  readToken: async () => {
    throw new Error('CLI must not be called when an environment token exists.');
  },
});
assert.equal(environmentToken, 'environment-token');

const events = [];
let tokenReads = 0;
const browserToken = await getGitHubAccessToken({
  env: {},
  interactive: true,
  cliPath: 'test-gh',
  readToken: async (cliPath) => {
    assert.equal(cliPath, 'test-gh');
    tokenReads += 1;
    events.push('read-token');
    if (tokenReads === 1) throw new Error('not authenticated yet');
    return 'browser-authorized-token';
  },
  runLogin: async (cliPath) => {
    assert.equal(cliPath, 'test-gh');
    events.push('browser-login');
  },
});
assert.equal(browserToken, 'browser-authorized-token');
assert.deepEqual(events, ['read-token', 'browser-login', 'read-token']);

let headlessLoginStarted = false;
await assert.rejects(
  () => getGitHubAccessToken({
    env: {},
    interactive: false,
    readToken: async () => { throw new Error('no saved login'); },
    runLogin: async () => { headlessLoginStarted = true; },
  }),
  /interactive terminal.*browser/,
);
assert.equal(headlessLoginStarted, false, 'headless startup must not attempt an interactive browser login');

await assert.rejects(
  () => getGitHubAccessToken({
    env: {},
    interactive: true,
    readToken: async () => { throw new Error('not authenticated'); },
    runLogin: async () => { throw new Error('user cancelled sign-in'); },
  }),
  /GitHub browser sign-in failed: user cancelled sign-in/,
);


const webhookScopeEvents = [];
const refreshedToken = await refreshGitHubAccessTokenForWebhooks({
  env: {},
  interactive: true,
  cliPath: 'test-gh',
  refresh: async (cliPath) => {
    assert.equal(cliPath, 'test-gh');
    webhookScopeEvents.push('refresh-admin-repo-hook');
  },
  readToken: async (cliPath) => {
    assert.equal(cliPath, 'test-gh');
    webhookScopeEvents.push('read-refreshed-token');
    return 'token-with-webhook-permission';
  },
});
assert.equal(refreshedToken, 'token-with-webhook-permission');
assert.deepEqual(webhookScopeEvents, ['refresh-admin-repo-hook', 'read-refreshed-token']);

let tokenRefreshAttempted = false;
await assert.rejects(
  () => refreshGitHubAccessTokenForWebhooks({
    env: { GITHUB_TOKEN: 'fine-grained-token' },
    interactive: true,
    refresh: async () => { tokenRefreshAttempted = true; },
    readToken: async () => 'unexpected-token',
  }),
  /Webhooks: write/,
);
assert.equal(tokenRefreshAttempted, false,
  'environment tokens must not be silently replaced by a different CLI account');

await assert.rejects(
  () => refreshGitHubAccessTokenForWebhooks({
    env: {},
    interactive: false,
    refresh: async () => { throw new Error('must not start in headless mode'); },
    readToken: async () => 'unexpected-token',
  }),
  /repository Webhooks: write permission/,
);

console.log('GitHub browser authentication tests passed.');
