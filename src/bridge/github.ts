import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GITHUB_API_ROOT = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_API_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_GITHUB_BRIDGE_FILE_BYTES = 50 * 1024 * 1024;

export interface GitHubRepositorySummary {
  full_name: string;
  default_branch: string;
  private?: boolean;
  archived?: boolean;
  permissions?: { push?: boolean };
}

export interface GitHubContentEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: 'file' | 'dir' | string;
}

export interface GitHubAccountRepository {
  full_name: string;
  private: boolean;
  archived: boolean;
  push: boolean;
}

export interface GitHubAuthenticationDependencies {
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  cliPath?: string;
  readToken?: (cliPath: string) => Promise<string>;
  runLogin?: (cliPath: string) => Promise<void>;
}

function resolveGitHubCliPath(): string {
  // The Windows portable build includes the official GitHub CLI distribution.
  // Resolve it relative to app/dist/bridge/github.js in that layout.
  const bundledCli = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../tools/gh.exe',
  );
  if (process.platform === 'win32' && existsSync(bundledCli)) return bundledCli;
  return process.platform === 'win32' ? 'gh.exe' : 'gh';
}

async function readGitHubCliToken(cliPath: string): Promise<string> {
  const result = await execFileAsync(cliPath, ['auth', 'token', '--hostname', 'github.com'], {
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const token = result.stdout.trim();
  if (!token) throw new Error('GitHub CLI returned an empty authentication token.');
  return token;
}

async function runGitHubCliLogin(cliPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      cliPath,
      ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https', '--scopes', 'admin:repo_hook'],
      { stdio: 'inherit', windowsHide: false },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) {
        resolve();
      } else {
        reject(new Error(
          'GitHub CLI browser sign-in did not complete successfully' +
          (signal ? ' (signal ' + signal + ').' : ' (exit code ' + code + ').'),
        ));
      }
    });
  });
}

export async function getGitHubAccessToken(
  dependencies: GitHubAuthenticationDependencies = {},
): Promise<string> {
  const environment = dependencies.env || process.env;
  const environmentToken = environment.GITHUB_TOKEN?.trim() || environment.GH_TOKEN?.trim();
  if (environmentToken) return environmentToken;

  const cliPath = dependencies.cliPath || resolveGitHubCliPath();
  const readToken = dependencies.readToken || readGitHubCliToken;
  const runLogin = dependencies.runLogin || runGitHubCliLogin;

  try {
    const token = await readToken(cliPath);
    if (token.trim()) return token.trim();
  } catch {
    // A missing token is the first-run path. Do not print CLI output because it
    // may contain account or credential details.
  }

  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new Error(
      'No GitHub session is configured. Start the GitHub bridge in an interactive terminal to sign in through the browser, ' +
      'or set GITHUB_TOKEN/GH_TOKEN for a headless session. For manual setup, run "gh auth login --web --hostname github.com --scopes admin:repo_hook".',
    );
  }

  console.log('');
  console.log('No GitHub account is connected yet. Starting GitHub browser sign-in now.');
  console.log('Complete the one-time sign-in prompts in this window and approve the request in your browser.');

  try {
    await runLogin(cliPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'The GitHub CLI authentication helper could not be started. Re-extract the complete Windows portable ZIP, ' +
        'or install GitHub CLI from https://cli.github.com/ and run "gh auth login --web".',
      );
    }
    throw new Error(
      'GitHub browser sign-in failed: ' +
      (error instanceof Error ? error.message : String(error)),
    );
  }

  try {
    const token = await readToken(cliPath);
    if (token.trim()) return token.trim();
  } catch {
    // Keep the failure message free of CLI output and possible credential data.
  }
  throw new Error(
    'GitHub browser sign-in finished, but no usable token was found. Confirm the browser authorization and try again.',
  );
}

function parseErrorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; errors?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Fall through to a safe status-only error.
  }
  return 'GitHub API request failed with HTTP ' + status + '.';
}


export interface GitHubWebhookScopeDependencies {
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  cliPath?: string;
  refresh?: (cliPath: string) => Promise<void>;
  readToken?: (cliPath: string) => Promise<string>;
}

async function runGitHubCliWebhookScopeRefresh(cliPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      cliPath,
      ['auth', 'refresh', '--hostname', 'github.com', '--scopes', 'admin:repo_hook'],
      { stdio: 'inherit', windowsHide: false },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(
        'GitHub CLI could not add the admin:repo_hook permission' +
        (signal ? ' (signal ' + signal + ').' : ' (exit code ' + code + ').'),
      ));
    });
  });
}

export async function refreshGitHubAccessTokenForWebhooks(
  dependencies: GitHubWebhookScopeDependencies = {},
): Promise<string> {
  const environment = dependencies.env || process.env;
  if (environment.GITHUB_TOKEN?.trim() || environment.GH_TOKEN?.trim()) {
    throw new Error(
      'The configured GITHUB_TOKEN/GH_TOKEN needs repository Webhooks: write permission for a fine-grained personal access token, or the admin:repo_hook scope for a classic token. ' +
      'Update the token permissions and restart the bridge.',
    );
  }

  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new Error(
      'GitHub webhook registration needs repository Webhooks: write permission. ' +
      'Run the bridge interactively to authorize admin:repo_hook, or configure a fine-grained token with Webhooks: write.',
    );
  }

  const cliPath = dependencies.cliPath || resolveGitHubCliPath();
  const refresh = dependencies.refresh || runGitHubCliWebhookScopeRefresh;
  const readToken = dependencies.readToken || readGitHubCliToken;
  try {
    await refresh(cliPath);
    const token = await readToken(cliPath);
    if (!token.trim()) throw new Error('GitHub CLI returned an empty token after permission refresh.');
    return token.trim();
  } catch (error) {
    throw new Error(
      'Could not authorize GitHub webhook management. Approve the GitHub CLI request for admin:repo_hook, ' +
      'or use a fine-grained personal access token with Webhooks: write. ' +
      (error instanceof Error ? error.message : String(error)),
    );
  }
}

export class GitHubRepositoryClient {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  private constructor(
    repository: string,
    defaultBranch: string,
    token: string,
    fetcher: typeof fetch,
    isPrivate = false,
  ) {
    this.repository = repository;
    this.defaultBranch = defaultBranch;
    this.isPrivate = isPrivate;
    this.token = token;
    this.fetcher = fetcher;
  }

  static async connect(
    repository: string,
    token: string,
    fetcher: typeof fetch = fetch,
  ): Promise<GitHubRepositoryClient> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error('Repository must use owner/name format, for example octocat/Hello-World.');
    }
    if (!token.trim()) throw new Error('A GitHub access token is required.');

    const client = new GitHubRepositoryClient(repository, '', token, fetcher);
    const metadata = await client.requestJson('/repos/' + repository) as {
      default_branch?: unknown;
      archived?: unknown;
      private?: unknown;
      permissions?: { push?: unknown };
    };
    if (typeof metadata.default_branch !== 'string' || !metadata.default_branch) {
      throw new Error('GitHub did not return a default branch for ' + repository + '.');
    }
    if (metadata.archived === true) {
      throw new Error('Repository ' + repository + ' is archived and cannot accept bridge queue writes.');
    }
    if (metadata.permissions && metadata.permissions.push === false) {
      throw new Error('Your authenticated GitHub account does not have write access to ' + repository + '. Choose a repository where you have write permission.');
    }
    return new GitHubRepositoryClient(repository, metadata.default_branch, token, fetcher, metadata.private === true);
  }

  static async getAccount(
    token: string,
    fetcher: typeof fetch = fetch,
  ): Promise<{ login: string }> {
    const client = new GitHubRepositoryClient('', '', token, fetcher);
    const value = await client.requestJson('/user') as { login?: unknown };
    if (typeof value.login !== 'string' || !value.login) {
      throw new Error('GitHub did not return the authenticated account name.');
    }
    return { login: value.login };
  }

  static async listAccessibleRepositories(
    token: string,
    fetcher: typeof fetch = fetch,
  ): Promise<GitHubAccountRepository[]> {
    const client = new GitHubRepositoryClient('', '', token, fetcher);
    const repositories: GitHubAccountRepository[] = [];
    for (let page = 1; page <= 10; page++) {
      const value = await client.requestJson(
        '/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page=' + page,
      );
      if (!Array.isArray(value)) throw new Error('GitHub repository listing returned an unexpected response.');
      const current = value.filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null
        && typeof item.full_name === 'string')
        .map((item) => ({
          full_name: String(item.full_name),
          private: item.private === true,
          archived: item.archived === true,
          push: typeof item.permissions === 'object' && item.permissions !== null
            && (item.permissions as Record<string, unknown>).push === true,
        }));
      repositories.push(...current);
      if (value.length < 100) break;
    }
    return repositories;
  }

  static async createPrivateRepository(
    name: string,
    token: string,
    fetcher: typeof fetch = fetch,
  ): Promise<string> {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) {
      throw new Error('Repository name must contain 1-100 letters, numbers, dots, underscores, or hyphens.');
    }
    if (!token.trim()) throw new Error('A GitHub access token is required.');

    const client = new GitHubRepositoryClient('', '', token, fetcher);
    let created: { full_name?: unknown; private?: unknown; default_branch?: unknown };
    try {
      created = await client.requestJson('/user/repos', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: 'Private Desktop Commander Bridge request and response mailbox',
          private: true,
          auto_init: true,
          has_issues: false,
          has_projects: false,
          has_wiki: false,
        }),
      }) as { full_name?: unknown; private?: unknown; default_branch?: unknown };
    } catch (error) {
      if (error instanceof GitHubApiError && (error.status === 403 || error.status === 404)) {
        throw new Error(
          'GitHub did not allow automatic repository creation. The authenticated credential needs permission to create ' +
          'repositories (fine-grained personal access tokens need Administration: write or Repository creation: write; classic tokens need the repo scope). ' +
          'You can instead choose an existing repository where your account has write access. GitHub said: ' + error.message,
        );
      }
      throw error;
    }

    if (created.private !== true || typeof created.full_name !== 'string' || !created.full_name) {
      throw new Error('GitHub did not confirm creation of a private repository.');
    }
    if (typeof created.default_branch !== 'string' || !created.default_branch) {
      throw new Error('GitHub created the repository without returning its default branch.');
    }
    return created.full_name;
  }

  async getAuthenticatedUser(): Promise<{ login: string }> {
    return GitHubRepositoryClient.getAccount(this.token, this.fetcher);
  }

  async listRepositories(): Promise<GitHubAccountRepository[]> {
    return GitHubRepositoryClient.listAccessibleRepositories(this.token, this.fetcher);
  }

  async upsertPushWebhook(
    existingHookId: number | undefined,
    targetUrl: string,
    secret: string,
  ): Promise<number> {
    const parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== 'https:' || !parsedUrl.hostname.endsWith('.trycloudflare.com')) {
      throw new Error('GitHub push webhook URL must be an HTTPS Cloudflare Quick Tunnel URL.');
    }
    if (!secret || secret.length < 32) {
      throw new Error('GitHub webhook secret must contain at least 32 characters.');
    }

    const payload = {
      name: 'web',
      active: true,
      events: ['push'],
      config: {
        url: parsedUrl.origin + parsedUrl.pathname,
        content_type: 'json',
        secret,
        insecure_ssl: '0',
      },
    };

    const create = async (): Promise<number> => {
      try {
        const created = await this.requestJson('/repos/' + this.repository + '/hooks', {
          method: 'POST',
          body: JSON.stringify(payload),
        }) as { id?: unknown };
        if (!Number.isSafeInteger(created.id) || Number(created.id) <= 0) {
          throw new Error('GitHub created a webhook without returning a valid hook ID.');
        }
        return Number(created.id);
      } catch (error) {
        if (error instanceof GitHubApiError && (error.status === 403 || error.status === 404)) {
          throw new GitHubApiError(
            error.status,
            'GitHub denied repository webhook creation. Your account must own or have admin access to this repository. ' +
            'The credential needs Webhooks: write (fine-grained token) or admin:repo_hook (GitHub CLI OAuth). ' +
            'GitHub said: ' + error.message,
          );
        }
        throw error;
      }
    };

    if (!Number.isSafeInteger(existingHookId) || Number(existingHookId) <= 0) {
      return create();
    }

    try {
      const updated = await this.requestJson(
        '/repos/' + this.repository + '/hooks/' + existingHookId,
        { method: 'PATCH', body: JSON.stringify(payload) },
      ) as { id?: unknown };
      if (!Number.isSafeInteger(updated.id) || Number(updated.id) <= 0) {
        throw new Error('GitHub updated a webhook without returning a valid hook ID.');
      }
      return Number(updated.id);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return create();
      if (error instanceof GitHubApiError && error.status === 403) {
        throw new GitHubApiError(
          error.status,
          'GitHub denied repository webhook updates. Your account must own or have admin access to this repository. ' +
          'The credential needs Webhooks: write (fine-grained token) or admin:repo_hook (GitHub CLI OAuth). ' +
          'GitHub said: ' + error.message,
        );
      }
      throw error;
    }
  }

  async listDirectory(directory: string): Promise<GitHubContentEntry[]> {
    const suffix = directory ? '/' + directory.split('/').map(encodeURIComponent).join('/') : '';
    try {
      const value = await this.requestJson(
        '/repos/' + this.repository + '/contents' + suffix + '?ref=' + encodeURIComponent(this.defaultBranch),
      );
      if (!Array.isArray(value)) {
        throw new Error('Expected a directory listing for ' + (directory || 'repository root') + '.');
      }
      return value.filter((entry): entry is GitHubContentEntry =>
        typeof entry === 'object' && entry !== null
        && typeof entry.name === 'string'
        && typeof entry.path === 'string'
        && typeof entry.sha === 'string'
        && (entry.type === 'file' || entry.type === 'dir'))
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          sha: entry.sha,
          size: typeof entry.size === 'number' ? entry.size : 0,
          type: entry.type,
        }));
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return [];
      throw error;
    }
  }

  async readFile(filePath: string): Promise<Buffer> {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const response = await this.request(
      '/repos/' + this.repository + '/contents/' + encodedPath +
      '?ref=' + encodeURIComponent(this.defaultBranch),
      { accept: 'application/vnd.github.raw+json' },
    );
    return Buffer.from(await response.arrayBuffer());
  }

  async createFileIfAbsent(filePath: string, bytes: Buffer, message: string): Promise<boolean> {
    if (bytes.length > MAX_GITHUB_BRIDGE_FILE_BYTES) {
      throw new Error(
        'GitHub bridge files are limited to ' + MAX_GITHUB_BRIDGE_FILE_BYTES +
        ' bytes (50 MiB); ' + filePath + ' is ' + bytes.length + ' bytes.',
      );
    }
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const url = '/repos/' + this.repository + '/contents/' + encodedPath;
    const responseBody = {
      message,
      content: bytes.toString('base64'),
      branch: this.defaultBranch,
    };

    // Contents API writes are individual commits to one branch. A concurrent
    // write to a different file can advance the branch between requests, so
    // retry a bounded number of stale-head conflicts when the target is absent.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.requestJson(url, { method: 'PUT', body: JSON.stringify(responseBody) });
        return true;
      } catch (error) {
        if (!(error instanceof GitHubApiError) || (error.status !== 409 && error.status !== 422)) {
          throw error;
        }

        let existing: Buffer;
        try {
          existing = await this.readFile(filePath);
        } catch (readError) {
          if (error.status === 409
            && readError instanceof GitHubApiError
            && readError.status === 404
            && attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
            continue;
          }
          throw new Error('GitHub could not verify an existing ' + filePath + ': ' + errorMessage(readError));
        }

        if (existing.equals(bytes)) return false;
        throw new Error(
          'GitHub repository already contains a different file at ' + filePath +
          '. Request IDs and artifact paths must be unique; the existing file was not overwritten.',
        );
      }
    }
    throw new Error('GitHub could not commit ' + filePath + ' after repeated default-branch conflicts. Retry the synchronization.');
  }

  async writeFile(filePath: string, bytes: Buffer, message: string): Promise<boolean> {
    if (bytes.length > MAX_GITHUB_BRIDGE_FILE_BYTES) {
      throw new Error(
        'GitHub bridge files are limited to ' + MAX_GITHUB_BRIDGE_FILE_BYTES +
        ' bytes (50 MiB); ' + filePath + ' is ' + bytes.length + ' bytes.',
      );
    }

    const directory = path.posix.dirname(filePath);
    const name = path.posix.basename(filePath);
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const url = '/repos/' + this.repository + '/contents/' + encodedPath;

    // README.md is bridge-owned metadata, not an idempotency-keyed queue file:
    // update GitHub's auto-created README and refresh it when the guide changes.
    for (let attempt = 0; attempt < 3; attempt++) {
      const entries = await this.listDirectory(directory === '.' ? '' : directory);
      const existingEntry = entries.find((entry) => entry.type === 'file' && entry.name === name);
      if (!existingEntry) {
        try {
          return await this.createFileIfAbsent(filePath, bytes, message);
        } catch (error) {
          if (error instanceof GitHubApiError
            && (error.status === 409 || error.status === 422)
            && attempt < 2) {
            continue;
          }
          throw error;
        }
      }

      const existingBytes = await this.readFile(filePath);
      if (existingBytes.equals(bytes)) return false;

      try {
        await this.requestJson(url, {
          method: 'PUT',
          body: JSON.stringify({
            message,
            content: bytes.toString('base64'),
            branch: this.defaultBranch,
            sha: existingEntry.sha,
          }),
        });
        return true;
      } catch (error) {
        if (error instanceof GitHubApiError
          && (error.status === 409 || error.status === 422)
          && attempt < 2) {
          continue;
        }
        throw error;
      }
    }
    throw new Error('GitHub could not update ' + filePath + ' after repeated default-branch conflicts. Retry the synchronization.');
  }

  async deleteFileIfPresent(filePath: string, message: string): Promise<boolean> {
    const directory = path.posix.dirname(filePath);
    const name = path.posix.basename(filePath);
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const url = '/repos/' + this.repository + '/contents/' + encodedPath;

    for (let attempt = 0; attempt < 3; attempt++) {
      const entries = await this.listDirectory(directory === '.' ? '' : directory);
      const existingEntry = entries.find((entry) => entry.type === 'file' && entry.name === name);
      if (!existingEntry) return false;

      try {
        await this.requestJson(url, {
          method: 'DELETE',
          body: JSON.stringify({
            message,
            sha: existingEntry.sha,
            branch: this.defaultBranch,
          }),
        });
        return true;
      } catch (error) {
        if (error instanceof GitHubApiError
          && (error.status === 404 || error.status === 409 || error.status === 422)
          && attempt < 2) {
          continue;
        }
        throw error;
      }
    }
    throw new Error('GitHub could not remove obsolete ' + filePath + ' after repeated default-branch conflicts. Retry the synchronization.');
  }

  private async requestJson(
    route: string,
    options: { method?: string; body?: string; accept?: string } = {},
  ): Promise<unknown> {
    const response = await this.request(route, options);
    if (response.status === 204) return null;
    const body = await response.text();
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error('GitHub returned a non-JSON response for ' + route + '.');
    }
  }

  private async request(
    route: string,
    options: { method?: string; body?: string; accept?: string } = {},
  ): Promise<Response> {
    const response = await this.fetcher(GITHUB_API_ROOT + route, {
      method: options.method || 'GET',
      headers: {
        Accept: options.accept || 'application/vnd.github+json',
        Authorization: 'Bearer ' + this.token,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'DesktopCommanderBridge',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: options.body } : {}),
      signal: AbortSignal.timeout(GITHUB_API_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text();
      const message = parseErrorMessage(body, response.status);
      if (/protected branch|protected branch update failed/i.test(message)) {
        throw new GitHubApiError(
          response.status,
          'GitHub rejected the write because the repository default branch is protected. ' +
          'This bridge writes directly to the existing default branch and does not create branches or pull requests. ' +
          'Allow direct writes to the bridge queue paths or choose a repository that permits direct commits.',
        );
      }
      throw new GitHubApiError(response.status, message);
    }
    return response;
  }
}

export class GitHubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
