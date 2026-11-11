import { mailboxStore } from './mailbox.js';

function usage(): string {
  return [
    'Desktop Commander mailbox administration',
    '',
    'Commands:',
    '  mailbox users',
    '  mailbox register <username>',
    '  mailbox read [--user <username>] [--from <username>] [--to <username>] [--unread] [--limit <n>]',
    '  mailbox send-as-user <recipient> <message>',
    '  mailbox send <sender-username> <recipient> <message>',
    '  mailbox rename-user <username> <new-username>',
    '  mailbox delete-user <username>',
    '  mailbox edit-mail <message-id> <new-message>',
    '  mailbox delete-mail <message-id>',
  ].join('\n');
}

export async function runMailboxCli(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  try {
    switch (action) {
      case 'users': {
        const users = await mailboxStore.listUsers();
        console.log(JSON.stringify(users, null, 2));
        break;
      }
      case 'register': {
        if (!rest[0]) throw new Error('Usage: mailbox register <username>');
        console.log(JSON.stringify(await mailboxStore.register(rest[0]), null, 2));
        break;
      }
      case 'read': {
        const filters: { user?: string; from?: string; to?: string; unreadOnly?: boolean; limit?: number } = {};
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--user') filters.user = rest[++i];
          else if (rest[i] === '--from') filters.from = rest[++i];
          else if (rest[i] === '--to') filters.to = rest[++i];
          else if (rest[i] === '--unread') filters.unreadOnly = true;
          else if (rest[i] === '--limit') filters.limit = Number(rest[++i]);
          else throw new Error(`Unknown read option: ${rest[i]}`);
        }
        console.log(JSON.stringify(await mailboxStore.read(filters), null, 2));
        break;
      }
      case 'send-as-user': {
        if (rest.length < 2) throw new Error('Usage: mailbox send-as-user <recipient> <message>');
        console.log(JSON.stringify(await mailboxStore.sendAsUser(rest[0], rest.slice(1).join(' ')), null, 2));
        break;
      }
      case 'send': {
        if (rest.length < 3) throw new Error('Usage: mailbox send <sender-username> <recipient> <message>');
        console.log(JSON.stringify(await mailboxStore.send(rest[0], rest[1], rest.slice(2).join(' ')), null, 2));
        break;
      }
      case 'rename-user': {
        if (rest.length !== 2) throw new Error('Usage: mailbox rename-user <username> <new-username>');
        console.log(JSON.stringify(await mailboxStore.renameUser(rest[0], rest[1]), null, 2));
        break;
      }
      case 'delete-user': {
        if (rest.length !== 1) throw new Error('Usage: mailbox delete-user <username>');
        console.log(JSON.stringify(await mailboxStore.deleteUser(rest[0]), null, 2));
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
        throw new Error(`Unknown mailbox command: ${action}\n\n${usage()}`);
    }
  } catch (error) {
    console.error(`Mailbox error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
