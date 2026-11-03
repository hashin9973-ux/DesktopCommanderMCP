import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import lockfile from 'proper-lockfile';
import { CONFIG_FILE } from './config.js';
import { writeFileAtomic } from './utils/atomic-write.js';

export interface MailboxUser {
  id: string;
  username: string;
  createdAt: string;
  lastActivityAt: string;
}
export interface MailboxMessage {
  id: string;
  fromUserId: string;
  toUserId: string;
  body: string;
  createdAt: string;
  readAt?: string;
}
interface MailboxDatabase {
  version: 1;
  users: MailboxUser[];
  messages: MailboxMessage[];
}
export interface MailboxFilters {
  user?: string;
  from?: string;
  to?: string;
  unreadOnly?: boolean;
  limit?: number;
}

const DATABASE_PATH = path.join(path.dirname(CONFIG_FILE), 'mailbox.json');
const EMPTY_DATABASE: MailboxDatabase = { version: 1, users: [], messages: [] };
let inProcessQueue: Promise<unknown> = Promise.resolve();

function normalizeUsername(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
function resolveUser(db: MailboxDatabase, value: string | undefined): MailboxUser | undefined {
  if (!value) return undefined;
  return db.users.find(user => user.id === value || normalizeUsername(user.username) === normalizeUsername(value));
}
function validateMessage(body: string): string {
  const value = body.trim();
  if (!value) throw new Error('Message body cannot be empty.');
  if (value.length > 20000) throw new Error('Message body cannot exceed 20,000 characters.');
  return value;
}
async function ensureDatabase(): Promise<void> {
  await fs.mkdir(path.dirname(DATABASE_PATH), { recursive: true });
  try {
    const handle = await fs.open(DATABASE_PATH, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(EMPTY_DATABASE, null, 2) + '\n'); }
    finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
async function withDatabase<T>(mutate: (db: MailboxDatabase) => Promise<T> | T, write = false): Promise<T> {
  const run = async () => {
    await ensureDatabase();
    const release = await lockfile.lock(DATABASE_PATH, { retries: { retries: 20, minTimeout: 25, maxTimeout: 250 } });
    try {
      let db: MailboxDatabase;
      try {
        db = JSON.parse(await fs.readFile(DATABASE_PATH, 'utf8')) as MailboxDatabase;
      } catch (error) {
        throw new Error(`Mailbox database could not be read safely: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (db.version !== 1 || !Array.isArray(db.users) || !Array.isArray(db.messages)) {
        throw new Error('Mailbox database has an unsupported or invalid format; no changes were made.');
      }
      const result = await mutate(db);
      if (write) await writeFileAtomic(DATABASE_PATH, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
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
    const clean = username.trim().normalize('NFKC');
    if (!clean || clean.length > 64 || /[\u0000-\u001f\u007f]/u.test(clean)) {
      throw new Error('Username must be 1–64 printable characters.');
    }
    return withDatabase(db => {
      const existing = db.users.find(user => normalizeUsername(user.username) === normalizeUsername(clean));
      if (existing) return { user: existing, existing: true };
      const now = new Date().toISOString();
      const user = { id: randomUUID(), username: clean, createdAt: now, lastActivityAt: now };
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
        id: randomUUID(), fromUserId: sender.id, toUserId: recipient.id, body: messageBody, createdAt: now,
      };
      db.messages.push(message);
      return message;
    }, true);
  },

  async inboxUnread(userId: string): Promise<{ user: MailboxUser; messages: Array<MailboxMessage & { from: string }> }> {
    return withDatabase(db => {
      const user = resolveUser(db, userId);
      if (!user) throw new Error('Mailbox identity not found. Register first or check mailbox_user_id.');
      const unread = db.messages.filter(message => message.toUserId === user.id && !message.readAt);
      const now = new Date().toISOString();
      for (const message of unread) message.readAt = now;
      user.lastActivityAt = now;
      return {
        user,
        messages: unread.map(message => ({ ...message, from: db.users.find(item => item.id === message.fromUserId)?.username ?? 'deleted user' })),
      };
    }, true);
  },

  async listUsers(): Promise<Array<MailboxUser & { lastActivity: string; unreadCount: number }>> {
    return withDatabase(db => db.users
      .slice()
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
      .map(user => ({
        ...user,
        lastActivity: formatRelativeActivity(user.lastActivityAt),
        unreadCount: db.messages.filter(message => message.toUserId === user.id && !message.readAt).length,
      })));
  },

  async read(filters: MailboxFilters = {}): Promise<Array<MailboxMessage & { from: string; to: string }>> {
    return withDatabase(db => {
      const selectedUser = resolveUser(db, filters.user);
      if (filters.user && !selectedUser) throw new Error(`User not found: ${filters.user}`);
      const fromUser = resolveUser(db, filters.from);
      const toUser = resolveUser(db, filters.to);
      if (filters.from && !fromUser) throw new Error(`Sender not found: ${filters.from}`);
      if (filters.to && !toUser) throw new Error(`Recipient not found: ${filters.to}`);
      const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 100), 1), 1000);
      return db.messages
        .filter(message => !selectedUser || message.fromUserId === selectedUser.id || message.toUserId === selectedUser.id)
        .filter(message => !fromUser || message.fromUserId === fromUser.id)
        .filter(message => !toUser || message.toUserId === toUser.id)
        .filter(message => !filters.unreadOnly || !message.readAt)
        .slice(-limit)
        .map(message => ({
          ...message,
          from: db.users.find(user => user.id === message.fromUserId)?.username ?? 'deleted user',
          to: db.users.find(user => user.id === message.toUserId)?.username ?? 'deleted user',
        }));
    });
  },

  async unreadCount(userId: string): Promise<number> {
    return withDatabase(db => {
      const user = resolveUser(db, userId);
      if (!user) return 0;
      return db.messages.filter(message => message.toUserId === user.id && !message.readAt).length;
    });
  },

  async renameUser(user: string, username: string): Promise<MailboxUser> {
    const clean = username.trim().normalize('NFKC');
    if (!clean || clean.length > 64 || /[\u0000-\u001f\u007f]/u.test(clean)) throw new Error('Username must be 1–64 printable characters.');
    return withDatabase(db => {
      const target = resolveUser(db, user);
      if (!target) throw new Error(`User not found: ${user}`);
      if (db.users.some(item => item.id !== target.id && normalizeUsername(item.username) === normalizeUsername(clean))) {
        throw new Error('That username is already registered.');
      }
      target.username = clean;
      target.lastActivityAt = new Date().toISOString();
      return target;
    }, true);
  },

  async deleteUser(user: string): Promise<{ user: MailboxUser; deletedMessages: number }> {
    return withDatabase(db => {
      const target = resolveUser(db, user);
      if (!target) throw new Error(`User not found: ${user}`);
      db.users = db.users.filter(item => item.id !== target.id);
      const before = db.messages.length;
      db.messages = db.messages.filter(message => message.fromUserId !== target.id && message.toUserId !== target.id);
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
    const user = await this.register('User');
    return this.send(user.user.id, to, body);
  },
};
