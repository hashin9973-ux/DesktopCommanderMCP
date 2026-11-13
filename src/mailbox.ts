import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { CONFIG_FILE } from './config.js';
import { writeFileAtomic } from './utils/atomic-write.js';
import { isValidAgentWorkspacePath } from './bridge/agents.js';

export interface MailboxMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  createdAt: string;
  readAt?: string;
}

interface LegacyMailboxArchive {
  sourceVersion: 1 | 2;
  users: unknown[];
  messages: unknown[];
  archivedAt: string;
}

interface MailboxDatabase {
  version: 3;
  messages: MailboxMessage[];
  legacyArchive?: LegacyMailboxArchive;
}

export interface MailboxFilters {
  unreadOnly?: boolean;
  limit?: number;
}

const DATABASE_PATH = path.join(path.dirname(CONFIG_FILE), 'mailbox.json');
const LOCK_PATH = DATABASE_PATH + '.lockfile';
const EMPTY_DATABASE: MailboxDatabase = { version: 3, messages: [] };
const MARKER_PATTERN = /^unread-messages-\d+\.txt$/;
let inProcessQueue: Promise<unknown> = Promise.resolve();

function validateWorkspacePath(value: string): string {
  const clean = value.trim();
  if (!isValidAgentWorkspacePath(clean)) {
    throw new Error('Mailbox identity must be the complete Bridge workspace path, such as agent-parent/subagents/agent-child.');
  }
  return clean;
}

function validateMessage(body: string): string {
  const value = body.trim();
  if (!value) throw new Error('Message body cannot be empty.');
  if (value.length > 20000) throw new Error('Message body cannot exceed 20,000 characters.');
  return value;
}

function migrateLegacyDatabase(value: {
  version: 1 | 2;
  users: unknown[];
  messages: unknown[];
}): MailboxDatabase {
  // A legacy username cannot be mapped safely to a hierarchical workspace
  // path: the same leaf agent ID can exist under different parents. Preserve
  // the old records verbatim instead of assigning them to the wrong agent.
  return {
    version: 3,
    messages: [],
    legacyArchive: {
      sourceVersion: value.version,
      users: value.users,
      messages: value.messages,
      archivedAt: new Date().toISOString(),
    },
  };
}

async function ensureLockFile(): Promise<void> {
  await fs.mkdir(path.dirname(DATABASE_PATH), { recursive: true });
  // Lock a stable sidecar file, not the database inode: the database itself is
  // atomically replaced on writes, while this lock target must never change.
  const handle = await fs.open(LOCK_PATH, 'a', 0o600);
  await handle.close();
}

async function withDatabase<T>(
  operation: (db: MailboxDatabase) => Promise<T> | T,
  write = false,
): Promise<T> {
  const run = async () => {
    await ensureLockFile();
    const release = await lockfile.lock(LOCK_PATH, {
      retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
    });
    try {
      let db: MailboxDatabase;
      let migrated = false;
      try {
        const parsed = JSON.parse(await fs.readFile(DATABASE_PATH, 'utf8')) as {
          version?: number;
          users?: unknown;
          messages?: unknown;
        };
        if (parsed.version === 3 && Array.isArray(parsed.messages)) {
          db = parsed as MailboxDatabase;
        } else if ((parsed.version === 1 || parsed.version === 2)
          && Array.isArray(parsed.users) && Array.isArray(parsed.messages)) {
          db = migrateLegacyDatabase({
            version: parsed.version,
            users: parsed.users,
            messages: parsed.messages,
          });
          migrated = true;
        } else {
          throw new Error('Mailbox database has an unsupported or invalid format; no changes were made.');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          db = { ...EMPTY_DATABASE, messages: [] };
        } else {
          throw new Error('Mailbox database could not be read safely: ' +
            (error instanceof Error ? error.message : String(error)));
        }
      }
      const result = await operation(db);
      if (migrated || write) {
        await writeFileAtomic(DATABASE_PATH, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
      }
      return result;
    } finally {
      await release();
    }
  };
  const next = inProcessQueue.catch(() => undefined).then(run);
  inProcessQueue = next;
  return next as Promise<T>;
}

function safeLimit(value: number | undefined, fallback = 100): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Mailbox limit must be an integer from 1 to 1000.');
  }
  return limit;
}

function unreadFor(db: MailboxDatabase, workspacePath: string): MailboxMessage[] {
  return db.messages
    .filter(message => message.to === workspacePath && !message.readAt)
    .sort((left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
}

async function ensureRealDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Mailbox notification queue must be a real directory: ' + directory);
  }
}

async function reconcileMarkers(
  workspacePath: string,
  requestsDirectory: string,
  responsesDirectory: string,
  count: number,
): Promise<void> {
  const name = 'unread-messages-' + count + '.txt';
  const contents = [
    'Unread mailbox messages: ' + count,
    'Bridge workspace: ' + workspacePath,
    'Use mailbox action=inbox_unread; an optional limit reads only that many messages.',
    'Only messages returned by inbox_unread are marked as read.',
    'Informational notification marker only; this is not an executable Bridge request.',
    '',
  ].join('\n');

  const markerBytes = Buffer.from(contents, 'utf8');
  for (const directory of [requestsDirectory, responsesDirectory]) {
    await ensureRealDirectory(directory);
    const markerPath = path.join(directory, name);
    let existing: Buffer | undefined;
    try {
      existing = await fs.readFile(markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!existing?.equals(markerBytes)) {
      await writeFileAtomic(markerPath, contents, { mode: 0o600 });
    }
  }

  for (const directory of [requestsDirectory, responsesDirectory]) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!MARKER_PATTERN.test(entry.name) || entry.name === name) continue;
      const stalePath = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        throw new Error('Refusing to replace a directory with a mailbox notification marker: ' + stalePath);
      }
      await fs.unlink(stalePath);
    }
  }
}

export const mailboxStore = {
  async send(from: string, to: string, body: string): Promise<MailboxMessage> {
    const sender = validateWorkspacePath(from);
    const recipient = validateWorkspacePath(to);
    const messageBody = validateMessage(body);
    return withDatabase(db => {
      const message: MailboxMessage = {
        id: randomUUID(),
        from: sender,
        to: recipient,
        body: messageBody,
        createdAt: new Date().toISOString(),
      };
      db.messages.push(message);
      return message;
    }, true);
  },

  async inboxUnread(workspace: string, requestedLimit?: number): Promise<{
    messages: MailboxMessage[];
    unreadCount: number;
  }> {
    const identity = validateWorkspacePath(workspace);
    const limit = safeLimit(requestedLimit, 50);
    return withDatabase(db => {
      const unread = unreadFor(db, identity);
      const messages = unread.slice(0, limit);
      const now = new Date().toISOString();
      const selectedIds = new Set(messages.map(message => message.id));
      for (const message of db.messages) {
        if (selectedIds.has(message.id)) message.readAt = now;
      }
      return { messages, unreadCount: unread.length - messages.length };
    }, true);
  },

  async read(workspace: string, filters: MailboxFilters = {}): Promise<MailboxMessage[]> {
    const identity = validateWorkspacePath(workspace);
    const limit = safeLimit(filters.limit, 100);
    return withDatabase(db => db.messages
      .filter(message => filters.unreadOnly
        ? message.to === identity && !message.readAt
        : message.from === identity || message.to === identity)
      .slice(-limit));
  },

  async unreadCount(workspace: string): Promise<number> {
    const identity = validateWorkspacePath(workspace);
    return withDatabase(db => unreadFor(db, identity).length);
  },

  async listAgentPaths(): Promise<string[]> {
    return withDatabase(db => [...new Set(db.messages.flatMap(message => [message.from, message.to]))].sort());
  },

  async syncUnreadMarkers(
    workspace: string,
    requestsDirectory: string,
    responsesDirectory: string,
  ): Promise<number> {
    const identity = validateWorkspacePath(workspace);
    return withDatabase(async db => {
      const count = unreadFor(db, identity).length;
      await reconcileMarkers(identity, requestsDirectory, responsesDirectory, count);
      return count;
    });
  },

  async deleteMessage(messageId: string): Promise<boolean> {
    return withDatabase(db => {
      const before = db.messages.length;
      db.messages = db.messages.filter(message => message.id !== messageId);
      return db.messages.length !== before;
    }, true);
  },

  async editMessage(messageId: string, body: string): Promise<MailboxMessage> {
    const clean = validateMessage(body);
    return withDatabase(db => {
      const message = db.messages.find(item => item.id === messageId);
      if (!message) throw new Error('Message not found: ' + messageId);
      message.body = clean;
      return message;
    }, true);
  },
};
