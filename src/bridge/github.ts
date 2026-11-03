import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GITHUB_API_ROOT = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
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

export async function getGitHubAccessToken(): Promise<string> {
  const environmentToken = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (environmentToken) return environmentToken;

  try {
    const result = await execFileAsync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const token = result.stdout.trim();
    if (token) return token;
  } catch {
    // Do not include child-process output: it may contain credential details.
  }

  throw new Error(
    'GitHub mode needs an authenticated GitHub CLI session or GITHUB_TOKEN. ' +
    'Install GitHub CLI from https://cli.github.com/, run "gh auth login", then restart Desktop Commander.',
  );
}

function encodeRepositoryPath(value: string): string {
  return value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
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

export class GitHubRepositoryClient {
  readonly repository: string;
  readonly defaultBranch: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  private constructor(
    repository: string,
    defaultBranch: string,
    token: string,
    fetcher: typeof fetch,
  ) {
    this.repository = repository;
    this.defaultBranch = defaultBranch;
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
    return new GitHubRepositoryClient(repository, metadata.default_branch, token, fetcher);
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
    const created = await client.requestJson('/user/repos', {
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

    if (created.private !== true || typeof created.full_name !== 'string' || !created.full_name) {
      throw new Error('GitHub did not confirm creation of a private repository.');
    }
    if (typeof created.default_branch !== 'string' || !created.default_branch) {
      throw new Error('GitHub created the repository without returning its default branch.');
    }
    return created.full_name;
  }

  async getAuthenticatedUser(): Promise<{ login: string }> {
    const value = await this.requestJson('/user') as { login?: unknown };
    if (typeof value.login !== 'string' || !value.login) {
      throw new Error('GitHub did not return the authenticated account name.');
    }
    return { login: value.login };
  }

  async listRepositories(): Promise<Array<{ full_name: string; private: boolean; archived: boolean; push: boolean }>> {
    const repositories: Array<{ full_name: string; private: boolean; archived: boolean; push: boolean }> = [];
    for (let page = 1; page <= 10; page++) {
      const value = await this.requestJson(
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

  async listDirectory(directory: string): Promise<GitHubContentEntry[]> {
    const suffix = directory ? '/' + encodeRepositoryPath(directory) : '';
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
    const response = await this.request(
      '/repos/' + this.repository + '/contents/' + encodeRepositoryPath(filePath) +
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
    const url = '/repos/' + this.repository + '/contents/' + encodeRepositoryPath(filePath);
    const responseBody = {
      message,
      content: bytes.toString('base64'),
      branch: this.defaultBranch,
    };

    try {
      await this.requestJson(url, { method: 'PUT', body: JSON.stringify(responseBody) });
      return true;
    } catch (error) {
      if (!(error instanceof GitHubApiError) || (error.status !== 409 && error.status !== 422)) throw error;

      const existing = await this.readFile(filePath).catch((readError) => {
        throw new Error('GitHub could not verify an existing ' + filePath + ': ' + errorMessage(readError));
      });
      if (existing.equals(bytes)) return false;
      throw new Error(
        'GitHub repository already contains a different file at ' + filePath +
        '. Request IDs and artifact paths must be unique; the existing file was not overwritten.',
      );
    }
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
