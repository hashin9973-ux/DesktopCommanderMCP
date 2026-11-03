import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from '../utils/atomic-write.js';
import {
  GitHubRepositoryClient,
  MAX_GITHUB_BRIDGE_FILE_BYTES,
} from './github.js';

export interface GitHubBridgeCachePaths {
  root: string;
  requests: string;
  responses: string;
  artifacts: string;
}

const REQUEST_PATTERN = /^request-([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.(json|md)$/i;
const RESPONSE_PATTERN = /^response-([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.json$/i;

interface BridgeArtifactReference {
  path: string;
  bytes: number;
  sha256: string;
}

interface BridgeResponseReference {
  id: string;
  request_hash: string;
  artifacts?: BridgeArtifactReference[];
}

const GITHUB_BRIDGE_GUIDE = [
  '# Desktop Commander GitHub Repository Bridge',
  '',
  'This repository is the shared request/response mailbox for a Desktop Commander Bridge running on a trusted computer.',
  '',
  '## Queue folders',
  '',
  '- requests/ — submit request-<id>.json or request-<id>.md files.',
  '- responses/ — read response-<id>.json results.',
  '- artifacts/ — binary outputs referenced by responses.',
  '- DESKTOP_COMMANDER_BRIDGE.md — this guide.',
  '',
  '## How it works',
  '',
  '1. Put a version 1 request file in requests/. Its filename must be request-<id>.json or request-<id>.md, and the request id must match the filename.',
  '2. The Desktop Commander process connected to this repository polls the existing default branch and downloads new requests.',
  '3. Commands execute on that local computer using Desktop Commander permissions and restrictions.',
  '4. The bridge commits output files into artifacts/ first, then commits responses/response-<id>.json. The response file is the completion signal.',
  '5. Read the response and retrieve any referenced artifacts from this repository.',
  '',
  'The bridge writes only to the repository existing default branch. It does not create branches, pull requests, or change source files outside the queue paths. The repository default branch must allow direct writes.',
  '',
  '## Security',
  '',
  'Anyone with write access to this repository can submit a request for the running computer to execute local Desktop Commander tools, including file operations and terminal commands. Use a private repository and grant write access only to people you trust. Desktop Commander restrictions are guardrails, not an operating-system sandbox. Run only one bridge worker for a shared repository.',
  '',
  'GitHub repository contents are persistent. The bridge does not automatically delete remote requests, responses, or artifacts. Each individual uploaded file is limited to 50 MiB by this transport.',
  '',
  '## Request format',
  '',
  'A JSON request uses protocol_version 1, a unique id, and a non-empty commands array. Each command has a tool name and arguments object. The bridge validates the tool and arguments before execution.',
  '',
  'Example request:',
  '',
  '~~~json',
  JSON.stringify({
    protocol_version: 1,
    id: 'inspect-001',
    commands: [{ tool: 'list_directory', arguments: { path: 'C:/Projects', depth: 2 } }],
  }, null, 2),
  '~~~',
  '',
  'Do not reuse request IDs. A request ID whose response already exists cannot be used for different content.',
  '',
].join('\n');

async function readOptional(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isSafeArtifactPath(value: string, requestId: string): boolean {
  const prefix = 'artifacts/' + requestId + '/';
  if (!value.startsWith(prefix) || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.length === 3
    && segments[0] === 'artifacts'
    && segments[1] === requestId
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segments[2])
    && segments[2] !== '.'
    && segments[2] !== '..';
}

export class GitHubBridgeSync {
  private syncPromise?: Promise<void>;

  constructor(
    private readonly client: GitHubRepositoryClient,
    private readonly paths: GitHubBridgeCachePaths,
  ) {}

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.paths.requests, { recursive: true }),
      fs.mkdir(this.paths.responses, { recursive: true }),
      fs.mkdir(this.paths.artifacts, { recursive: true }),
    ]);

    for (const directory of ['requests', 'responses', 'artifacts']) {
      await this.client.createFileIfAbsent(
        directory + '/.gitkeep',
        Buffer.from('Desktop Commander bridge queue directory.\n', 'utf8'),
        'Initialize Desktop Commander bridge queue',
      );
    }

    await this.client.createFileIfAbsent(
      'DESKTOP_COMMANDER_BRIDGE.md',
      Buffer.from(GITHUB_BRIDGE_GUIDE + '\n', 'utf8'),
      'Document Desktop Commander GitHub bridge queue',
    );
  }

  async syncOnce(): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.syncInternal().finally(() => {
      this.syncPromise = undefined;
    });
    return this.syncPromise;
  }

  private async syncInternal(): Promise<void> {
    const [remoteRequests, remoteResponses] = await Promise.all([
      this.client.listDirectory('requests'),
      this.client.listDirectory('responses'),
    ]);
    const remoteResponseNames = new Set(
      remoteResponses.filter((entry) => entry.type === 'file').map((entry) => entry.name),
    );

    for (const entry of remoteRequests) {
      if (entry.type !== 'file' || !REQUEST_PATTERN.test(entry.name)) continue;
      if (entry.size > MAX_GITHUB_BRIDGE_FILE_BYTES) {
        throw new Error('Remote request ' + entry.path + ' exceeds the 50 MiB GitHub bridge file limit.');
      }

      const match = REQUEST_PATTERN.exec(entry.name);
      if (!match) continue;
      const responseName = 'response-' + match[1] + '.json';
      const remoteResponse = remoteResponses.find((candidate) =>
        candidate.type === 'file' && candidate.name === responseName);

      const remoteBytes = await this.client.readFile(entry.path);
      if (remoteResponse) {
        const responseBytes = await this.client.readFile(remoteResponse.path);
        let response: BridgeResponseReference;
        try {
          response = JSON.parse(responseBytes.toString('utf8')) as BridgeResponseReference;
        } catch {
          throw new Error('Existing GitHub response ' + remoteResponse.path + ' is not valid JSON.');
        }
        const requestHash = createHash('sha256').update(remoteBytes).digest('hex');
        if (response.id !== match[1] || response.request_hash !== requestHash) {
          throw new Error('GitHub request ID ' + match[1] + ' was reused with content that conflicts with its existing response.');
        }
        continue;
      }

      const localPath = path.join(this.paths.requests, entry.name);
      const existing = await readOptional(localPath);
      if (existing && !existing.equals(remoteBytes)) {
        throw new Error('Local GitHub queue cache conflicts with remote request ' + entry.name + '; the local file was not overwritten.');
      }
      if (!existing) {
        await writeFileAtomic(localPath, remoteBytes);
      }
    }

    // Artifacts must reach GitHub before the response file signals completion.
    const localResponses = (await fs.readdir(this.paths.responses, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && RESPONSE_PATTERN.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of localResponses) {
      const match = RESPONSE_PATTERN.exec(entry.name);
      if (!match) continue;
      const requestId = match[1];
      const responsePath = path.join(this.paths.responses, entry.name);
      const responseBytes = await fs.readFile(responsePath);
      if (responseBytes.length > MAX_GITHUB_BRIDGE_FILE_BYTES) {
        throw new Error('Response ' + entry.name + ' exceeds the 50 MiB GitHub bridge file limit.');
      }

      let response: BridgeResponseReference;
      try {
        response = JSON.parse(responseBytes.toString('utf8')) as BridgeResponseReference;
      } catch {
        throw new Error('Local bridge response ' + entry.name + ' is not valid JSON.');
      }
      if (response.id !== requestId || typeof response.request_hash !== 'string') {
        throw new Error('Local bridge response ' + entry.name + ' has an invalid id or request hash.');
      }

      for (const artifact of response.artifacts || []) {
        if (!artifact || typeof artifact.path !== 'string' || !isSafeArtifactPath(artifact.path, requestId)) {
          throw new Error('Response ' + entry.name + ' contains an unsafe artifact path.');
        }
        const localArtifactPath = path.resolve(this.paths.root, ...artifact.path.split('/'));
        const relativeArtifactPath = path.relative(this.paths.root, localArtifactPath);
        if (!relativeArtifactPath || relativeArtifactPath.startsWith('..' + path.sep) || path.isAbsolute(relativeArtifactPath)) {
          throw new Error('Response ' + entry.name + ' references an artifact outside the local GitHub cache.');
        }
        const stat = await fs.lstat(localArtifactPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error('Response artifact is not a regular local file: ' + artifact.path);
        }
        if (stat.size !== artifact.bytes || stat.size > MAX_GITHUB_BRIDGE_FILE_BYTES) {
          throw new Error('Response artifact ' + artifact.path + ' does not match the GitHub 50 MiB upload limit or recorded byte count.');
        }
        const bytes = await fs.readFile(localArtifactPath);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== artifact.sha256) {
          throw new Error('Response artifact ' + artifact.path + ' does not match its recorded SHA-256 hash.');
        }
        await this.client.createFileIfAbsent(
          artifact.path,
          bytes,
          'Store Desktop Commander bridge artifact ' + requestId,
        );
      }

      await this.client.createFileIfAbsent(
        'responses/' + entry.name,
        responseBytes,
        'Publish Desktop Commander bridge response ' + requestId,
      );

      // The remote response is durable now. Remove local staging copies so the
      // cache does not grow forever; remote queue history remains untouched.
      await fs.rm(responsePath, { force: true });
      await fs.rm(path.join(this.paths.requests, 'request-' + requestId + '.json'), { force: true });
      await fs.rm(path.join(this.paths.requests, 'request-' + requestId + '.md'), { force: true });
      await fs.rm(path.join(this.paths.artifacts, requestId), { recursive: true, force: true });
    }

    // A response may already have been published by a previous run. Do not
    // stage its request again or re-execute it after a restart.
    for (const entry of remoteRequests) {
      const match = entry.type === 'file' ? REQUEST_PATTERN.exec(entry.name) : null;
      if (!match || !remoteResponseNames.has('response-' + match[1] + '.json')) continue;
      await fs.rm(path.join(this.paths.requests, entry.name), { force: true });
    }
  }
}
