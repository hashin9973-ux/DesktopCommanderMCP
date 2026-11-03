import fs from 'node:fs/promises';

export const MAILBOX_GUIDE_HEADING = '## Optional local mailbox (direct MCP only)';

const BRIDGE_GUIDE_TITLE = '# Desktop Commander Cloud-Folder Bridge';
const MAILBOX_GUIDE_MARKER = '<!-- desktop-commander:local-mailbox-guide:v1 -->';

const MAILBOX_GUIDE_SECTION = [
  MAILBOX_GUIDE_HEADING,
  '',
  MAILBOX_GUIDE_MARKER,
  '',
  'The local mailbox is separate from this cloud-folder bridge. The bridge request parser intentionally rejects the `mailbox` tool, and `mailbox_user_id` is not a supported bridge request argument.',
  '',
  'Do not put mailbox messages, message contents, usernames, or `mailbox_user_id` values in `requests/` files. Those files are stored in the cloud-synchronized bridge folder. Do not work around this restriction by running `desktop-commander mailbox ...` through the bridge `start_process` tool; the command and its arguments would then be written into a synchronized request file.',
  '',
  'An AI client connected only to this folder bridge cannot use the mailbox tool. Mailbox operations require a separate direct local Desktop Commander MCP connection that exposes the `mailbox` tool. If that direct connection is unavailable, leave mailbox operations to a local client or the user.',
  '',
  'On a direct local MCP connection:',
  '',
  '- Call `mailbox` with `action="register"` and `username` once. Save the returned `mailbox_user_id` for that identity.',
  '- Call `mailbox` with `action="list_users"` to see registered identities and unread counts.',
  '- Call `mailbox` with `action="send"`, `mailbox_user_id`, `to` (recipient username), and `message` to send a message.',
  '- Call `mailbox` with `action="inbox_unread"` and `mailbox_user_id` to retrieve unread messages and mark them as read.',
  '- Call `mailbox` with `action="read"` to inspect message history. Optional filters are `user`, `from`, `to`, `unreadOnly`, and `limit`.',
  '- Include `mailbox_user_id` as an optional argument on ordinary direct MCP tool calls to receive unread-message notices. Use `inbox_unread` to retrieve the messages.',
  '',
  'Mailbox data is stored locally in the same configuration directory as Desktop Commander settings; it is not stored in the bridge request, response, or artifact folders. A mailbox user ID is a routing identifier, not an authentication credential. Keep it out of shared bridge files.',
  '',
  'For local administration, the CLI supports `desktop-commander mailbox users`, `register`, `read`, `send`, `send-as-user`, `rename-user`, `delete-user`, `edit-mail`, and `delete-mail`. Run these locally, not through the cloud-folder bridge.',
].join('\n');

export type MailboxGuideAppendResult = 'appended' | 'already_present' | 'not_bridge_guide' | 'missing';

export async function appendMailboxGuideSection(guidePath: string): Promise<MailboxGuideAppendResult> {
  let existing: string;
  try {
    existing = await fs.readFile(guidePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }

  if (existing.includes(MAILBOX_GUIDE_HEADING) || existing.includes(MAILBOX_GUIDE_MARKER)) {
    return 'already_present';
  }
  if (!existing.startsWith(BRIDGE_GUIDE_TITLE)) {
    return 'not_bridge_guide';
  }

  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  const handle = await fs.open(guidePath, 'a');
  try {
    await handle.writeFile(separator + MAILBOX_GUIDE_SECTION + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return 'appended';
}
