import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withEnv } from './helpers/test-env.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-mailbox-test-'));
try {
  await withEnv({ HOME: home, USERPROFILE: home }, async () => {
    const configDirectory = path.join(home, '.claude-server-commander');
    await fs.mkdir(configDirectory, { recursive: true });
    const legacyUsers = [
      { id: 'legacy-alice-id', username: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-03T00:00:00.000Z' },
      { id: 'legacy-bob-id', username: 'Bob', createdAt: '2026-01-02T00:00:00.000Z', lastActivityAt: '2026-01-03T00:00:00.000Z' },
    ];
    const legacyDatabase = {
      version: 1,
      users: legacyUsers,
      messages: [{
        id: 'legacy-message-id',
        fromUserId: 'legacy-alice-id',
        toUserId: 'legacy-bob-id',
        body: 'Preserve this existing message.',
        createdAt: '2026-01-03T00:00:00.000Z',
      }],
    };
    const databasePath = path.join(configDirectory, 'mailbox.json');
    await fs.writeFile(databasePath, JSON.stringify(legacyDatabase, null, 2) + '\n', 'utf8');

    const { mailboxStore } = await import('../dist/mailbox.js');
    const { MailboxArgsSchema } = await import('../dist/tools/schemas.js');
    assert.equal(MailboxArgsSchema.safeParse({
      action: 'inbox_unread', username: 'Bob',
    }).success, true, 'local mailbox inboxes are addressed by username');
    assert.equal(MailboxArgsSchema.safeParse({
      action: 'inbox_unread', mailbox_user_id: 'legacy-id',
    }).success, false, 'opaque mailbox user IDs are not accepted as mailbox or Bridge identity');
    assert.equal(MailboxArgsSchema.safeParse({
      action: 'send', username: 'Alice', to: 'Bob', message: 'Hello',
    }).success, true, 'independent local mailbox sending uses username addressing');
    const { BRIDGE_TOOL_NAMES } = await import('../dist/bridge/protocol.js');
    assert.equal(BRIDGE_TOOL_NAMES.includes('mailbox'), false,
      'mailbox remains an independent local MCP feature, not a Bridge identity or queue tool');

    const migratedHistory = await mailboxStore.read({ user: 'Bob' });
    assert.equal(migratedHistory.length, 1);
    assert.equal(migratedHistory[0].from, 'Alice');
    assert.equal(migratedHistory[0].to, 'Bob');
    assert.equal(migratedHistory[0].body, 'Preserve this existing message.');
    const migratedDatabase = JSON.parse(await fs.readFile(databasePath, 'utf8'));
    assert.equal(migratedDatabase.version, 2);
    assert.ok(migratedDatabase.users.every(user => !Object.hasOwn(user, 'id')),
      'persisted mailbox users no longer have opaque identity IDs');
    assert.ok(migratedDatabase.messages.every(message =>
      !Object.hasOwn(message, 'fromUserId') && !Object.hasOwn(message, 'toUserId')),
    'persisted mailbox messages reference usernames instead of user IDs');

    const alice = await mailboxStore.register('Alice');
    const bob = await mailboxStore.register('Bob');
    assert.equal(alice.existing, true);
    assert.equal(bob.existing, true);
    assert.equal(alice.user.username, 'Alice');
    assert.equal(Object.hasOwn(alice.user, 'id'), false,
      'mailbox registration returns no mailbox user ID');
    assert.equal((await mailboxStore.register('alice')).existing, true,
      'usernames are case-insensitive and stable');

    const sent = await mailboxStore.send('Alice', 'Bob', 'Handoff: please continue the implementation.');
    assert.equal(sent.from, 'Alice');
    assert.equal(sent.to, 'Bob');
    assert.equal(await mailboxStore.unreadCount('Bob'), 2);
    assert.equal(await mailboxStore.unreadCount('Alice'), 0);

    const unread = await mailboxStore.inboxUnread('Bob');
    assert.equal(unread.messages.length, 2);
    assert.equal(unread.messages[1].from, 'Alice');
    assert.equal(unread.messages[1].body, 'Handoff: please continue the implementation.');
    assert.equal(await mailboxStore.unreadCount('Bob'), 0,
      'inbox_unread marks delivered messages read');

    const history = await mailboxStore.read({ user: 'Bob' });
    assert.equal(history.length, 2);
    assert.equal(history.find(message => message.id === sent.id).to, 'Bob');

    const renamed = await mailboxStore.renameUser('Bob', 'Builder');
    assert.equal(renamed.username, 'Builder');
    assert.ok((await mailboxStore.listUsers()).find(user => user.username === 'Builder').lastActivity.length > 0);
    assert.equal((await mailboxStore.read({ to: 'Builder' })).length, 2,
      'renaming a mailbox username updates existing message addressing');

    await mailboxStore.editMessage(sent.id, 'Updated handoff.');
    assert.equal((await mailboxStore.read({ to: 'Builder' })).find(message => message.id === sent.id).body, 'Updated handoff.');
    assert.equal(await mailboxStore.deleteMessage(sent.id), true);
    assert.equal(await mailboxStore.deleteMessage(sent.id), false);

    const userMessage = await mailboxStore.sendAsUser('Alice', 'Message from the local user.');
    assert.equal(userMessage.from, 'User');
    assert.equal((await mailboxStore.read({ from: 'User' }))[0].id, userMessage.id);

    const result = await mailboxStore.deleteUser('Alice');
    assert.equal(result.deletedMessages, 2,
      'deleting a user removes the remaining messages they sent or received');
    assert.equal((await mailboxStore.listUsers()).some(user => user.username === 'Alice'), false);

    await assert.rejects(() => mailboxStore.send('missing-user', 'Builder', 'Should fail.'),
      /Sender not found/,
      'unknown mailbox usernames cannot be replaced by a hidden opaque user ID');

    console.log('Mailbox username-addressing and v1 migration tests passed.');
  });
} finally {
  await fs.rm(home, { recursive: true, force: true });
}
