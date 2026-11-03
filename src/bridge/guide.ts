import fs from 'node:fs/promises';
import { writeFileAtomic } from '../utils/atomic-write.js';

export const MAILBOX_GUIDE_HEADING = '## Optional local mailbox (direct MCP and both bridge transports)';

const BRIDGE_GUIDE_TITLE = '# Desktop Commander Bridge';
const LEGACY_BRIDGE_GUIDE_TITLE = '# Desktop Commander Cloud-Folder Bridge';
const MAILBOX_GUIDE_MARKER = '<!-- desktop-commander:local-mailbox-guide:v2 -->';
const LEGACY_MAILBOX_GUIDE_HEADING = '## Optional local mailbox (direct MCP only)';
const LEGACY_MAILBOX_SUPPLEMENT = /\n### Additional mailbox privacy boundary\n\n<!-- desktop-commander:local-mailbox-guide-supplement:v1 -->[\s\S]*$/;

const MAILBOX_GUIDE_SECTION = [
  MAILBOX_GUIDE_HEADING,
  '',
  MAILBOX_GUIDE_MARKER,
  '',
  'Desktop Commander provides one local mailbox shared by direct MCP clients and both file-queue bridge transports. The mailbox database is stored on this device in the Desktop Commander configuration directory; the database itself is not synchronized through the bridge.',
  '',
  'The bridge exposes the same `mailbox` tool and actions as direct MCP: `register`, `list_users`, `send`, `inbox_unread`, and `read`. Use `mailbox_user_id` to identify the sender or inbox. The optional common `mailbox_user_id` argument is also accepted on ordinary bridge tool calls and prepends an unread-message notice when messages are waiting.',
  '',
  'Important transport detail: bridge request and response files pass through the connected storage provider (a cloud folder or GitHub repository). Mailbox message text, usernames, and mailbox IDs included in a bridge request or returned in a response therefore pass through that storage, even though the permanent mailbox database remains local. Use trusted bridge storage and do not send content through it when that content must never leave this device.',
  '',
  'Typical bridge actions:',
  '',
  '- Register an identity with `mailbox` and `action="register"` plus `username`; save the returned `mailbox_user_id`.',
  '- List identities and unread counts with `mailbox` and `action="list_users"`.',
  '- Send with `mailbox`, `action="send"`, `mailbox_user_id`, `to` (recipient username or ID), and `message`.',
  '- Retrieve and mark unread mail as read with `mailbox`, `action="inbox_unread"`, and the recipient `mailbox_user_id`.',
  '- Inspect message history with `mailbox` and `action="read"`; optional filters are `user`, `from`, `to`, `unreadOnly`, and `limit`.',
  '- Include `mailbox_user_id` on ordinary tool calls to receive unread-message notices. Use `inbox_unread` to retrieve the messages.',
  '',
  'A mailbox user ID is a routing identifier, not an authentication credential. Local shell administration is also available on the computer running Desktop Commander: `desktop-commander mailbox users`, `register`, `read`, `send`, `send-as-user`, `rename-user`, `delete-user`, `edit-mail`, and `delete-mail`.',
].join('\n');

export type MailboxGuideAppendResult = 'appended' | 'updated' | 'already_present' | 'not_bridge_guide' | 'missing';

export async function appendMailboxGuideSection(guidePath: string): Promise<MailboxGuideAppendResult> {
  let existing: string;
  try {
    existing = await fs.readFile(guidePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }

  if (existing.includes(MAILBOX_GUIDE_MARKER)) return 'already_present';
  if (!existing.startsWith(BRIDGE_GUIDE_TITLE) && !existing.startsWith(LEGACY_BRIDGE_GUIDE_TITLE)) return 'not_bridge_guide';

  // Upgrade old generated guides in place so stale "MCP only" documentation
  // cannot contradict the now-supported bridge mailbox tool.
  const currentHeadingIndex = existing.indexOf(MAILBOX_GUIDE_HEADING);
  const legacyHeadingIndex = existing.indexOf(LEGACY_MAILBOX_GUIDE_HEADING);
  const headingIndex = currentHeadingIndex >= 0 ? currentHeadingIndex : legacyHeadingIndex;
  if (headingIndex >= 0) {
    const sectionStart = existing.lastIndexOf('\n', headingIndex) + 1;
    const nextHeadingIndex = existing.indexOf('\n## ', headingIndex + 1);
    const sectionEnd = nextHeadingIndex >= 0 ? nextHeadingIndex + 1 : existing.length;
    const prefix = existing.slice(0, sectionStart);
    // Previous versions appended this warning at EOF, after the generated
    // tool catalog. Remove that obsolete footer as well as replacing the
    // old MCP-only section above it.
    const suffix = existing.slice(sectionEnd).replace(LEGACY_MAILBOX_SUPPLEMENT, '');
    const updated = prefix + MAILBOX_GUIDE_SECTION + (suffix ? '\n\n' + suffix : '\n');
    await writeFileAtomic(guidePath, updated);
    return 'updated';
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
