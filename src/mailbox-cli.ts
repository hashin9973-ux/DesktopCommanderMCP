import { mailboxStore } from './mailbox.js';

function usage(): string {
  return [
    'Desktop Commander mailbox administration',
    '',
    'Commands:',
    '  mailbox paths',
    '  mailbox read <workspace-path> [--unread] [--limit <n>]',
    '  mailbox unread <workspace-path> [--limit <n>]',
    '  mailbox send <sender-workspace-path> <recipient-workspace-path> <message>',
    '  mailbox edit-mail <message-id> <new-message>',
    '  mailbox delete-mail <message-id>',
    '',
    'Workspace paths must be complete hierarchical Bridge paths, such as',
    'agent-parent/subagents/agent-child. This CLI is for local administration;',
    'agent-to-agent messaging is performed through GitHub Bridge queue requests.',
  ].join('\n');
}

function parseLimit(args: string[], start: number): number | undefined {
  let limit: number | undefined;
  for (let index = start; index < args.length; index++) {
    if (args[index] === '--limit' && args[index + 1]) {
      limit = Number(args[++index]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error('--limit must be an integer from 1 to 1000.');
      }
    } else {
      throw new Error('Unknown option: ' + args[index]);
    }
  }
  return limit;
}

export async function runMailboxCli(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  try {
    switch (action) {
      case 'paths': {
        console.log(JSON.stringify(await mailboxStore.listAgentPaths(), null, 2));
        break;
      }
      case 'read': {
        if (!rest[0]) throw new Error('Usage: mailbox read <workspace-path> [--unread] [--limit <n>]');
        let unreadOnly = false;
        const options = rest.slice(1).filter(option => {
          if (option === '--unread') {
            unreadOnly = true;
            return false;
          }
          return true;
        });
        const limit = parseLimit(options, 0);
        console.log(JSON.stringify(await mailboxStore.read(rest[0], { unreadOnly, limit }), null, 2));
        break;
      }
      case 'unread': {
        if (!rest[0]) throw new Error('Usage: mailbox unread <workspace-path> [--limit <n>]');
        const limit = parseLimit(rest, 1);
        console.log(JSON.stringify(await mailboxStore.inboxUnread(rest[0], limit), null, 2));
        break;
      }
      case 'send': {
        if (rest.length < 3) throw new Error('Usage: mailbox send <sender-workspace-path> <recipient-workspace-path> <message>');
        console.log(JSON.stringify(await mailboxStore.send(rest[0], rest[1], rest.slice(2).join(' ')), null, 2));
        break;
      }
      case 'edit-mail': {
        if (rest.length < 2) throw new Error('Usage: mailbox edit-mail <message-id> <new-message>');
        console.log(JSON.stringify(await mailboxStore.editMessage(rest[0], rest.slice(1).join(' ')), null, 2));
        break;
      }
      case 'delete-mail': {
        if (rest.length !== 1) throw new Error('Usage: mailbox delete-mail <message-id>');
        console.log(JSON.stringify({ deleted: await mailboxStore.deleteMessage(rest[0]) }, null, 2));
        break;
      }
      case 'help':
      case undefined:
        console.log(usage());
        break;
      default:
        throw new Error('Unknown mailbox command: ' + action + '\n\n' + usage());
    }
  } catch (error) {
    console.error('Mailbox error: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
