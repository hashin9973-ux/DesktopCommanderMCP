import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withEnv } from './helpers/test-env.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-mailbox-test-'));
try {
  await withEnv({ HOME: home, USERPROFILE: home }, async () => {
    const configDirectory = path.join(home, '.claude-server-commander');
    await fs.mkdir(configDirectory, { recursive: true });
    const legacyDatabase = {
      version: 2,
      users: [
        { username: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-03T00:00:00.000Z' },
        { username: 'Bob', createdAt: '2026-01-02T00:00:00.000Z', lastActivityAt: '2026-01-03T00:00:00.000Z' },
      ],
      messages: [{
        id: 'legacy-message-id',
        from: 'Alice',
        to: 'Bob',
        body: 'Preserve this existing message without guessing its Bridge path.',
        createdAt: '2026-01-03T00:00:00.000Z',
        readAt: '2026-01-03T00:01:00.000Z',
      }],
    };
    const databasePath = path.join(configDirectory, 'mailbox.json');
    await fs.writeFile(databasePath, JSON.stringify(legacyDatabase, null, 2) + '\n', 'utf8');

    const { mailboxStore } = await import('../dist/mailbox.js');
    const { MailboxArgsSchema } = await import('../dist/tools/schemas.js');
    const { BRIDGE_TOOL_NAMES, getBridgeToolNames } = await import('../dist/bridge/protocol.js');

    assert.equal(MailboxArgsSchema.safeParse({ action: 'inbox_unread', limit: 5 }).success, true);
    assert.equal(MailboxArgsSchema.safeParse({
      action: 'send', to: 'agent-parent/subagents/agent-child', message: 'Hello',
    }).success, true);
    assert.equal(MailboxArgsSchema.safeParse({
      action: 'send', username: 'Alice', to: 'agent-parent', message: 'Hello',
    }).success, false, 'mailbox usernames are not accepted');
    assert.equal(MailboxArgsSchema.safeParse({
      action: 'inbox_unread', username: 'Alice',
    }).success, false, 'the sender and inbox identity cannot be supplied by the caller');
    assert.equal(MailboxArgsSchema.safeParse({ action: 'register', username: 'Alice' }).success, false,
      'mailbox registration has been removed');
    assert.equal(MailboxArgsSchema.safeParse({
      action: 'send', to: 'agent-parent/agent-child', message: 'Invalid path',
    }).success, true, 'schema validates argument shape; the store validates complete workspace paths');
    assert.equal(BRIDGE_TOOL_NAMES.includes('mailbox'), false,
      'cloud-folder Bridge does not expose mailbox');
    assert.equal(getBridgeToolNames('github').includes('mailbox'), true,
      'GitHub Bridge exposes mailbox queue commands');

    // v1/v2 username databases have no safe automatic mapping to nested paths.
    // Preserve the original records, including read state, in a migration archive.
    assert.equal(await mailboxStore.unreadCount('agent-parent'), 0);
    const migratedDatabase = JSON.parse(await fs.readFile(databasePath, 'utf8'));
    assert.equal(migratedDatabase.version, 3);
    assert.equal(migratedDatabase.messages.length, 0);
    assert.equal(migratedDatabase.legacyArchive.sourceVersion, 2);
    assert.equal(migratedDatabase.legacyArchive.users[0].username, 'Alice');
    assert.equal(migratedDatabase.legacyArchive.messages[0].readAt, '2026-01-03T00:01:00.000Z');
    assert.equal(migratedDatabase.legacyArchive.messages[0].body,
      'Preserve this existing message without guessing its Bridge path.');

    const parent = 'agent-parent';
    const child = 'agent-parent/subagents/agent-child';
    const siblingChild = 'agent-other-parent/subagents/agent-child';
    const nestedChild = child + '/subagents/agent-grandchild';
    const created = [];
    try {
      created.push(await mailboxStore.send(child, parent, 'First report.'));
      created.push(await mailboxStore.send(child, parent, 'Second report.'));
      created.push(await mailboxStore.send(siblingChild, parent, 'Third report.'));
      created.push(await mailboxStore.send(parent, child, 'Reply to child.'));
      created.push(await mailboxStore.send(nestedChild, siblingChild, 'Nested report.'));

      assert.equal(await mailboxStore.unreadCount(parent), 3);
      assert.equal(await mailboxStore.unreadCount(child), 1);
      assert.equal(await mailboxStore.unreadCount(siblingChild), 1);
      assert.equal(await mailboxStore.unreadCount(nestedChild), 0);

      const partial = await mailboxStore.inboxUnread(parent, 1);
      assert.equal(partial.messages.length, 1);
      assert.equal(partial.messages[0].body, 'First report.');
      assert.equal(partial.unreadCount, 2,
        'a limited inbox read leaves later messages unread');
      assert.equal(await mailboxStore.unreadCount(parent), 2);

      const requestDirectory = path.join(home, 'agent-parent', 'requests');
      const responseDirectory = path.join(home, 'agent-parent', 'responses');
      const count = await mailboxStore.syncUnreadMarkers(parent, requestDirectory, responseDirectory);
      assert.equal(count, 2);
      const markerName = 'unread-messages-2.txt';
      const requestMarker = await fs.readFile(path.join(requestDirectory, markerName), 'utf8');
      const responseMarker = await fs.readFile(path.join(responseDirectory, markerName), 'utf8');
      assert.equal(requestMarker, responseMarker, 'request and response markers have identical content');
      assert.match(requestMarker, /Unread mailbox messages: 2/);
      assert.match(requestMarker, /not an executable Bridge request/);
      for (const directory of [requestDirectory, responseDirectory]) {
        const markers = (await fs.readdir(directory)).filter(name => /^unread-messages-\d+\.txt$/.test(name));
        assert.deepEqual(markers, [markerName], 'each queue contains exactly one current notification marker');
      }

      const secondPartial = await mailboxStore.inboxUnread(parent, 1);
      assert.equal(secondPartial.messages.length, 1);
      assert.equal(secondPartial.unreadCount, 1);
      assert.equal((await mailboxStore.read(parent, { unreadOnly: true })).length, 1,
        'history filters remain scoped to the current complete workspace path');
      assert.equal((await mailboxStore.read(child)).length, 3,
        'nested child history is separate from parent and same-leaf sibling history');

      const concurrent = await Promise.all(Array.from({ length: 25 }, (_, index) =>
        mailboxStore.send(child, parent, 'Concurrent message ' + index)));
      created.push(...concurrent);
      assert.equal(new Set(concurrent.map(message => message.id)).size, concurrent.length,
        'concurrent sends receive unique message IDs');
      assert.equal(await mailboxStore.unreadCount(parent), 26,
        'concurrent sends from this process are serialized by the mailbox store');

      // Separate Node processes share the stable lock file and database. This
      // verifies the lock rather than only the in-process promise queue.
      const mailboxModuleUrl = new URL('../dist/mailbox.js', import.meta.url).href;
      const crossProcessWorkers = Array.from({ length: 4 }, (_, index) => {
        const source = [
          'import { mailboxStore } from ' + JSON.stringify(mailboxModuleUrl) + ';',
          'await mailboxStore.send(' + JSON.stringify(child) + ', ' + JSON.stringify(parent) +
            ', ' + JSON.stringify('Cross-process message ' + index) + ');',
        ].join(String.fromCharCode(10));
        return spawn(process.execPath, ['--input-type=module', '-e', source], {
          env: process.env,
          stdio: 'ignore',
        });
      });
      await Promise.all(crossProcessWorkers.map(worker => new Promise((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', code => code === 0
          ? resolve(undefined)
          : reject(new Error('Concurrent mailbox worker exited with code ' + code)));
      })));
      assert.equal(await mailboxStore.unreadCount(parent), 30,
        'cross-process sends are serialized without dropping messages');

      await mailboxStore.syncUnreadMarkers(parent, requestDirectory, responseDirectory);
      const concurrentMarker = 'unread-messages-30.txt';
      for (const directory of [requestDirectory, responseDirectory]) {
        assert.deepEqual(
          (await fs.readdir(directory)).filter(name => /^unread-messages-\d+\.txt$/.test(name)),
          [concurrentMarker],
          'count changes remove the previous marker rather than accumulating files',
        );
      }

      const remaining = await mailboxStore.inboxUnread(parent, 1000);
      assert.equal(remaining.messages.length, 30);
      assert.equal(remaining.unreadCount, 0);
      assert.equal(await mailboxStore.unreadCount(parent), 0);
      await mailboxStore.syncUnreadMarkers(parent, requestDirectory, responseDirectory);
      for (const directory of [requestDirectory, responseDirectory]) {
        assert.deepEqual(
          (await fs.readdir(directory)).filter(name => /^unread-messages-\d+\.txt$/.test(name)),
          ['unread-messages-0.txt'],
          'zero unread messages is represented by exactly one zero-count marker',
        );
      }

      await assert.rejects(
        () => mailboxStore.send('agent-parent', 'agent-parent/agent-child', 'Invalid recipient shape.'),
        /complete Bridge workspace path/,
      );
      await assert.rejects(
        () => mailboxStore.send(child, parent, ' '.repeat(2)),
        /cannot be empty/,
      );
      const stored = JSON.parse(await fs.readFile(databasePath, 'utf8'));
      assert.ok(stored.messages.every(message => message.from.includes('agent-') && message.to.includes('agent-')),
        'active mailbox records are keyed only by workspace paths');
      assert.ok(!Object.hasOwn(stored, 'users'), 'new mailbox storage has no username registry');
    } finally {
      await Promise.all(created.map(message => mailboxStore.deleteMessage(message.id)));
    }

    console.log('Workspace-scoped mailbox, partial-read, notification-marker, concurrency, and migration tests passed.');
  });
} finally {
  await fs.rm(home, { recursive: true, force: true });
}
