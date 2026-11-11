import fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { isBinaryFile } from 'isbinaryfile';
import { configManager } from '../config-manager.js';
import { resolveAbsolutePath } from '../handlers/filesystem-handlers.js';
import { executeToolForBridge, validateBridgeArtifactPath } from '../server.js';
import { ensureChromeAvailable } from '../tools/pdf/markdown.js';
import { toolArgSchemas } from '../tools/schemas.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { preloadFileSupport } from '../utils/files/index.js';
import { featureFlagManager } from '../utils/feature-flags.js';
import { BRIDGE_TOOL_NAMES, parseBridgeRequest, type BridgeCommand, type BridgeRequest } from './protocol.js';
import { discoverAgentQueuePaths, initializeAgentLayout, type AgentQueuePaths } from './agents.js';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STORAGE_BYTES = 3_000_000_000;
const STABILITY_CHECK_MS = 200;
const REQUEST_PARSE_SETTLE_MS = 2_000;
const BRIDGE_GUIDE_MARKER = '<!-- desktop-commander:bridge-guide:v5 -->';
const RECENT_FILE_CLEANUP_GRACE_MS = 60_000;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

interface BridgeSettings {
  directory?: string;
  pollIntervalMs: number;
  commandDelayMs: number;
  maxParallelRequests: number; // 0 means unlimited
  maxStorageBytes: number;
  consentAccepted: boolean;
}

interface CliOptions {
  directory?: string;
  pollIntervalMs?: number;
  commandDelayMs?: number;
  maxParallelRequests?: number;
  maxStorageGb?: number;
  help: boolean;
}

interface ArtifactRecord {
  path: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}

interface CommandResultRecord {
  index: number;
  tool: string;
  status: 'succeeded' | 'failed' | 'skipped' | 'outcome_unknown';
  isError: boolean;
  content?: unknown[];
  structuredContent?: unknown;
  artifacts?: ArtifactRecord[];
  error?: string;
}

interface LedgerCommand {
  state: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'outcome_unknown';
  result?: CommandResultRecord;
}

interface RequestLedger {
  protocol_version: 1;
  id: string;
  request_hash: string;
  state: 'running' | 'finished';
  started_at: string;
  updated_at: string;
  commands: LedgerCommand[];
}

interface BridgeResponse {
  protocol_version: 1;
  id: string;
  request_hash: string;
  status: 'completed' | 'partial_failure' | 'failed' | 'interrupted' | 'rejected' | 'discarded_by_quota';
  started_at: string;
  completed_at: string;
  results: CommandResultRecord[];
  artifacts: ArtifactRecord[];
  error?: string;
}

interface BridgePaths extends AgentQueuePaths {}
interface BridgeRootPaths {
  root: string;
  agents: string;
  stateDirectory: string;
}

function defaultSettings(): BridgeSettings {
  return {
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    commandDelayMs: 0,
    maxParallelRequests: 0,
    maxStorageBytes: DEFAULT_STORAGE_BYTES,
    consentAccepted: false,
  };
}

function stateDirectory(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DesktopCommanderBridge');
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'desktop-commander-bridge');
}

function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = { help: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
    } else if (flag === '--directory' || flag === '-d') {
      if (!args[i + 1]) throw new Error(flag + ' requires a directory path.');
      options.directory = args[++i];
    } else if (flag === '--poll-interval-ms') {
      options.pollIntervalMs = parseIntegerOption(flag, args[++i], 100, 60_000);
    } else if (flag === '--command-delay-ms') {
      options.commandDelayMs = parseIntegerOption(flag, args[++i], 0, 60_000);
    } else if (flag === '--max-parallel') {
      options.maxParallelRequests = parseIntegerOption(flag, args[++i], 0, 100_000);
    } else if (flag === '--max-storage-gb') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value <= 0 || value > 10_000) {
        throw new Error('--max-storage-gb must be a number greater than 0 and no more than 10000.');
      }
      options.maxStorageGb = value;
    } else {
      throw new Error('Unknown bridge option: ' + flag + '. Use --help to see available options.');
    }
  }
  return options;
}

function parseIntegerOption(flag: string, raw: string | undefined, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(flag + ' must be a whole number from ' + min + ' to ' + max + '.');
  }
  return value;
}

function printHelp(): void {
  console.log([
    'Desktop Commander file bridge',
    '',
    'Usage:',
    '  desktop-commander bridge [options]',
    '',
    'Options:',
    '  -d, --directory <path>     Local path to a dedicated cloud-synced folder',
    '      --poll-interval-ms <n> Poll fallback interval (default 1000; minimum 100)',
    '      --command-delay-ms <n> Delay between commands in one request (default 0)',
    '      --max-parallel <n>     Concurrent request-file limit; 0 means unlimited (default)',
    '      --max-storage-gb <n>   Bridge folder size limit (default 3 decimal GB)',
    '  -h, --help                 Show this help',
    '',
    'Requests from all agent folders execute concurrently. Commands inside one file execute sequentially.',
  ].join('\n'));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readSettings(filePath: string): Promise<BridgeSettings> {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<BridgeSettings>;
    const defaults = defaultSettings();
    return {
      directory: typeof raw.directory === 'string' ? raw.directory : undefined,
      pollIntervalMs: Number.isInteger(raw.pollIntervalMs) && raw.pollIntervalMs! >= 100 && raw.pollIntervalMs! <= 60_000
        ? raw.pollIntervalMs! : defaults.pollIntervalMs,
      commandDelayMs: Number.isInteger(raw.commandDelayMs) && raw.commandDelayMs! >= 0 && raw.commandDelayMs! <= 60_000
        ? raw.commandDelayMs! : defaults.commandDelayMs,
      maxParallelRequests: Number.isInteger(raw.maxParallelRequests) && raw.maxParallelRequests! >= 0
        ? raw.maxParallelRequests! : defaults.maxParallelRequests,
      maxStorageBytes: Number.isFinite(raw.maxStorageBytes) && raw.maxStorageBytes! > 0
        ? raw.maxStorageBytes! : defaults.maxStorageBytes,
      consentAccepted: raw.consentAccepted === true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSettings();
    console.warn('Could not read bridge settings; using defaults: ' + errorMessage(error));
    return defaultSettings();
  }
}

async function ask(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await readline.question(question)).trim();
  } finally {
    readline.close();
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2) + '\n');
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function acquireInstanceLock(stateDir: string): Promise<() => Promise<void>> {
  const lockPath = path.join(stateDir, 'bridge.lock');
  await fs.mkdir(stateDir, { recursive: true });

  const writeLock = async () => {
    const handle = await fs.open(lockPath, 'wx');
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), started_at: new Date().toISOString() }));
      await handle.sync();
    } finally {
      await handle.close();
    }
  };

  try {
    await writeLock();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let lock: { pid?: number; host?: string } = {};
    let lockMtime = 0;
    try {
      const stat = await fs.stat(lockPath);
      lockMtime = stat.mtimeMs;
      lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    } catch {
      if (Date.now() - lockMtime < 30_000) throw new Error('Another bridge instance may be starting. Try again shortly.');
    }

    if (lock.host === os.hostname() && Number.isInteger(lock.pid) && lock.pid! > 0) {
      try {
        process.kill(lock.pid!, 0);
        throw new Error('Desktop Commander Bridge is already running (PID ' + lock.pid + ').');
      } catch (checkError) {
        if (checkError instanceof Error && checkError.message.startsWith('Desktop Commander Bridge is already running')) throw checkError;
        if ((checkError as NodeJS.ErrnoException).code === 'EPERM') {
          throw new Error('Desktop Commander Bridge is already running (PID ' + lock.pid + ').');
        }
      }
    }

    await fs.rm(lockPath, { force: true });
    await writeLock();
  }

  return async () => {
    try {
      const lock = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid?: number };
      if (lock.pid === process.pid) await fs.rm(lockPath, { force: true });
    } catch {
      // Best-effort lock cleanup; a stale lock is recovered on the next start.
    }
  };
}

const TOOL_DESCRIPTIONS: Record<string, string> = {
  get_config: 'Read Desktop Commander configuration.',
  set_config_value: 'Set one Desktop Commander configuration value.',
  read_file: 'Read a file. Image and PDF image content is exported as an artifact file.',
  read_multiple_files: 'Read multiple files in one operation.',
  write_file: 'Create, rewrite, or append file contents.',
  write_pdf: 'Create a PDF or apply supported page operations to an existing PDF.',
  create_directory: 'Create a directory.',
  list_directory: 'List directory entries.',
  move_file: 'Move or rename a file or directory.',
  get_file_info: 'Read metadata about a file or directory.',
  edit_block: 'Apply a targeted text or structured-file edit.',
  start_search: 'Start a filesystem or content search session.',
  get_more_search_results: 'Read a page of results from a search session.',
  stop_search: 'Stop a running search session.',
  list_searches: 'List search sessions.',
  start_process: 'Start a terminal process or command.',
  read_process_output: 'Read output from a process session.',
  interact_with_process: 'Send input to a running process session.',
  force_terminate: 'Force-terminate a process session.',
  list_sessions: 'List Desktop Commander terminal sessions.',
  list_processes: 'List operating-system processes.',
  kill_process: 'Terminate an operating-system process by PID.',
  get_usage_stats: 'Read tool usage statistics.',
  get_recent_tool_calls: 'Read recent Desktop Commander tool call history.',
  give_feedback_to_desktop_commander: 'Open the Desktop Commander feedback form.',
};

export async function createGuideIfMissing(directory: string): Promise<void> {
  const guidePath = path.join(directory, 'README.md');
  const tick = String.fromCharCode(96);
  const fence3 = tick.repeat(3);
  const fence4 = tick.repeat(4);
  const blocks: string[] = [];
  for (const name of BRIDGE_TOOL_NAMES) {
    blocks.push([
      '### ' + name,
      '',
      TOOL_DESCRIPTIONS[name] || 'Desktop Commander tool.',
      '',
      'Argument schema:',
      '',
      fence3 + 'json',
      JSON.stringify(zodToJsonSchema(toolArgSchemas[name]), null, 2),
      fence3,
    ].join('\n'));
  }

  const guide = [
    '# Desktop Commander Bridge',
    '',
    BRIDGE_GUIDE_MARKER,
    '',
    'This README is the AI-facing operating guide for Desktop Commander file-queue bridges. It is the only agent-facing guide; request, response, and artifact files are protocol data, not documentation. It is shared by cloud-folder and GitHub repository transports.',
    '',
    '## Folder layout',
    '',
    '- agent-<uniqueid>/requests/ — submit <id>.json or <id>.md request files.',
    '- agent-<uniqueid>/responses/ — read matching <id>.json results.',
    '- agent-<uniqueid>/artifacts/ — binary outputs returned to that agent instance.',
    '- agent-<uniqueid>/ — one isolated workspace per conversation or subagent instance.',
    '- README.md — the only agent-facing guide.',
    '',
    '## AI Quick Start',
    '',
    '1. Confirm the local Desktop Commander Bridge is running and first-run consent has been accepted. Make sure the shared cloud folder or GitHub repository is accessible.',
    '2. Create a NEW unique folder for this conversation directly in the bridge root. Use the exact root-folder form agent-<uniqueid>, for example agent-7f3a91c2d4e6. The unique ID belongs to this conversation, not to the platform. Never share a folder between conversations, and never reuse another conversation\'s folder—even when both conversations use ChatGPT. Each subagent also gets its own unique folder. The folder identifies this agent instance; no separate registration or mailbox ID is needed.',
    '3. Use only this conversation\'s agent-<uniqueid>/ folder. It contains requests/, responses/, and artifacts/. Do not read or write another conversation\'s folder.',
    '4. Read this README once at the start of a fresh chat. It is the only operating guide. Keep the unique folder name for the entire conversation and reuse it only when continuing that same conversation.',
    '5. Choose a short request ID such as task-a1 or 7c2e91a4. Submit agent-<uniqueid>/requests/<id>.json with the same value in the JSON id field. Request IDs need only be unique within this conversation\'s folder.',
    '6. The result appears at agent-<uniqueid>/responses/<id>.json. Retrieve artifacts from the matching agent-<uniqueid>/artifacts/ folder.',
    '',
    'The bridge must be running on the computer that should execute the tools. The storage connector only submits requests and retrieves results; it does not execute commands. The unique folder identifies one agent instance (one conversation or subagent) and is its queue boundary.',
    '',
    '## Fast asynchronous workflow',
    '',
    'Use one request file per independent tool call inside this conversation\'s unique agent-instance folder. A successful write confirms only that the request reached bridge storage; it does not mean the command has finished. Request IDs are scoped to the agent-instance folder; folders are not shared by separate conversations that happen to use the same model or platform. Different request files execute concurrently by default, while commands within one request file execute sequentially.',
    '',
    'Keep the pipeline full: submit A and B, then check agent-<uniqueid>/responses/A.json. While B is running, submit C if it is independent. Retrieve known response paths directly instead of repeatedly listing response history.',
    '',
    'Example: upload agent-7f3a91c2d4e6/requests/task-a1.json and agent-7f3a91c2d4e6/requests/task-b2.json; read agent-7f3a91c2d4e6/responses/task-a1.json; then submit task-c3 if independent. Each request uses protocol_version 1, an id matching its filename, and a commands array containing the tool call.',
    '',
    'Use a single request file with multiple commands only when those commands must run in a known sequence and all later arguments are already known. If a later command needs data returned by an earlier command (for example, a PID or discovered path), wait for that result before submitting the dependent request. Never pretend independent requests are ordered relative to each other.',
    '',
    'For the fastest normal session: create and retain your unique conversation folder once, read this guide once, submit independent requests in a batch, and retrieve matching responses in a batch.',
    '',
    '## Failure recovery',
    '',
    '- Match each result by ID: agent-<uniqueid>/requests/<id>.json maps to agent-<uniqueid>/responses/<id>.json. The JSON id must match the filename.',
    '- Check the top-level status and every command status. A failed command stops later commands in that request; later commands are marked skipped.',
    '- If a response is not visible, check the exact request and response paths inside your agent-instance folder. If the request exists and the response does not, wait for the bridge to finish and check the exact response path again. Do not create a duplicate request while the original remains queued.',
    '- The bridge does not create per-request status files. Do not look for status/ or worker.json.',
    '- A rejected response usually means the request filename, ID, protocol version, tool name, or arguments failed validation. Correct the request and submit it with a new ID.',
    '- An outcome_unknown command may have performed its side effect. Inspect the target state before retrying; never blindly resubmit a potentially non-idempotent command.',
    '- An interrupted request may have completed some commands. Inspect its recorded results and current target state before deciding what to retry.',
    '- If artifacts are missing, verify the response artifact path and check that the corresponding agent-<uniqueid>/artifacts/<id>/ folder is visible in the connected storage before requesting the file again.',
    '',
    '## JSON request format',
    '',
    fence3 + 'json',
    JSON.stringify({
      protocol_version: 1,
      id: 'task-a1',
      command_delay_ms: 0,
      commands: [
        { tool: 'list_directory', arguments: { path: 'C:/Projects/MyApp', depth: 2 } },
        { tool: 'read_file', arguments: { path: 'C:/Projects/MyApp/package.json' } },
      ],
    }, null, 2),
    fence3,
    '',
    'Save this example as agent-<uniqueid>/requests/task-a1.json. The filename is the ID; copy that exact ID into the JSON id field. Short IDs are supported. Legacy request-<id>.json files remain accepted. command_delay_ms is optional (0–60000) and overrides the configured delay between commands in this file. The origin argument, when present, must be llm; ui is reserved for the local application and rejected by the bridge.',
    '',
    '## Fenced Markdown request format',
    '',
    'Save as agent-<uniqueid>/requests/<id>.md, for example agent-7f3a91c2d4e6/requests/task-b2.md. Each executable block contains one JSON tool call. Blocks execute in document order; ordinary prose and other code fences are ignored. Legacy request-<id>.md files remain accepted.',
    '',
    fence4 + 'markdown',
    '# Inspect a project',
    '',
    fence3 + 'desktop-commander-v1',
    JSON.stringify({ tool: 'list_directory', arguments: { path: 'C:/Projects/MyApp', depth: 2 } }, null, 2),
    fence3,
    '',
    fence3 + 'desktop-commander-v1',
    JSON.stringify({ tool: 'read_file', arguments: { path: 'C:/Projects/MyApp/package.json' } }, null, 2),
    fence3,
    fence4,
    '',
    '## Execution and performance',
    '',
    '- Requests from all agent folders share the configured concurrency limit. Different request files execute concurrently. The default concurrency limit is unlimited (--max-parallel 0). A positive --max-parallel value sets an optional cap.',
    '- Commands within one request file execute sequentially, in their listed order.',
    '- The default delay between commands is 0 ms. Configure it with --command-delay-ms or the JSON command_delay_ms property.',
    '- Cloud-folder mode uses filesystem notifications plus a one-second fallback scan. GitHub mode uses signed push webhooks through an optional Cloudflare Quick Tunnel and a five-second reconciliation poll to recover missed events. If webhook or local watcher setup is unavailable, GitHub mode uses five-second polling. Remote storage visibility latency depends on the provider and is not controlled by this application.',
    '- Independent requests run in parallel. Calls targeting the same file, process id, or search session are coordinated to avoid conflicting operations.',
    '- Publish each request file only after its complete contents are ready; never expose a partially-written request at its final request path.',
    '',
    '## Responses and artifacts',
    '',
    'Each accepted request produces agent-<uniqueid>/responses/<id>.json. Results preserve the tool content and report command status. Top-level status is completed, failed, partial_failure, interrupted, rejected, or discarded_by_quota.',
    '',
    'Image blocks returned by read_file, read_multiple_files, or PDF page extraction are written into agent-<uniqueid>/artifacts/<id>/. When a read tool returns a binary source file (such as a PDF, Office document, archive, audio/video file, or an otherwise unsupported binary), the original file is copied there too. The response lists each artifact path, MIME type, byte size, and SHA-256 hash. Binary bytes are not embedded as base64 in response JSON; retrieve the referenced artifact from this agent instance\'s folder in the same bridge storage. Cloud-folder mode can export a single artifact up to 256 MiB; GitHub mode limits each uploaded file to 50 MiB.',
    '',
    'Successfully created PDFs are also copied into the same agent artifact directory and referenced in the response.',
    '',
    'A request with a failed command stops at that command; later commands are marked skipped. If the process crashes after a command starts but before its result is durably recorded, the command is marked outcome_unknown and is not retried automatically.',
    '',
    '## Tool catalog',
    '',
    ...blocks,
  ].join('\n');

  try {
    const handle = await fs.open(guidePath, 'wx');
    try {
      await handle.writeFile(guide, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    console.log('Created ' + guidePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existingStat = await fs.lstat(guidePath);
    if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
      console.log('Existing non-regular README.md preserved: ' + guidePath);
    } else {
      const existing = await fs.readFile(guidePath, 'utf8');
      const isGeneratedGuide =
        (existing.startsWith('# Desktop Commander Bridge') || existing.startsWith('# Desktop Commander Cloud-Folder Bridge'))
        && existing.includes('This README is the AI-facing operating guide');
      if (isGeneratedGuide && existing !== guide) {
        await writeFileAtomic(guidePath, guide);
        console.log('Updated generated agent guide: ' + guidePath);
      } else {
        console.log('Existing README.md preserved: ' + guidePath);
      }
    }
  }

  // The generated README is the complete agent-facing guide. Agent folder
  // names provide identity; a separate agent identifier is not required.

}

class ResourceLocks {
  private readonly locks = new Map<string, {
    tail: Promise<void>;
    readers: Promise<void>[];
    activeReaders: number;
    pendingWriters: number;
  }>();

  async run<T>(keys: string[], mode: 'read' | 'write', operation: () => Promise<T>): Promise<T> {
    const unique = [...new Set(keys)].sort();
    if (!unique.length) return operation();

    const entries = unique.map((key) => {
      let state = this.locks.get(key);
      if (!state) {
        state = { tail: Promise.resolve(), readers: [], activeReaders: 0, pendingWriters: 0 };
        this.locks.set(key, state);
      }
      return { key, state };
    });

    const waits: Promise<void>[] = [];
    const releases: Array<() => void> = [];
    const readerGates: Array<{
      key: string;
      state: { tail: Promise<void>; readers: Promise<void>[]; activeReaders: number; pendingWriters: number };
      gate: Promise<void>;
    }> = [];
    const writerStates: Array<{
      key: string;
      state: { tail: Promise<void>; readers: Promise<void>[]; activeReaders: number; pendingWriters: number };
    }> = [];

    if (mode === 'read') {
      for (const { key, state } of entries) {
        waits.push(state.tail);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        state.readers.push(gate);
        state.activeReaders++;
        readerGates.push({ key, state, gate });
        releases.push(release);
      }
    } else {
      for (const { key, state } of entries) {
        waits.push(state.tail, ...state.readers);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        state.tail = gate;
        state.readers = [];
        state.pendingWriters++;
        writerStates.push({ key, state });
        releases.push(release);
      }
    }

    try {
      await Promise.all(waits);
      return await operation();
    } finally {
      for (const release of releases) release();
      for (const { key, state, gate } of readerGates) {
        state.readers = state.readers.filter((pending) => pending !== gate);
        state.activeReaders--;
        if (state.activeReaders === 0 && state.pendingWriters === 0 && this.locks.get(key) === state) {
          this.locks.delete(key);
        }
      }
      for (const { key, state } of writerStates) {
        state.pendingWriters--;
        if (state.activeReaders === 0 && state.pendingWriters === 0 && this.locks.get(key) === state) {
          this.locks.delete(key);
        }
      }
    }
  }
}

const resourceLocks = new ResourceLocks();

function commandLockMode(command: BridgeCommand): 'read' | 'write' {
  return [
    'get_config',
    'read_file',
    'read_multiple_files',
    'get_file_info',
    'list_directory',
    'start_search',
  ].includes(command.tool) ? 'read' : 'write';
}

function commandResourceKeys(command: BridgeCommand): string[] {
  const keys: string[] = [];
  const visited = new Set<object>();
  const isPathKey = (key: string): boolean =>
    key.toLowerCase() === 'path'
    || key.toLowerCase().endsWith('path')
    || key.toLowerCase() === 'source'
    || key.toLowerCase() === 'destination'
    || key.toLowerCase() === 'paths';

  const visit = (value: unknown, key = '', depth = 0): void => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (!isPathKey(key) || !value.trim() || /^https?:\/\//i.test(value)) return;
      let resolved = path.resolve(resolveAbsolutePath(value));
      if (process.platform === 'win32') resolved = resolved.toLowerCase();
      keys.push('path:' + resolved);
      return;
    }
    if (typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
    } else {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        visit(nestedValue, nestedKey, depth + 1);
      }
    }
  };

  for (const [name, value] of Object.entries(command.arguments)) {
    if (isPathKey(name)) visit(value, name);
  }

  const args = command.arguments;
  if (typeof args.pid === 'number' && [
    'read_process_output', 'interact_with_process', 'force_terminate', 'kill_process',
  ].includes(command.tool)) {
    keys.push('pid:' + args.pid);
  }
  if (typeof args.sessionId === 'string' && [
    'get_more_search_results', 'stop_search',
  ].includes(command.tool)) {
    keys.push('search:' + args.sessionId);
  }
  if (command.tool === 'get_config' || command.tool === 'set_config_value') {
    keys.push('config:global');
  }
  if (command.tool === 'set_config_value' && typeof args.key === 'string') {
    keys.push('config:' + args.key);
  }
  return [...new Set(keys)];
}

function extensionForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(';')[0].trim();
  const known: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/avif': '.avif',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/octet-stream': '.bin',
  };
  return known[normalized] || '.bin';
}

function mimeTypeForFilePath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const known: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
    '.xls': 'application/vnd.ms-excel',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
    '.odp': 'application/vnd.oasis.opendocument.presentation',
    '.zip': 'application/zip',
    '.7z': 'application/x-7z-compressed',
    '.rar': 'application/vnd.rar',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.aiff': 'audio/aiff',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.avif': 'image/avif',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.exe': 'application/vnd.microsoft.portable-executable',
    '.dll': 'application/vnd.microsoft.portable-executable',
  };
  return known[extension] || 'application/octet-stream';
}

async function exportOriginalBinaryFile(
  root: string,
  requestId: string,
  filePath: string,
  commandIndex: number,
  artifactIndex: number,
): Promise<ArtifactRecord | undefined> {
  const absolutePath = await validateBridgeArtifactPath(filePath);
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(absolutePath)) return undefined;
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) return undefined;
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw new Error('Binary source exceeds the bridge artifact export limit of ' + MAX_ARTIFACT_BYTES + ' bytes (' + stat.size + ' bytes).');
  }
  if (!await isBinaryFile(absolutePath).catch(() => false)) return undefined;
  const bytes = await fs.readFile(absolutePath);
  const baseName = path.basename(absolutePath).replace(/[^A-Za-z0-9._-]/g, '_');
  return writeArtifact(
    root,
    requestId,
    'command-' + String(commandIndex + 1).padStart(3, '0') + '-source-' +
      String(artifactIndex + 1).padStart(2, '0') + '-' + baseName,
    mimeTypeForFilePath(absolutePath),
    bytes,
  );
}

async function exportReadSourceArtifacts(
  root: string,
  requestId: string,
  command: BridgeCommand,
  commandIndex: number,
): Promise<{ artifacts: ArtifactRecord[]; errors: string[] }> {
  if (command.tool !== 'read_file' && command.tool !== 'read_multiple_files') {
    return { artifacts: [], errors: [] };
  }
  if (command.tool === 'read_file' && command.arguments.isUrl === true) {
    return { artifacts: [], errors: [] };
  }

  const values = command.tool === 'read_file'
    ? [command.arguments.path]
    : Array.isArray(command.arguments.paths) ? command.arguments.paths : [];
  const artifacts: ArtifactRecord[] = [];
  const errors: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    try {
      const artifact = await exportOriginalBinaryFile(root, requestId, value, commandIndex, artifacts.length);
      if (artifact) artifacts.push(artifact);
    } catch (error) {
      errors.push(path.basename(value) + ': ' + errorMessage(error));
    }
  }
  return { artifacts, errors };
}

function decodeBase64Payload(input: string): Buffer {
  const match = /^data:[^;,]+;base64,(.*)$/s.exec(input.trim());
  const compact = (match ? match[1] : input).replace(/\s/g, '');
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error('The tool returned image data that is not valid base64.');
  }
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const estimatedBytes = Math.floor(compact.length * 3 / 4) - padding;
  if (estimatedBytes > MAX_ARTIFACT_BYTES) {
    throw new Error('Image artifact exceeds the per-file export safety limit of ' + MAX_ARTIFACT_BYTES + ' bytes.');
  }
  return Buffer.from(compact, 'base64');
}

async function ensureSafeBridgeDirectory(root: string, directory: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Bridge subdirectory must be a real directory, not a symlink or file: ' + directory);
  }
  const realDirectory = await fs.realpath(directory);
  const relative = path.relative(realRoot, realDirectory);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Bridge subdirectory resolves outside the selected cloud folder: ' + directory);
  }
}

async function writeArtifact(
  root: string,
  requestId: string,
  filename: string,
  mimeType: string,
  bytes: Buffer,
): Promise<ArtifactRecord> {
  if (bytes.length === 0) throw new Error('Refusing to write an empty artifact.');
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    throw new Error('Artifact exceeds the per-file export safety limit of ' + MAX_ARTIFACT_BYTES + ' bytes.');
  }
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  const relativePath = path.posix.join('artifacts', requestId, safeName);
  const fullPath = path.join(root, 'artifacts', requestId, safeName);
  await ensureSafeBridgeDirectory(root, path.dirname(fullPath));
  await writeFileAtomic(fullPath, bytes);
  return {
    path: relativePath,
    mimeType,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function exportToolArtifacts(
  root: string,
  requestId: string,
  command: BridgeCommand,
  commandIndex: number,
  result: Awaited<ReturnType<typeof executeToolForBridge>>,
): Promise<{ content: unknown[]; artifacts: ArtifactRecord[] }> {
  const content: unknown[] = [];
  const artifacts: ArtifactRecord[] = [];
  let imageIndex = 0;

  for (const rawItem of result.content || []) {
    const item = rawItem as unknown as Record<string, unknown>;
    const inlineData = item.type === 'image' && typeof item.data === 'string'
      ? item.data
      : item.type === 'resource' && isRecord(item.resource) && typeof item.resource.blob === 'string'
        ? String(item.resource.blob)
        : undefined;

    if (inlineData !== undefined) {
      const mimeType = typeof item.mimeType === 'string'
        ? item.mimeType
        : isRecord(item.resource) && typeof item.resource.mimeType === 'string'
          ? String(item.resource.mimeType)
          : 'application/octet-stream';
      imageIndex++;
      try {
        const bytes = decodeBase64Payload(inlineData);
        const ext = extensionForMime(mimeType);
        const artifact = await writeArtifact(
          root,
          requestId,
          'command-' + String(commandIndex + 1).padStart(3, '0') + '-image-' + String(imageIndex).padStart(2, '0') + ext,
          mimeType,
          bytes,
        );
        artifacts.push(artifact);
        content.push({
          type: 'text',
          text: 'Image artifact saved to ' + artifact.path + ' (' + artifact.bytes + ' bytes, ' + artifact.mimeType + ').',
        });
      } catch (error) {
        content.push({ type: 'text', text: 'Image artifact export failed: ' + errorMessage(error) });
      }
      continue;
    }
    content.push(rawItem);
  }

  if (command.tool === 'write_pdf' && !result.isError) {
    const pathArg = typeof command.arguments.outputPath === 'string'
      ? command.arguments.outputPath
      : typeof command.arguments.path === 'string' ? command.arguments.path : undefined;
    if (pathArg) {
      try {
        const sourcePath = await validateBridgeArtifactPath(pathArg);
        const stat = await fs.stat(sourcePath);
        if (!stat.isFile()) throw new Error('PDF output path is not a regular file.');
        if (stat.size > MAX_ARTIFACT_BYTES) {
          throw new Error('PDF output exceeds the bridge artifact export limit of ' + MAX_ARTIFACT_BYTES + ' bytes (' + stat.size + ' bytes).');
        }
        const bytes = await fs.readFile(sourcePath);
        const baseName = path.basename(sourcePath);
        artifacts.push(await writeArtifact(root, requestId, 'command-' + String(commandIndex + 1).padStart(3, '0') + '-' + baseName, 'application/pdf', bytes));
      } catch (error) {
        content.push({
          type: 'text',
          text: 'PDF artifact export failed; the original output remains at the tool-reported path. ' + errorMessage(error),
        });
      }
    }
  }

  if (!result.isError) {
    const sourceExports = await exportReadSourceArtifacts(root, requestId, command, commandIndex);
    for (const artifact of sourceExports.artifacts) {
      artifacts.push(artifact);
      content.push({
        type: 'text',
        text: 'Original binary source copied to ' + artifact.path + ' (' + artifact.bytes + ' bytes, ' + artifact.mimeType + ').',
      });
    }
    for (const error of sourceExports.errors) {
      content.push({ type: 'text', text: 'Original binary source could not be exported: ' + error });
    }
  }

  return { content, artifacts };
}

function toCommandResult(
  index: number,
  command: BridgeCommand,
  status: CommandResultRecord['status'],
  result?: Awaited<ReturnType<typeof executeToolForBridge>>,
  content?: unknown[],
  artifacts: ArtifactRecord[] = [],
  error?: string,
): CommandResultRecord {
  return {
    index,
    tool: command.tool,
    status,
    isError: status === 'failed' || status === 'outcome_unknown' || !!result?.isError,
    ...(content ? { content } : result?.content ? { content: result.content } : {}),
    ...(result?.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    ...(artifacts.length ? { artifacts } : {}),
    ...(error ? { error } : {}),
  };
}

function appendSkippedCommands(
  ledger: RequestLedger,
  request: BridgeRequest,
  startIndex: number,
  results: CommandResultRecord[],
  reason: string,
): void {
  for (let index = startIndex; index < request.commands.length; index++) {
    const existing = ledger.commands[index];
    if (existing.state === 'skipped' && existing.result) {
      results.push(existing.result);
      continue;
    }
    const skipped = toCommandResult(
      index,
      request.commands[index],
      'skipped',
      undefined,
      undefined,
      [],
      reason,
    );
    ledger.commands[index] = { state: 'skipped', result: skipped };
    results.push(skipped);
  }
}

function responseStatus(results: CommandResultRecord[], interrupted: boolean): BridgeResponse['status'] {
  if (interrupted || results.some((result) => result.status === 'outcome_unknown')) return 'interrupted';
  const failedIndex = results.findIndex((result) => result.status === 'failed');
  if (failedIndex === -1) return 'completed';
  return failedIndex === 0 ? 'failed' : 'partial_failure';
}

function combineArtifacts(results: CommandResultRecord[]): ArtifactRecord[] {
  return results.flatMap((result) => result.artifacts || []);
}

async function commitResponse(
  responsesDirectory: string,
  id: string,
  requestHash: string,
  startedAt: string,
  results: CommandResultRecord[],
  status: BridgeResponse['status'],
  error?: string,
  responseFilename = 'response-' + id + '.json',
): Promise<BridgeResponse> {
  const response: BridgeResponse = {
    protocol_version: 1,
    id,
    request_hash: requestHash,
    status,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    results,
    artifacts: combineArtifacts(results),
    ...(error ? { error } : {}),
  };
  const responsePath = path.join(responsesDirectory, responseFilename);
  const existing = await readJsonIfExists<BridgeResponse>(responsePath);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new Error('A response with this id already exists for different request content. Use a new request id.');
    }
    return existing;
  }
  await writeJsonAtomic(responsePath, response);
  return response;
}

async function writeRejectedResponse(
  root: string,
  id: string,
  requestHash: string,
  error: string,
  responseFilename = 'response-' + id + '.json',
): Promise<void> {
  await commitResponse(
    path.join(root, 'responses'),
    id,
    requestHash,
    new Date().toISOString(),
    [],
    'rejected',
    error,
    responseFilename,
  );
}

function requestIdFromFilename(filename: string): string | undefined {
  const match = /^(?:request-)?([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.(json|md)$/i.exec(filename);
  return match?.[1];
}

function commandNeedsOfficeSupport(command: BridgeCommand): boolean {
  if (command.tool === 'write_pdf' || command.tool === 'start_search') return true;
  const pathValues: string[] = [];
  for (const [key, value] of Object.entries(command.arguments)) {
    if ((key === 'path' || key === 'file_path') && typeof value === 'string') pathValues.push(value);
    if (key === 'paths' && Array.isArray(value)) {
      pathValues.push(...value.filter((item): item is string => typeof item === 'string'));
    }
  }
  return pathValues.some((filePath) => /\.(pdf|docx|xlsx|xlsm|xls)$/i.test(filePath));
}

async function stableRead(filePath: string): Promise<Buffer | null> {
  try {
    const first = await fs.stat(filePath);
    if (!first.isFile()) return null;
    await new Promise((resolve) => setTimeout(resolve, STABILITY_CHECK_MS));
    const second = await fs.stat(filePath);
    if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) return null;
    const bytes = await fs.readFile(filePath);
    const third = await fs.stat(filePath);
    if (second.size !== third.size || second.mtimeMs !== third.mtimeMs || bytes.length !== third.size) return null;
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function processRequestFile(
  paths: BridgePaths,
  filePath: string,
  settings: BridgeSettings,
  fileSupportPromise: Promise<boolean>,
  activeFiles: Set<string>,
  activeResponseFiles: Set<string>,
  doneRequests: Map<string, string>,
  invalidRequestObservations: Map<string, { requestHash: string; firstSeenAt: number }>,
  cleanup: () => Promise<void>,
): Promise<void> {
  const filename = path.basename(filePath);
  const id = requestIdFromFilename(filename);
  if (!id) return;
  const responseFilename = /^request-/i.test(filename) ? 'response-' + id + '.json' : id + '.json';
  const bytes = await stableRead(filePath);
  if (!bytes) return;
  const requestHash = createHash('sha256').update(bytes).digest('hex');

  const requestKey = paths.agentId + ':' + id;
  const knownHash = doneRequests.get(requestKey);
  if (knownHash) {
    if (knownHash !== requestHash) {
      console.error('Agent ' + paths.agentId + ' request ID conflict: ' + filename + ' was changed after it was processed.');
      doneRequests.set(requestKey, requestHash);
    }
    return;
  }

  const responsePath = path.join(paths.responses, responseFilename);
  const alternateResponseFilename = responseFilename === id + '.json' ? 'response-' + id + '.json' : id + '.json';
  const existingResponse = await readJsonIfExists<BridgeResponse>(responsePath)
    ?? await readJsonIfExists<BridgeResponse>(path.join(paths.responses, alternateResponseFilename));
  if (existingResponse) {
    if (existingResponse.request_hash !== requestHash) {
      console.error('Agent ' + paths.agentId + ' request ID conflict: a different response already exists for ' + id + '.');
    }
    doneRequests.set(requestKey, requestHash);
    return;
  }

  let request: BridgeRequest;
  try {
    request = parseBridgeRequest(filename, bytes.toString('utf8'));
  } catch (error) {
    const observation = invalidRequestObservations.get(requestKey);
    if (!observation || observation.requestHash !== requestHash) {
      invalidRequestObservations.set(requestKey, { requestHash, firstSeenAt: Date.now() });
      console.warn('Agent ' + paths.agentId + ' request ' + filename + ' is not valid yet; waiting briefly for cloud-folder synchronization to finish.');
      return;
    }
    if (Date.now() - observation.firstSeenAt < REQUEST_PARSE_SETTLE_MS) return;
    invalidRequestObservations.delete(requestKey);
    await writeRejectedResponse(paths.root, id, requestHash, errorMessage(error), responseFilename);
    doneRequests.set(requestKey, requestHash);
    console.error('Agent ' + paths.agentId + ' rejected ' + filename + ': ' + errorMessage(error));
    return;
  }
  invalidRequestObservations.delete(requestKey);

  const ledgerPath = path.join(paths.ledgers, id + '.json');
  let ledger = await readJsonIfExists<RequestLedger>(ledgerPath);
  if (ledger && ledger.request_hash !== requestHash) {
    await writeRejectedResponse(paths.root, id, requestHash, 'This request id was previously used with different content. Use a new id.', responseFilename);
    doneRequests.set(requestKey, requestHash);
    return;
  }

  if (!ledger) {
    const now = new Date().toISOString();
    ledger = {
      protocol_version: 1,
      id,
      request_hash: requestHash,
      state: 'running',
      started_at: now,
      updated_at: now,
      commands: request.commands.map(() => ({ state: 'pending' })),
    };
    await writeJsonAtomic(ledgerPath, ledger);
  } else if (ledger.commands.length !== request.commands.length) {
    await writeRejectedResponse(paths.root, id, requestHash, 'The saved processing record does not match the command count in this request.', responseFilename);
    doneRequests.set(requestKey, requestHash);
    return;
  }

  const results: CommandResultRecord[] = [];
  let interrupted = false;
  const priorRunning = ledger.commands.findIndex((entry) => entry.state === 'running');

  if (ledger.state === 'running' && priorRunning >= 0) {
    interrupted = true;
    for (let i = 0; i < ledger.commands.length; i++) {
      if (ledger.commands[i].state === 'completed' || ledger.commands[i].state === 'failed') {
        if (ledger.commands[i].result) results.push(ledger.commands[i].result!);
      } else if (i === priorRunning) {
        const result = toCommandResult(i, request.commands[i], 'outcome_unknown', undefined, undefined, [], 'The application stopped after this command started; its side effects may have occurred. It was not run again.');
        ledger.commands[i] = { state: 'outcome_unknown', result };
        results.push(result);
      } else if (ledger.commands[i].state === 'pending' || ledger.commands[i].state === 'running') {
        const result = toCommandResult(i, request.commands[i], 'skipped', undefined, undefined, [], 'Skipped because the previous run was interrupted.');
        ledger.commands[i] = { state: 'skipped', result };
        results.push(result);
      } else if (ledger.commands[i].state === 'skipped' && ledger.commands[i].result) {
        results.push(ledger.commands[i].result!);
      }
    }
    ledger.state = 'finished';
    ledger.updated_at = new Date().toISOString();
    await writeJsonAtomic(ledgerPath, ledger);
  } else if (ledger.state === 'finished') {
    for (let i = 0; i < ledger.commands.length; i++) {
      if (ledger.commands[i].result) results.push(ledger.commands[i].result!);
    }
    await commitResponse(paths.responses, id, requestHash, ledger.started_at, results, responseStatus(results, false), undefined, responseFilename);
    doneRequests.set(requestKey, requestHash);
    await cleanup();
    return;
  }

  if (!interrupted) {
    for (let i = 0; i < request.commands.length; i++) {
      const command = request.commands[i];
      const commandState = ledger.commands[i];
      if (commandState.state === 'completed' || commandState.state === 'failed') {
        if (commandState.result) results.push(commandState.result);
        if (commandState.state === 'failed') {
          appendSkippedCommands(ledger, request, i + 1, results, 'Skipped because an earlier command failed.');
          break;
        }
        continue;
      }
      if (commandState.state === 'skipped') {
        if (commandState.result) results.push(commandState.result);
        appendSkippedCommands(ledger, request, i + 1, results, 'Skipped because an earlier command failed or the previous run was interrupted.');
        break;
      }

      if (commandNeedsOfficeSupport(command)) {
        const supportReady = await fileSupportPromise;
        if (!supportReady) {
          const result = toCommandResult(i, command, 'failed', undefined, undefined, [], 'Document support initialization failed.');
          ledger.commands[i] = { state: 'failed', result };
          results.push(result);
          appendSkippedCommands(
            ledger,
            request,
            i + 1,
            results,
            'Skipped because document support initialization failed.',
          );
          ledger.updated_at = new Date().toISOString();
          await writeJsonAtomic(ledgerPath, ledger);
          break;
        }
      }

      ledger.commands[i] = { state: 'running' };
      ledger.updated_at = new Date().toISOString();
      await writeJsonAtomic(ledgerPath, ledger);

      let toolResult: Awaited<ReturnType<typeof executeToolForBridge>>;
      let exported: { content: unknown[]; artifacts: ArtifactRecord[] };
      try {
        const outcome = await resourceLocks.run(
          commandResourceKeys(command),
          commandLockMode(command),
          async () => {
            let executed: Awaited<ReturnType<typeof executeToolForBridge>>;
            try {
              if (command.tool === 'write_pdf') await ensureChromeAvailable();
              executed = await executeToolForBridge(command.tool, command.arguments);
            } catch (error) {
              executed = {
                content: [{ type: 'text', text: 'Error: ' + errorMessage(error) }],
                isError: true,
              };
            }

            try {
              const artifacts = await exportToolArtifacts(paths.root, id, command, i, executed);
              return { executed, artifacts };
            } catch (error) {
              const fallbackContent = (executed.content || []).filter((item) => {
                const candidate = item as unknown as Record<string, unknown>;
                const resource = candidate.resource as { blob?: unknown } | undefined;
                return !(candidate.type === 'image' && typeof candidate.data === 'string')
                  && !(candidate.type === 'resource' && resource && typeof resource.blob === 'string');
              });
              fallbackContent.push({
                type: 'text',
                text: 'Tool execution finished, but bridge artifact export failed: ' + errorMessage(error),
              });
              return {
                executed,
                artifacts: { content: fallbackContent, artifacts: [] },
              };
            }
          },
        );
        toolResult = outcome.executed;
        exported = outcome.artifacts;
      } catch (error) {
        toolResult = {
          content: [{ type: 'text', text: 'Error: ' + errorMessage(error) }],
          isError: true,
        };
        exported = { content: toolResult.content || [], artifacts: [] };
      }
      const status: CommandResultRecord['status'] = toolResult.isError ? 'failed' : 'succeeded';
      const record = toCommandResult(i, command, status, toolResult, exported.content, exported.artifacts);
      ledger.commands[i] = { state: status === 'failed' ? 'failed' : 'completed', result: record };
      ledger.updated_at = new Date().toISOString();
      await writeJsonAtomic(ledgerPath, ledger);
      results.push(record);

      if (status === 'failed') {
        for (let rest = i + 1; rest < request.commands.length; rest++) {
          const skipped = toCommandResult(rest, request.commands[rest], 'skipped', undefined, undefined, [], 'Skipped because an earlier command failed.');
          ledger.commands[rest] = { state: 'skipped', result: skipped };
          results.push(skipped);
        }
        ledger.updated_at = new Date().toISOString();
        await writeJsonAtomic(ledgerPath, ledger);
        break;
      }

      const delay = request.command_delay_ms ?? settings.commandDelayMs;
      if (delay > 0 && i < request.commands.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  ledger.state = 'finished';
  ledger.updated_at = new Date().toISOString();
  await writeJsonAtomic(ledgerPath, ledger);
  const status = responseStatus(results, interrupted);
  activeResponseFiles.add(responsePath);
  try {
    await commitResponse(paths.responses, id, requestHash, ledger.started_at, results, status, undefined, responseFilename);
    doneRequests.set(requestKey, requestHash);
  } finally {
    activeResponseFiles.delete(responsePath);
  }
  console.log('Agent ' + paths.agentId + ' request ' + id + ': ' + status + ' (' + results.length + ' command result(s)).');
  await cleanup();
}

async function collectRegularFiles(directory: string): Promise<Array<{ path: string; size: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number }>> {
  const files: Array<{ path: string; size: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number }> = [];
  const visit = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath).catch(() => null);
        if (stat?.isFile()) files.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs });
      }
    }
  };
  await visit(directory);
  return files;
}

async function cleanStorage(
  paths: BridgePaths,
  maxStorageBytes: number,
  activeFiles: Set<string>,
  activeResponseFiles: Set<string>,
): Promise<void> {
  const files = await collectRegularFiles(paths.root);
  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes <= maxStorageBytes) return;

  const protectedPaths = new Set<string>([path.join(paths.root, 'README.md'), ...activeFiles, ...activeResponseFiles]);
  const normalizeForComparison = (filePath: string): string => {
    const normalized = path.resolve(filePath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  for (const file of activeFiles) {
    const id = requestIdFromFilename(path.basename(file));
    if (id) protectedPaths.add(path.join(paths.artifacts, id));
  }
  const normalizedProtectedPaths = [...protectedPaths].map(normalizeForComparison);
  const isActiveNow = (filePath: string): boolean => {
    const normalized = normalizeForComparison(filePath);
    for (const activeRequest of activeFiles) {
      const requestPath = normalizeForComparison(activeRequest);
      if (normalized === requestPath || normalized.startsWith(requestPath + '.')) return true;
      const activeId = requestIdFromFilename(path.basename(activeRequest));
      if (activeId) {
        const artifactPath = normalizeForComparison(path.join(paths.artifacts, activeId));
        if (normalized === artifactPath || normalized.startsWith(artifactPath + path.sep)) return true;
      }
    }
    for (const activeResponse of activeResponseFiles) {
      const responsePath = normalizeForComparison(activeResponse);
      if (normalized === responsePath || normalized.startsWith(responsePath + '.')) return true;
    }
    return false;
  };
  const isProtected = (filePath: string): boolean => {
    const normalized = normalizeForComparison(filePath);
    for (const protectedPath of normalizedProtectedPaths) {
      if (normalized === protectedPath || normalized.startsWith(protectedPath + path.sep) || normalized.startsWith(protectedPath + '.')) return true;
    }
    return false;
  };

  const cleanupCutoff = Date.now() - RECENT_FILE_CLEANUP_GRACE_MS;
  const candidates = files.filter((file) => !isProtected(file.path)
      && !isActiveNow(file.path)
      && Math.max(file.mtimeMs, file.ctimeMs, file.birthtimeMs || 0) <= cleanupCutoff)
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  let deleted = 0;
  for (const candidate of candidates) {
    if (totalBytes <= maxStorageBytes) break;
    if (isProtected(candidate.path) || isActiveNow(candidate.path)) continue;
    const filename = path.basename(candidate.path);
    const id = requestIdFromFilename(filename);
    if (id && path.dirname(candidate.path) === paths.requests) {
      const responseFilename = /^request-/i.test(filename) ? 'response-' + id + '.json' : id + '.json';
      const responsePath = path.join(paths.responses, responseFilename);
      const alternateResponseFilename = responseFilename === id + '.json' ? 'response-' + id + '.json' : id + '.json';
      const existing = await readJsonIfExists<BridgeResponse>(responsePath)
        ?? await readJsonIfExists<BridgeResponse>(path.join(paths.responses, alternateResponseFilename));
      if (!existing && !isActiveNow(candidate.path)) {
        const requestBytes = await fs.readFile(candidate.path).catch(() => null);
        if (requestBytes && !isActiveNow(candidate.path)) {
          const requestHash = createHash('sha256').update(requestBytes).digest('hex');
          await commitResponse(
            paths.responses,
            id,
            requestHash,
            new Date().toISOString(),
            [],
            'discarded_by_quota',
            'The unprocessed request file was deleted because the bridge storage quota was exceeded.',
            responseFilename,
          ).catch((error) => console.warn('Could not write quota-discard response for ' + id + ': ' + errorMessage(error)));
        }
      }
    }

    try {
      if (isProtected(candidate.path) || isActiveNow(candidate.path)) continue;
      const stat = await fs.lstat(candidate.path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (isProtected(candidate.path) || isActiveNow(candidate.path)) continue;
      await fs.unlink(candidate.path);
      totalBytes -= candidate.size;
      deleted++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Storage cleanup could not delete ' + candidate.path + ': ' + errorMessage(error));
      }
    }
  }

  if (deleted > 0) {
    console.log('Storage cleanup removed ' + deleted + ' oldest file(s); usage is approximately ' + totalBytes + ' of ' + maxStorageBytes + ' bytes.');
  }
  const remainingFiles = await collectRegularFiles(paths.root);
  totalBytes = remainingFiles.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > maxStorageBytes) {
    console.warn('Bridge storage remains above its configured limit because protected or ineligible files account for the remaining ' + totalBytes + ' bytes.');
  }
}

/**
 * Request polling is the durable fallback when filesystem notifications fail.
 * Do not unref this timer: the watcher may close, and this timer must keep the
 * bridge alive so it can continue discovering synchronized request files.
 */
export function createBridgePollingTimer(scanRequests: () => void, intervalMs: number): NodeJS.Timeout {
  return setInterval(scanRequests, intervalMs);
}

async function runBridgeRuntime(rootPaths: BridgeRootPaths, settings: BridgeSettings): Promise<void> {
  const activeFiles = new Set<string>();
  const activeResponseFiles = new Set<string>();
  const activeJobs = new Map<string, Promise<void>>();
  const activeRequestIds = new Set<string>();
  const doneRequests = new Map<string, string>();
  const invalidRequestObservations = new Map<string, { requestHash: string; firstSeenAt: number }>();
  const agentPathsByName = new Map<string, BridgePaths>();
  const requestWatchers = new Map<string, FSWatcher>();
  const fileSupportPromise = preloadFileSupport()
    .then(() => true)
    .catch((error) => {
      console.error('Optional document support failed to preload: ' + errorMessage(error));
      return false;
    });

  let agentsWatcher: FSWatcher | undefined;
  let stopped = false;
  let scanning = false;
  let scanAgain = false;
  let cleanupRunning = false;
  let cleanupRequested = false;

  const addRequestWatcher = (directory: string): void => {
    if (requestWatchers.has(directory)) return;
    try {
      const handle = watch(directory, { persistent: true }, () => { void scanRequests(); });
      handle.on('error', (error) => {
        console.warn('Request watcher failed for ' + directory + '; fallback polling remains active: ' + error.message);
        handle.close();
        requestWatchers.delete(directory);
      });
      requestWatchers.set(directory, handle);
    } catch (error) {
      console.warn('Filesystem notifications unavailable for ' + directory + '; fallback polling remains active: ' + errorMessage(error));
    }
  };

  const discoverAgents = async (): Promise<BridgePaths[]> => {
    const discovered = await discoverAgentQueuePaths(rootPaths.agents, rootPaths.stateDirectory) as BridgePaths[];
    for (const paths of discovered) {
      agentPathsByName.set(paths.agentId, paths);
      addRequestWatcher(paths.requests);
    }
    return discovered;
  };

  const cleanup = async (): Promise<void> => {
    if (cleanupRunning) {
      cleanupRequested = true;
      return;
    }
    cleanupRunning = true;
    try {
      do {
        cleanupRequested = false;
        for (const paths of agentPathsByName.values()) {
          try {
            await cleanStorage(paths, settings.maxStorageBytes, activeFiles, activeResponseFiles);
          } catch (error) {
            console.warn('Storage cleanup failed for agent ' + paths.agentId + ': ' + errorMessage(error));
          }
        }
      } while (cleanupRequested);
    } finally {
      cleanupRunning = false;
    }
  };

  const scanRequests = async (): Promise<void> => {
    if (stopped) return;
    if (scanning) {
      scanAgain = true;
      return;
    }
    scanning = true;
    try {
      do {
        scanAgain = false;
        const agents = await discoverAgents();
        const candidates: Array<{ paths: BridgePaths; path: string; id: string; key: string; mtimeMs: number }> = [];
        const presentRequestKeys = new Set<string>();
        for (const paths of agents) {
          const entries = await fs.readdir(paths.requests, { withFileTypes: true });
          for (const entry of entries) {
            const id = entry.isFile() ? requestIdFromFilename(entry.name) : undefined;
            if (!id) continue;
            const key = paths.agentId + ':' + id;
            presentRequestKeys.add(key);
            const fullPath = path.join(paths.requests, entry.name);
            if (activeJobs.has(fullPath) || activeRequestIds.has(key)) continue;
            const stat = await fs.stat(fullPath).catch(() => null);
            if (stat?.isFile()) candidates.push({ paths, path: fullPath, id, key, mtimeMs: stat.mtimeMs });
          }
        }

        for (const key of invalidRequestObservations.keys()) {
          if (!presentRequestKeys.has(key)) invalidRequestObservations.delete(key);
        }
        candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));

        for (const candidate of candidates) {
          if (settings.maxParallelRequests > 0 && activeJobs.size >= settings.maxParallelRequests) break;
          if (activeJobs.has(candidate.path) || activeRequestIds.has(candidate.key)) continue;
          activeFiles.add(candidate.path);
          activeRequestIds.add(candidate.key);
          const task = processRequestFile(
            candidate.paths,
            candidate.path,
            settings,
            fileSupportPromise,
            activeFiles,
            activeResponseFiles,
            doneRequests,
            invalidRequestObservations,
            cleanup,
          ).catch((error) => {
            console.error('Request processing failed (' + candidate.paths.agentId + '/' + path.basename(candidate.path) + '): ' + errorMessage(error));
          }).finally(() => {
            activeFiles.delete(candidate.path);
            activeRequestIds.delete(candidate.key);
            activeJobs.delete(candidate.path);
            void scanRequests();
          });
          activeJobs.set(candidate.path, task);
        }
      } while (scanAgain && !stopped);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Could not scan agent request folders: ' + errorMessage(error));
      }
    } finally {
      scanning = false;
      if (scanAgain && !stopped) void scanRequests();
    }
  };

  try {
    agentsWatcher = watch(rootPaths.agents, { persistent: true }, () => { void scanRequests(); });
    agentsWatcher.on('error', (error) => {
      console.warn('Agent-folder watcher error; fallback polling remains active: ' + error.message);
    });
  } catch (error) {
    console.warn('Agent-folder notifications unavailable; fallback polling remains active: ' + errorMessage(error));
  }

  // Polling is the durable discovery fallback for cloud-sync providers and
  // newly created agent folders. Per-agent watchers reduce normal latency.
  const pollTimer = createBridgePollingTimer(() => { void scanRequests(); }, settings.pollIntervalMs);
  const cleanupTimer = setInterval(() => { void cleanup(); }, 60_000);
  cleanupTimer.unref();

  let resolveStop!: () => void;
  const stopSignal = new Promise<void>((resolve) => { resolveStop = resolve; });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    agentsWatcher?.close();
    for (const watcher of requestWatchers.values()) watcher.close();
    requestWatchers.clear();
    clearInterval(pollTimer);
    clearInterval(cleanupTimer);
    resolveStop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log('');
  console.log('Desktop Commander Bridge is running.');
  console.log('Bridge root: ' + rootPaths.root);
  console.log('Agent queues: agent-<uniqueid>/{requests,responses,artifacts}/');
  console.log('Parallel request limit: ' + (settings.maxParallelRequests === 0 ? 'unlimited' : settings.maxParallelRequests));
  console.log('Delay between commands in one request: ' + settings.commandDelayMs + ' ms');
  console.log('Polling fallback: ' + settings.pollIntervalMs + ' ms');
  console.log('Storage limit per agent: ' + settings.maxStorageBytes + ' bytes');
  console.log('Press Ctrl+C to stop.');
  console.log('');

  await scanRequests();
  await stopSignal;
  await Promise.allSettled([...activeJobs.values()]);
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  await cleanup();
}

export async function runBridge(args: string[] = []): Promise<void> {
  const options = parseCliOptions(args);
  if (options.help) {
    printHelp();
    return;
  }

  const stateDir = stateDirectory();
  await fs.mkdir(stateDir, { recursive: true });
  const releaseLock = await acquireInstanceLock(stateDir);
  try {
    const settingsPath = path.join(stateDir, 'settings.json');
    const settings = await readSettings(settingsPath);
    const previousDirectory = settings.directory;

    if (options.directory) settings.directory = path.resolve(options.directory);
    if (options.pollIntervalMs !== undefined) settings.pollIntervalMs = options.pollIntervalMs;
    if (options.commandDelayMs !== undefined) settings.commandDelayMs = options.commandDelayMs;
    if (options.maxParallelRequests !== undefined) settings.maxParallelRequests = options.maxParallelRequests;
    if (options.maxStorageGb !== undefined) settings.maxStorageBytes = Math.round(options.maxStorageGb * 1_000_000_000);
    if (previousDirectory && settings.directory) {
      const previous = path.resolve(previousDirectory);
      const next = path.resolve(settings.directory);
      const same = process.platform === 'win32'
        ? previous.toLowerCase() === next.toLowerCase()
        : previous === next;
      if (!same) settings.consentAccepted = false;
    }

    if (!settings.directory) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('No bridge directory is configured. Start interactively or pass --directory <path>.');
      }
      settings.directory = path.resolve(await ask('Local path to a dedicated cloud-synced folder: '));
    }
    if (!settings.directory) throw new Error('A bridge directory is required.');

    const root = path.resolve(settings.directory);
    await fs.mkdir(root, { recursive: true });
    const realRoot = await fs.realpath(root);
    if (path.parse(realRoot).root === realRoot) {
      throw new Error('Choose a dedicated folder, not a filesystem or drive root.');
    }

    if (!settings.consentAccepted) {
      console.log('');
      console.log('SECURITY WARNING');
      console.log('Any person or AI account with write access to this synced folder can trigger local Desktop Commander tools.');
      console.log('Desktop Commander can read/write files and run terminal commands. Its built-in restrictions are not an OS sandbox.');
      console.log('Use a dedicated cloud folder and share it only with accounts you trust.');
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('First start requires interactive local consent. Run the executable in a terminal.');
      }
      const answer = await ask('Type YES to enable automatic execution from this folder: ');
      if (answer !== 'YES') throw new Error('Bridge startup cancelled; local consent was not granted.');
      settings.consentAccepted = true;
    }

    settings.directory = realRoot;
    await writeJsonAtomic(settingsPath, settings);

    const agentsRoot = await initializeAgentLayout(realRoot, stateDir);
    const paths: BridgeRootPaths = {
      root: realRoot,
      agents: agentsRoot,
      stateDirectory: stateDir,
    };
    await createGuideIfMissing(realRoot);

    await configManager.loadConfig();
    await featureFlagManager.initialize();
    await runBridgeRuntime(paths, settings);
  } finally {
    await releaseLock();
  }
}
