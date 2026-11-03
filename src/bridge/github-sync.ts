import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { createGuideIfMissing } from './runtime.js';
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

async function readOptional(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1')
    .update('blob ' + bytes.length + '\0')
    .update(bytes)
    .digest('hex');
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
  private readonly completedRequests = new Map<string, {
    requestBlobSha: string;
    responseBlobSha: string;
  }>();

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

    // Keep Contents API writes sequential: each file creation advances the
    // same default-branch ref and concurrent commits can conflict.
    for (const directory of ['requests', 'responses', 'artifacts']) {
      await this.client.createFileIfAbsent(
        directory + '/.gitkeep',
        Buffer.from('Desktop Commander bridge queue directory.\n', 'utf8'),
        'Initialize Desktop Commander bridge queue',
      );
    }

    // Regenerate the same AI-facing README that cloud-folder mode creates.
    // The cache is private to this repository, so replace any stale local copy.
    const readmePath = path.join(this.paths.root, 'README.md');
    await fs.rm(readmePath, { force: true });
    await createGuideIfMissing(this.paths.root);
    const readme = await fs.readFile(readmePath);

    // Migrate repositories initialized by older bridge versions: README.md is
    // now the only guide, and contains the shared AI instructions and schemas.
    await this.client.deleteFileIfPresent(
      'DESKTOP_COMMANDER_BRIDGE.md',
      'Remove obsolete separate Desktop Commander bridge guide',
    );
    await this.client.writeFile(
      'README.md',
      readme,
      'Publish shared Desktop Commander AI README',
    );
  }

  async syncOnce(): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    const running = this.syncInternal().finally(() => {
      this.syncPromise = undefined;
    });
    this.syncPromise = running;
    return running;
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
      const requestId = match[1];
      const responseName = 'response-' + requestId + '.json';
      const remoteResponse = remoteResponses.find((candidate) =>
        candidate.type === 'file' && candidate.name === responseName);
      if (remoteResponse) {
        const completed = this.completedRequests.get(requestId);
        if (completed
          && completed.requestBlobSha === entry.sha
          && completed.responseBlobSha === remoteResponse.sha) {
          continue;
        }
      }

      const localPath = path.join(this.paths.requests, entry.name);
      const cached = await readOptional(localPath);

      let requestBytes: Buffer;
      if (cached) {
        if (gitBlobSha(cached) !== entry.sha) {
          throw new Error('Local GitHub queue cache conflicts with remote request ' + entry.name + '; the local file was not overwritten.');
        }
        requestBytes = cached;
      } else {
        requestBytes = await this.client.readFile(entry.path);
        if (gitBlobSha(requestBytes) !== entry.sha) {
          throw new Error('GitHub request ' + entry.path + ' changed while it was being downloaded. The next poll will retry.');
        }
      }

      if (remoteResponse) {
        const responseBytes = await this.client.readFile(remoteResponse.path);
        let response: BridgeResponseReference;
        try {
          response = JSON.parse(responseBytes.toString('utf8')) as BridgeResponseReference;
        } catch {
          throw new Error('Existing GitHub response ' + remoteResponse.path + ' is not valid JSON.');
        }
        const requestHash = createHash('sha256').update(requestBytes).digest('hex');
        if (response.id !== requestId || response.request_hash !== requestHash) {
          throw new Error('GitHub request ID ' + requestId + ' was reused with content that conflicts with its existing response.');
        }
        this.completedRequests.set(requestId, {
          requestBlobSha: entry.sha,
          responseBlobSha: remoteResponse.sha,
        });
        continue;
      }

      if (!cached) {
        await writeFileAtomic(localPath, requestBytes);
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

      const requestEntry = remoteRequests.find((candidate) => {
        const requestMatch = candidate.type === 'file' ? REQUEST_PATTERN.exec(candidate.name) : null;
        return requestMatch?.[1] === requestId;
      });
      if (requestEntry) {
        this.completedRequests.set(requestId, {
          requestBlobSha: requestEntry.sha,
          responseBlobSha: gitBlobSha(responseBytes),
        });
      }

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
