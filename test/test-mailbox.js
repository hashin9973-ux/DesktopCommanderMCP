import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withEnv } from './helpers/test-env.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-mailbox-test-'));
try {
  await withEnv({ HOME: home, USERPROFILE: home }, async () => {
    const { mailboxStore } = await import('../dist/mailbox.js');
    const { BRIDGE_TOOL_NAMES } = await import('../dist/bridge/protocol.js');
    assert.equal(BRIDGE_TOOL_NAMES.includes('mailbox'), true, 'mailbox must be exposed as a normal cloud-folder bridge tool');
    const { executeToolForBridge } = await import('../dist/server.js');
    const alice = await mailboxStore.register('Alice');
    const bob = await mailboxStore.register('Bob');
    assert.equal(alice.existing, false);
    assert.equal(bob.existing, false);
    assert.match(alice.user.id, /^[0-9a-f-]{36}$/i);
    assert.notEqual(alice.user.id, bob.user.id);
    assert.equal((await mailboxStore.register('alice')).existing, true, 'usernames are case-insensitive and stable');

    const sent = await mailboxStore.send(alice.user.id, 'Bob', 'Handoff: please continue the implementation.');
    assert.equal(await mailboxStore.unreadCount(bob.user.id), 1);
    assert.equal(await mailboxStore.unreadCount(alice.user.id), 0);

    const unread = await mailboxStore.inboxUnread(bob.user.id);
    assert.equal(unread.messages.length, 1);
    assert.equal(unread.messages[0].from, 'Alice');
    assert.equal(unread.messages[0].body, 'Handoff: please continue the implementation.');
    assert.equal(await mailboxStore.unreadCount(bob.user.id), 0, 'inbox_unread marks delivered messages read');

    const history = await mailboxStore.read({ user: 'Bob' });
    assert.equal(history.length, 1);
    assert.equal(history[0].id, sent.id);
    assert.equal(history[0].to, 'Bob');

    const renamed = await mailboxStore.renameUser('Bob', 'Builder');
    assert.equal(renamed.username, 'Builder');
    assert.equal((await mailboxStore.listUsers()).find(user => user.id === bob.user.id).lastActivity.length > 0, true);

    await mailboxStore.editMessage(sent.id, 'Updated handoff.');
    assert.equal((await mailboxStore.read({ to: 'Builder' }))[0].body, 'Updated handoff.');
    assert.equal(await mailboxStore.deleteMessage(sent.id), true);
    assert.equal(await mailboxStore.deleteMessage(sent.id), false);

    const userMessage = await mailboxStore.sendAsUser('Alice', 'Message from the local user.');
    assert.equal((await mailboxStore.read({ from: 'User' }))[0].id, userMessage.id);

    const result = await mailboxStore.deleteUser('Alice');
    assert.equal(result.deletedMessages, 1, 'deleting a user removes the remaining messages they sent or received');
    assert.equal((await mailboxStore.listUsers()).some(user => user.username === 'Alice'), false);

    // Exercise the same dispatcher used by cloud-folder bridge requests.
    const bridgeSenderResult = await executeToolForBridge('mailbox', {
      action: 'register', username: 'Bridge Sender',
    });
    assert.equal(bridgeSenderResult.isError, undefined);
    const bridgeSender = JSON.parse(bridgeSenderResult.content[0].text);
    const bridgeRecipientResult = await executeToolForBridge('mailbox', {
      action: 'register', username: 'Bridge Recipient',
    });
    const bridgeRecipient = JSON.parse(bridgeRecipientResult.content[0].text);

    const bridgeSend = await executeToolForBridge('mailbox', {
      action: 'send',
      mailbox_user_id: bridgeSender.mailbox_user_id,
      to: 'Bridge Recipient',
      message: 'Message sent through the cloud-folder bridge.',
    });
    assert.equal(bridgeSend.isError, undefined);

    const bridgeNotice = await executeToolForBridge('get_config', {
      mailbox_user_id: bridgeRecipient.mailbox_user_id,
    });
    assert.match(bridgeNotice.content[0].text, /1 new message/,
      'ordinary bridge tool calls must preserve mailbox unread notices');

    const bridgeInbox = await executeToolForBridge('mailbox', {
      action: 'inbox_unread',
      mailbox_user_id: bridgeRecipient.mailbox_user_id,
    });
    assert.equal(bridgeInbox.isError, undefined);
    assert.match(bridgeInbox.content[0].text, /Message sent through the cloud-folder bridge\./);
    assert.equal(await mailboxStore.unreadCount(bridgeRecipient.mailbox_user_id), 0);

    console.log('✓ mailbox registration, local persistence, direct MCP and bridge dispatch, send/read, unread tracking, and user/message management');
  });
} finally {
  await fs.rm(home, { recursive: true, force: true });
}
