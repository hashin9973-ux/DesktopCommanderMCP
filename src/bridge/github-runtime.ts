import { spawn, type ChildProcess } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../utils/atomic-write.js';
import {
  getGitHubAccessToken,
  refreshGitHubAccessTokenForWebhooks,
  GitHubApiError,
  GitHubRepositoryClient,
} from './github.js';
import { GitHubBridgeSync } from './github-sync.js';
import { startCloudflareQuickTunnel, startGitHubWebhookServer, type QuickTunnel, type GitHubWebhookServer } from './github-webhook.js';

interface StoredBridgeSettings {
  githubRepository?: string;
  githubConsentAccepted?: boolean;
  githubConsentRepository?: string;
  githubPublicConsentAccepted?: boolean;
  githubPublicConsentRepository?: string;
  githubPollIntervalMs?: number;
  githubReconcilePollIntervalMs?: number;
  githubWebhookRepository?: string;
  githubWebhookId?: number;
  githubWebhookSecret?: string;
  maxParallelRequests?: number;
  [key: string]: unknown;
}

interface GitHubCliOptions {
  repository?: string;
  createRepository?: string;
  pollIntervalMs?: number;
  maxParallelRequests?: number;
  disableWebhook?: boolean;
  help: boolean;
}

function stateDirectory(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DesktopCommanderBridge');
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'desktop-commander-bridge');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseIntegerOption(flag: string, raw: string | undefined, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(flag + ' must be a whole number from ' + min + ' to ' + max + '.');
  }
  return value;
}

function parseOptions(args: string[]): GitHubCliOptions {
  const options: GitHubCliOptions = { help: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
    } else if (flag === '--github-repository') {
      if (!args[i + 1]) throw new Error(flag + ' requires owner/name.');
      options.repository = args[++i];
    } else if (flag === '--create-github-repository') {
      if (!args[i + 1]) throw new Error(flag + ' requires a repository name.');
      options.createRepository = args[++i];
    } else if (flag === '--poll-interval-ms') {
      options.pollIntervalMs = parseIntegerOption(flag, args[++i], 1_000, 60_000);
    } else if (flag === '--no-github-webhook') {
      options.disableWebhook = true;
    } else if (flag === '--max-parallel') {
      options.maxParallelRequests = parseIntegerOption(flag, args[++i], 0, 100_000);
    } else {
      throw new Error('Unknown GitHub bridge option: ' + flag + '. Use --help to see available options.');
    }
  }
  if (options.repository && options.createRepository) {
    throw new Error('Choose either --github-repository or --create-github-repository, not both.');
  }
  return options;
}

function printHelp(): void {
  console.log([
    'Desktop Commander GitHub repository bridge',
    '',
    'Usage:',
    '  desktop-commander bridge --provider github [options]',
    '',
    'Options:',
    '  --github-repository <owner/name>  Connect to an existing writable repository',
    '  --create-github-repository <name> Create a new private repository for your account',
    '  --poll-interval-ms <n>            Reconciliation poll interval (default 60000 with webhooks; minimum 1000)',
    '  --no-github-webhook               Disable push notifications and use polling only',
    '  --max-parallel <n>                Concurrent request-file limit; 0 means unlimited',
    '  -h, --help                        Show this help',
    '',
    'GitHub mode writes queue files directly to the repository existing default branch. It does not create branches or pull requests.',
  ].join('\n'));
}

async function ask(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await readline.question(question)).trim();
  } finally {
    readline.close();
  }
}

async function readSettings(filePath: string): Promise<StoredBridgeSettings> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Bridge settings must contain a JSON object.');
    }
    return value as StoredBridgeSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Could not read Desktop Commander Bridge settings: ' + errorMessage(error));
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2) + '\n');
}

async function acquireBridgeLock(stateDir: string): Promise<() => Promise<void>> {
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
      if (Date.now() - lockMtime < 30_000) throw new Error('Another Desktop Commander Bridge instance may be starting. Try again shortly.');
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
      // Best-effort cleanup; stale locks are recovered on the next start.
    }
  };
}

async function chooseRepository(
  token: string,
  settings: StoredBridgeSettings,
): Promise<string> {
  const savedRepository = settings.githubRepository;
  if (typeof savedRepository === 'string' && savedRepository) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return savedRepository;
    const useSaved = await ask('Use the previously configured repository ' + savedRepository + '? [Y/n] ');
    if (!useSaved || /^y(es)?$/i.test(useSaved)) return savedRepository;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'GitHub repository is not configured. Start this mode in a terminal, pass --github-repository owner/name, ' +
      'or pass --create-github-repository <name>.',
    );
  }

  console.log('');
  console.log('GitHub repository setup');
  console.log('  1. Select an existing repository where your account has write access');
  console.log('  2. Create a new private repository under your GitHub account');
  const choice = await ask('Choose 1 or 2: ');

  if (choice === '2') {
    const name = await ask('New private repository name: ');
    return GitHubRepositoryClient.createPrivateRepository(name, token);
  }
  if (choice !== '1') throw new Error('Choose 1 or 2. GitHub setup cancelled.');

  const repositories = (await GitHubRepositoryClient.listAccessibleRepositories(token))
    .filter((repository) => repository.push && !repository.archived)
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

  if (repositories.length === 0) {
    throw new Error('No writable, non-archived repositories were found. Choose private repository creation or grant your account write access.');
  }

  const visible = repositories.slice(0, 100);
  console.log('');
  visible.forEach((repository, index) => {
    console.log(
      String(index + 1) + '. ' + repository.full_name +
      (repository.private ? ' [private]' : ' [public]'),
    );
  });
  const selected = await ask('Repository number: ');
  const index = Number(selected) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= visible.length) {
    throw new Error('The selected repository number is invalid.');
  }
  return visible[index].full_name;
}

async function startWorker(
  cacheRoot: string,
  workerStateRoot: string,
  maxParallelRequests: number,
): Promise<ChildProcess> {
  const workerLocalAppData = path.join(workerStateRoot, 'localappdata');
  const workerXdgStateHome = path.join(workerStateRoot, 'xdg-state');
  const workerStateDir = process.platform === 'win32'
    ? path.join(workerLocalAppData, 'DesktopCommanderBridge')
    : path.join(workerXdgStateHome, 'desktop-commander-bridge');

  await writeJsonAtomic(path.join(workerStateDir, 'settings.json'), {
    directory: cacheRoot,
    pollIntervalMs: 1_000,
    commandDelayMs: 0,
    maxParallelRequests,
    maxStorageBytes: Number.MAX_SAFE_INTEGER,
    consentAccepted: true,
  });

  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const entryPoint = path.resolve(moduleDirectory, '../index.js');
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...(process.platform === 'win32'
      ? { LOCALAPPDATA: workerLocalAppData }
      : { XDG_STATE_HOME: workerXdgStateHome }),
  };
  // The bridge parent needs these credentials for GitHub API calls. Do not
  // pass environment-supplied GitHub tokens into the process that runs tools.
  delete environment.GITHUB_TOKEN;
  delete environment.GH_TOKEN;

  const child = spawn(process.execPath, [entryPoint, 'bridge', '--directory', cacheRoot], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
    windowsHide: false,
  });
  return child;
}

export async function runGitHubBridge(args: string[] = []): Promise<void> {
  const options = parseOptions(args);
  if (options.help) {
    printHelp();
    return;
  }

  const stateDir = stateDirectory();
  await fs.mkdir(stateDir, { recursive: true });
  const releaseLock = await acquireBridgeLock(stateDir);
  let child: ChildProcess | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let responseWatcher: FSWatcher | undefined;
  let webhookServer: GitHubWebhookServer | undefined;
  let quickTunnel: QuickTunnel | undefined;
  let webhookSetupPromise: Promise<void> | undefined;
  let stopping = false;
  let quickTunnelExited = false;
  let webhookActive = false;
  let responseWatcherHealthy = false;
  const tunnelStartupAbort = new AbortController();

  const stopWorker = () => {
    if (stopping) return;
    stopping = true;
    tunnelStartupAbort.abort();
    if (pollTimer) clearInterval(pollTimer);
    responseWatcher?.close();
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
    }
  };

  try {
    const settingsPath = path.join(stateDir, 'settings.json');
    const settings = await readSettings(settingsPath);
    const token = await getGitHubAccessToken();
    const repository = options.repository
      || (options.createRepository
        ? await GitHubRepositoryClient.createPrivateRepository(options.createRepository, token)
        : await chooseRepository(token, settings));
    let client = await GitHubRepositoryClient.connect(repository, token);

    const publicConsentAccepted = settings.githubPublicConsentAccepted === true
      && settings.githubPublicConsentRepository === repository;
    if (!client.isPrivate && !publicConsentAccepted) {
      console.log('');
      console.log('PUBLIC REPOSITORY WARNING');
      console.log('This repository is public. Anyone on GitHub can read its requests, responses, file paths, and exported artifacts.');
      console.log('Use a private repository for sensitive work. The bridge creates private repositories automatically when you choose that option.');
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('This is a public repository. For safety, connect to a private repository or confirm public visibility interactively by typing PUBLIC.');
      }
      const publicAnswer = await ask('Type PUBLIC to allow bridge queue data to be stored in this public repository: ');
      if (publicAnswer !== 'PUBLIC') throw new Error('GitHub bridge startup cancelled; public repository consent was not granted.');
      settings.githubPublicConsentAccepted = true;
      settings.githubPublicConsentRepository = repository;
    }

    const consentAccepted = settings.githubConsentAccepted === true
      && settings.githubConsentRepository === repository;
    if (!consentAccepted) {
      console.log('');
      console.log('SECURITY WARNING');
      console.log('Anyone with write access to ' + repository + ' can submit requests that execute Desktop Commander tools on this computer.');
      console.log('The bridge can read and write local files and run terminal commands. Its restrictions are guardrails, not an operating-system sandbox.');
      console.log('Use a private repository and grant write access only to people you trust. Run one bridge worker per repository.');
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('First GitHub connection requires local interactive consent. Start the executable in a terminal.');
      }
      const answer = await ask('Type YES to let requests in this repository execute locally: ');
      if (answer !== 'YES') throw new Error('GitHub bridge startup cancelled; local consent was not granted.');
      settings.githubConsentAccepted = true;
      settings.githubConsentRepository = repository;
    }

    const slug = repository.replace('/', '--');
    const cacheRoot = path.join(stateDir, 'github-cache', slug);
    const paths = {
      root: cacheRoot,
      requests: path.join(cacheRoot, 'requests'),
      responses: path.join(cacheRoot, 'responses'),
      artifacts: path.join(cacheRoot, 'artifacts'),
    };
    const workerStateRoot = path.join(stateDir, 'github-worker-state', slug);

    // With webhooks enabled, this is only a slow reconciliation safety net.
    // Until the tunnel is live (or when it fails), use the faster fallback.
    const savedReconcileInterval = Number(settings.githubReconcilePollIntervalMs);
    const legacyInterval = Number(settings.githubPollIntervalMs);
    const pollIntervalMs = options.pollIntervalMs
      ?? (Number.isInteger(savedReconcileInterval) && savedReconcileInterval >= 1_000 && savedReconcileInterval <= 60_000
        ? savedReconcileInterval
        : Number.isInteger(legacyInterval) && legacyInterval >= 1_000 && legacyInterval <= 60_000 && legacyInterval !== 5_000
          ? legacyInterval
          : 60_000);
    const fallbackPollIntervalMs = options.pollIntervalMs
      ?? (Number.isInteger(legacyInterval) && legacyInterval >= 1_000 && legacyInterval <= 60_000
        ? legacyInterval
        : 5_000);
    const maxParallelRequests = options.maxParallelRequests
      ?? (Number.isInteger(settings.maxParallelRequests) && Number(settings.maxParallelRequests) >= 0
        ? Number(settings.maxParallelRequests)
        : 0);

    settings.githubRepository = repository;
    settings.provider = 'github';
    settings.githubReconcilePollIntervalMs = pollIntervalMs;
    settings.maxParallelRequests = maxParallelRequests;
    await writeJsonAtomic(settingsPath, settings);

    let lastSyncFailureMessage: string | undefined;
    const reportSyncFailure = (prefix: string, error: unknown): void => {
      const message = errorMessage(error);
      if (lastSyncFailureMessage === message) return;
      lastSyncFailureMessage = message;
      console.error(prefix + message);
    };

    let sync = new GitHubBridgeSync(client, paths);
    let queueInitialized = false;
    let queueInitializationPromise: Promise<void> | undefined;
    const ensureQueueInitialized = async (): Promise<void> => {
      if (queueInitialized) return;
      if (!queueInitializationPromise) {
        queueInitializationPromise = sync.initialize()
          .then(() => { queueInitialized = true; })
          .finally(() => { queueInitializationPromise = undefined; });
      }
      await queueInitializationPromise;
    };

    const syncPoll = async (): Promise<void> => {
      try {
        await ensureQueueInitialized();
        await sync.syncOnce();
        lastSyncFailureMessage = undefined;
      } catch (error) {
        reportSyncFailure('GitHub queue synchronization failed; it will retry: ', error);
      }
    };

    const setPollingInterval = (intervalMs: number): void => {
      if (!pollTimer || stopping) return;
      clearInterval(pollTimer);
      pollTimer = setInterval(() => { void syncPoll(); }, intervalMs);
    };
    const switchToFallbackPolling = (): void => setPollingInterval(fallbackPollIntervalMs);
    const switchToReconciliationPolling = (): void => {
      if (webhookActive && responseWatcherHealthy && !quickTunnelExited) {
        setPollingInterval(pollIntervalMs);
      }
    };

    // Prepare only local folders before starting the worker. GitHub directory
    // creation, guide publication, and historical sync run after startup.
    await Promise.all([
      fs.mkdir(paths.requests, { recursive: true }),
      fs.mkdir(paths.responses, { recursive: true }),
      fs.mkdir(paths.artifacts, { recursive: true }),
    ]);

    try {
      responseWatcher = watch(paths.responses, { persistent: true }, () => { void syncPoll(); });
      responseWatcherHealthy = true;
      responseWatcher.on('error', (error) => {
        responseWatcherHealthy = false;
        console.warn('Local GitHub response-folder watcher failed; switching to polling: ' + error.message);
        switchToFallbackPolling();
      });
    } catch (error) {
      console.warn('Could not watch local GitHub responses; polling will also upload completed responses: ' + errorMessage(error));
    }

    console.log('');
    console.log('Desktop Commander GitHub Repository Bridge is starting.');
    console.log('Repository: ' + repository);
    console.log('Default branch: ' + client.defaultBranch);
    console.log('Local worker starts immediately; queue synchronization and webhook setup run in the background.');
    console.log('Files are committed directly to the existing default branch. No branches or pull requests are created.');
    console.log('Press Ctrl+C to stop.');
    console.log('');

    child = await startWorker(cacheRoot, workerStateRoot, maxParallelRequests);
    process.once('SIGINT', stopWorker);
    process.once('SIGTERM', stopWorker);
    child.once('error', (error) => {
      console.error('Could not start the local Desktop Commander worker: ' + error.message);
    });

    pollTimer = setInterval(() => { void syncPoll(); }, fallbackPollIntervalMs);
    void syncPoll();

    const enableWebhook = async (): Promise<void> => {
      try {
        const sameRepository = settings.githubWebhookRepository === repository;
        const webhookSecret = sameRepository && typeof settings.githubWebhookSecret === 'string'
          && settings.githubWebhookSecret.length >= 32
          ? settings.githubWebhookSecret
          : randomBytes(32).toString('hex');
        settings.githubWebhookRepository = repository;
        settings.githubWebhookSecret = webhookSecret;
        await writeJsonAtomic(settingsPath, settings);

        webhookServer = await startGitHubWebhookServer({
          repository,
          defaultBranch: client.defaultBranch,
          secret: webhookSecret,
          onPush: syncPoll,
          onError: (error) => reportSyncFailure('GitHub webhook synchronization failed: ', error),
        });

        quickTunnel = await startCloudflareQuickTunnel(webhookServer.originUrl, {
          signal: tunnelStartupAbort.signal,
          onExit: (code, signal) => {
            if (!stopping) {
              quickTunnelExited = true;
              switchToFallbackPolling();
              console.warn(
                'Cloudflare Quick Tunnel exited unexpectedly' +
                (signal ? ' (signal ' + signal + ')' : ' (exit code ' + code + ')') +
                '; polling reconciliation remains active.',
              );
            }
          },
        });

        if (stopping) return;

        const savedHookId = sameRepository && Number.isSafeInteger(settings.githubWebhookId)
          ? Number(settings.githubWebhookId)
          : undefined;
        let hookId: number;
        try {
          hookId = await client.upsertPushWebhook(
            savedHookId,
            quickTunnel.url + webhookServer.path,
            webhookSecret,
          );
        } catch (error) {
          if (!(error instanceof GitHubApiError) || error.rateLimit || (error.status !== 403 && error.status !== 404)) {
            throw error;
          }
          console.log('');
          console.log('GitHub needs permission to manage repository webhooks. Requesting the additional GitHub CLI permission now.');
          const refreshedToken = await refreshGitHubAccessTokenForWebhooks();
          client = await GitHubRepositoryClient.connect(repository, refreshedToken);
          await ensureQueueInitialized();
          sync = new GitHubBridgeSync(client, paths);
          hookId = await client.upsertPushWebhook(
            savedHookId,
            quickTunnel.url + webhookServer.path,
            webhookSecret,
          );
        }

        if (stopping) return;
        settings.githubWebhookId = hookId;
        await writeJsonAtomic(settingsPath, settings);
        webhookActive = true;
        console.log('GitHub push notifications: enabled through Cloudflare Quick Tunnel.');
        console.log('Webhook endpoint: ' + quickTunnel.url + webhookServer.path);
        switchToReconciliationPolling();
      } catch (error) {
        if (!stopping) {
          console.warn(
            'GitHub push notifications could not be enabled; the bridge will continue with polling. ' +
            errorMessage(error),
          );
        }
        await quickTunnel?.close().catch(() => undefined);
        quickTunnel = undefined;
        await webhookServer?.close().catch(() => undefined);
        webhookServer = undefined;
        webhookActive = false;
        switchToFallbackPolling();
      }
    };

    if (options.disableWebhook) {
      console.log('GitHub push notifications are disabled by --no-github-webhook; polling is active.');
    } else {
      console.log('GitHub push notifications: establishing Cloudflare Quick Tunnel in the background.');
      webhookSetupPromise = enableWebhook();
    }

    const childExitCode = await new Promise<number>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('exit', (code) => resolve(code === null ? 1 : code));
    });
    if (!stopping && childExitCode !== 0) {
      throw new Error('The local Desktop Commander worker exited with code ' + childExitCode + '.');
    }
  } finally {
    stopWorker();
    await webhookSetupPromise?.catch(() => undefined);
    if (child && child.exitCode === null && child.pid !== undefined) {
      await new Promise<void>((resolve) => {
        child!.once('exit', () => resolve());
        child!.kill('SIGTERM');
      }).catch(() => undefined);
    }
    process.removeListener('SIGINT', stopWorker);
    process.removeListener('SIGTERM', stopWorker);
    await quickTunnel?.close().catch((error: unknown) => {
      console.warn('Could not stop Cloudflare Quick Tunnel cleanly: ' + errorMessage(error));
    });
    await webhookServer?.close().catch((error: unknown) => {
      console.warn('Could not stop GitHub webhook listener cleanly: ' + errorMessage(error));
    });
    await releaseLock();
  }
}
