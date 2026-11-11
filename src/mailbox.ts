import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import lockfile from 'proper-lockfile';
import { CONFIG_FILE } from './config.js';
import { writeFileAtomic } from './utils/atomic-write.js';

export interface MailboxUser {
  username: string;
  createdAt: string;
  lastActivityAt: string;
}
export interface MailboxMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  createdAt: string;
  readAt?: string;
}
interface MailboxDatabase {
  version: 2;
  users: MailboxUser[];
  messages: MailboxMessage[];
}
interface LegacyMailboxUser {
  id: string;
  username: string;
  createdAt: string;
  lastActivityAt: string;
}
interface LegacyMailboxMessage {
  id: string;
  fromUserId: string;
  toUserId: string;
  body: string;
  createdAt: string;
  readAt?: string;
}
interface LegacyMailboxDatabase {
  version: 1;
  users: LegacyMailboxUser[];
  messages: LegacyMailboxMessage[];
}
export interface MailboxFilters {
  user?: string;
  from?: string;
  to?: string;
  unreadOnly?: boolean;
  limit?: number;
}

const DATABASE_PATH = path.join(path.dirname(CONFIG_FILE), 'mailbox.json');
const LOCK_PATH = DATABASE_PATH + '.lockfile';
const EMPTY_DATABASE: MailboxDatabase = { version: 2, users: [], messages: [] };
let inProcessQueue: Promise<unknown> = Promise.resolve();

function normalizeUsername(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
function resolveUser(db: MailboxDatabase, value: string | undefined): MailboxUser | undefined {
  if (!value) return undefined;
  return db.users.find(user => normalizeUsername(user.username) === normalizeUsername(value));
}
function validateUsername(username: string): string {
  const clean = username.trim().normalize('NFKC');
  if (!clean || clean.length > 64 || /[\u0000-\u001f\u007f]/u.test(clean)) {
    throw new Error('Username must be 1–64 printable characters.');
  }
  return clean;
}
function validateMessage(body: string): string {
  const value = body.trim();
  if (!value) throw new Error('Message body cannot be empty.');
  if (value.length > 20000) throw new Error('Message body cannot exceed 20,000 characters.');
  return value;
}
function migrateLegacyDatabase(value: LegacyMailboxDatabase): MailboxDatabase {
  const usernamesById = new Map(value.users.map(user => [user.id, user.username]));
  return {
    version: 2,
    users: value.users.map(({ username, createdAt, lastActivityAt }) => ({
      username,
      createdAt,
      lastActivityAt,
    })),
    messages: value.messages.map(message => ({
      id: message.id,
      from: usernamesById.get(message.fromUserId) ?? 'deleted user',
      to: usernamesById.get(message.toUserId) ?? 'deleted user',
      body: message.body,
      createdAt: message.createdAt,
      ...(message.readAt ? { readAt: message.readAt } : {}),
    })),
  };
}
async function ensureLockFile(): Promise<void> {
  await fs.mkdir(path.dirname(DATABASE_PATH), { recursive: true });
  // Lock a stable sidecar file, not the database inode: the database itself is
  // atomically replaced on writes, while this lock target must never change.
  const handle = await fs.open(LOCK_PATH, 'a', 0o600);
  await handle.close();
}
async function withDatabase<T>(mutate: (db: MailboxDatabase) => Promise<T> | T, write = false): Promise<T> {
  const run = async () => {
    await ensureLockFile();
    const release = await lockfile.lock(LOCK_PATH, { retries: { retries: 20, minTimeout: 25, maxTimeout: 250 } });
    try {
      let db: MailboxDatabase;
      let migrated = false;
      try {
        const parsed = JSON.parse(await fs.readFile(DATABASE_PATH, 'utf8')) as MailboxDatabase | LegacyMailboxDatabase;
        if (parsed.version === 1 && Array.isArray(parsed.users) && Array.isArray(parsed.messages)) {
          db = migrateLegacyDatabase(parsed as LegacyMailboxDatabase);
          migrated = true;
        } else if (parsed.version === 2 && Array.isArray(parsed.users) && Array.isArray(parsed.messages)) {
          db = parsed as MailboxDatabase;
        } else {
          throw new Error('Mailbox database has an unsupported or invalid format; no changes were made.');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          db = { ...EMPTY_DATABASE, users: [], messages: [] };
        } else {
          throw new Error(`Mailbox database could not be read safely: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const result = await mutate(db);
      if (migrated || write) {
        await writeFileAtomic(DATABASE_PATH, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
      }
      return result;
    } finally {
      await release();
    }
  };
  const next = inProcessQueue.catch(() => {}).then(run);
  inProcessQueue = next;
  return next as Promise<T>;
}

export function formatRelativeActivity(timestamp: string | undefined): string {
  if (!timestamp) return 'never';
  const elapsed = Math.max(0, Date.now() - Date.parse(timestamp));
  if (!Number.isFinite(elapsed)) return 'unknown';
  const minute = 60_000, hour = 60 * minute, day = 24 * hour;
  if (elapsed < minute) return 'just now';
  if (elapsed < hour) return `${Math.floor(elapsed / minute)} minute${Math.floor(elapsed / minute) === 1 ? '' : 's'} ago`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)} hour${Math.floor(elapsed / hour) === 1 ? '' : 's'} ago`;
  const days = Math.floor(elapsed / day);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export const mailboxStore = {
  async register(username: string): Promise<{ user: MailboxUser; existing: boolean }> {
    const clean = validateUsername(username);
    return withDatabase(db => {
      const existing = db.users.find(user => normalizeUsername(user.username) === normalizeUsername(clean));
      if (existing) return { user: existing, existing: true };
      const now = new Date().toISOString();
      const user = { username: clean, createdAt: now, lastActivityAt: now };
      db.users.push(user);
      return { user, existing: false };
    }, true);
  },

  async send(from: string, to: string, body: string): Promise<MailboxMessage> {
    const messageBody = validateMessage(body);
    return withDatabase(db => {
      const sender = resolveUser(db, from);
      const recipient = resolveUser(db, to);
      if (!sender) throw new Error(`Sender not found: ${from}`);
      if (!recipient) throw new Error(`Recipient not found: ${to}`);
      const now = new Date().toISOString();
      sender.lastActivityAt = now;
      recipient.lastActivityAt = now;
      const message: MailboxMessage = {
        id: randomUUID(), from: sender.username, to: recipient.username, body: messageBody, createdAt: now,
      };
      db.messages.push(message);
      return message;
    }, true);
  },

  async inboxUnread(username: string): Promise<{ user: MailboxUser; messages: MailboxMessage[] }> {
    return withDatabase(db => {
      const user = resolveUser(db, username);
      if (!user) throw new Error('Mailbox username not found. Register the username first.');
      const unread = db.messages.filter(message => normalizeUsername(message.to) === normalizeUsername(user.username) && !message.readAt);
      const now = new Date().toISOString();
      for (const message of unread) message.readAt = now;
      user.lastActivityAt = now;
      return { user, messages: unread };
    }, true);
  },

  async listUsers(): Promise<Array<MailboxUser & { lastActivity: string; unreadCount: number }>> {
    return withDatabase(db => db.users
      .slice()
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
      .map(user => ({
        ...user,
        lastActivity: formatRelativeActivity(user.lastActivityAt),
        unreadCount: db.messages.filter(message => normalizeUsername(message.to) === normalizeUsername(user.username) && !message.readAt).length,
      })));
  },

  async read(filters: MailboxFilters = {}): Promise<MailboxMessage[]> {
    return withDatabase(db => {
      const selectedUser = resolveUser(db, filters.user);
      if (filters.user && !selectedUser) throw new Error(`User not found: ${filters.user}`);
      const fromUser = resolveUser(db, filters.from);
      const toUser = resolveUser(db, filters.to);
      if (filters.from && !fromUser) throw new Error(`Sender not found: ${filters.from}`);
      if (filters.to && !toUser) throw new Error(`Recipient not found: ${filters.to}`);
      const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 100), 1), 1000);
      return db.messages
        .filter(message => !selectedUser
          || normalizeUsername(message.from) === normalizeUsername(selectedUser.username)
          || normalizeUsername(message.to) === normalizeUsername(selectedUser.username))
        .filter(message => !fromUser || normalizeUsername(message.from) === normalizeUsername(fromUser.username))
        .filter(message => !toUser || normalizeUsername(message.to) === normalizeUsername(toUser.username))
        .filter(message => !filters.unreadOnly || !message.readAt)
        .slice(-limit);
    });
  },

  async unreadCount(username: string): Promise<number> {
    return withDatabase(db => {
      const user = resolveUser(db, username);
      if (!user) return 0;
      return db.messages.filter(message => normalizeUsername(message.to) === normalizeUsername(user.username) && !message.readAt).length;
    });
  },

  async renameUser(user: string, username: string): Promise<MailboxUser> {
    const clean = validateUsername(username);
    return withDatabase(db => {
      const target = resolveUser(db, user);
      if (!target) throw new Error(`User not found: ${user}`);
      if (db.users.some(item => normalizeUsername(item.username) === normalizeUsername(clean)
        && normalizeUsername(item.username) !== normalizeUsername(target.username))) {
        throw new Error('That username is already registered.');
      }
      const oldUsername = target.username;
      target.username = clean;
      target.lastActivityAt = new Date().toISOString();
      for (const message of db.messages) {
        if (normalizeUsername(message.from) === normalizeUsername(oldUsername)) message.from = clean;
        if (normalizeUsername(message.to) === normalizeUsername(oldUsername)) message.to = clean;
      }
      return target;
    }, true);
  },

  async deleteUser(user: string): Promise<{ user: MailboxUser; deletedMessages: number }> {
    return withDatabase(db => {
      const target = resolveUser(db, user);
      if (!target) throw new Error(`User not found: ${user}`);
      db.users = db.users.filter(item => normalizeUsername(item.username) !== normalizeUsername(target.username));
      const before = db.messages.length;
      db.messages = db.messages.filter(message =>
        normalizeUsername(message.from) !== normalizeUsername(target.username)
        && normalizeUsername(message.to) !== normalizeUsername(target.username));
      return { user: target, deletedMessages: before - db.messages.length };
    }, true);
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
      if (!message) throw new Error(`Message not found: ${messageId}`);
      message.body = clean;
      return message;
    }, true);
  },

  async sendAsUser(to: string, body: string): Promise<MailboxMessage> {
    await this.register('User');
    return this.send('User', to, body);
  },
};
