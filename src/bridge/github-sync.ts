import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { createGuideIfMissing } from './runtime.js';
import {
  GitHubApiError,
  GitHubRepositoryClient,
  MAX_GITHUB_BRIDGE_FILE_BYTES,
  type GitHubContentEntry,
} from './github.js';

export interface GitHubBridgeCachePaths {
  root: string;
  agents: string;
}

interface AgentGitHubBridgeCachePaths {
  root: string;
  requests: string;
  responses: string;
  artifacts: string;
}

const REQUEST_PATTERN = /^(?:request-)?([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.(json|md)$/i;
const RESPONSE_PATTERN = /^(?:response-)?([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.json$/i;

interface BridgeArtifactPartReference {
  path: string;
  bytes: number;
  sha256: string;
}

interface BridgeArtifactReference extends BridgeArtifactPartReference {
  mimeType?: string;
  parts?: BridgeArtifactPartReference[];
}

interface BridgeCommandResultReference {
  content?: unknown[];
  structuredContent?: unknown;
  error?: string;
  artifacts?: BridgeArtifactReference[];
}

interface BridgeResponseReference {
  id: string;
  request_hash: string;
  status?: string;
  results?: BridgeCommandResultReference[];
  artifacts?: BridgeArtifactReference[];
  error?: string;
}

const MAX_GITHUB_BRIDGE_CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_GITHUB_INLINE_RESPONSE_BYTES = 1_000_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function serializeResponse(response: BridgeResponseReference): Buffer {
  return Buffer.from(JSON.stringify(response, null, 2) + '\n', 'utf8');
}

function serializeJsonValue(value: unknown): Buffer {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('A large response field could not be serialized as JSON.');
  }
  return Buffer.from(serialized, 'utf8');
}

function resolveArtifactPath(root: string, requestId: string, artifactPath: string): string {
  if (!isSafeArtifactPath(artifactPath, requestId)) {
    throw new Error('Response contains an unsafe artifact path: ' + artifactPath);
  }
  const localPath = path.resolve(root, ...artifactPath.split('/'));
  const relativePath = path.relative(root, localPath);
  if (!relativePath || relativePath.startsWith('..' + path.sep) || path.isAbsolute(relativePath)) {
    throw new Error('Response references an artifact outside the local GitHub cache: ' + artifactPath);
  }
  return localPath;
}

async function ensureSafeArtifactDirectory(
  paths: AgentGitHubBridgeCachePaths,
  requestId: string,
): Promise<void> {
  const realRoot = await fs.realpath(paths.root);
  const artifactRootStat = await fs.lstat(paths.artifacts);
  if (!artifactRootStat.isDirectory() || artifactRootStat.isSymbolicLink()) {
    throw new Error('The local GitHub artifact cache root must be a real directory.');
  }
  const realArtifactRoot = await fs.realpath(paths.artifacts);
  if (path.resolve(realArtifactRoot) !== path.resolve(path.join(realRoot, 'artifacts'))) {
    throw new Error('The local GitHub artifact cache root resolves outside the bridge cache.');
  }

  const requestDirectory = path.join(paths.artifacts, requestId);
  await fs.mkdir(requestDirectory, { recursive: true });
  const requestDirectoryStat = await fs.lstat(requestDirectory);
  if (!requestDirectoryStat.isDirectory() || requestDirectoryStat.isSymbolicLink()) {
    throw new Error('The local artifact directory for request ' + requestId + ' must be a real directory.');
  }
  const realRequestDirectory = await fs.realpath(requestDirectory);
  if (path.resolve(realRequestDirectory) !== path.resolve(path.join(realArtifactRoot, requestId))) {
    throw new Error('The local artifact directory for request ' + requestId + ' resolves outside the bridge cache.');
  }
}

async function writeBufferArtifact(
  paths: AgentGitHubBridgeCachePaths,
  requestId: string,
  artifactPath: string,
  bytes: Buffer,
): Promise<BridgeArtifactReference> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const reference: BridgeArtifactReference = {
    path: artifactPath,
    bytes: bytes.length,
    sha256,
    mimeType: 'application/json',
  };
  const totalParts = Math.ceil(bytes.length / MAX_GITHUB_BRIDGE_CHUNK_BYTES);
  if (totalParts <= 1) {
    const localPath = resolveArtifactPath(paths.root, requestId, artifactPath);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await writeFileAtomic(localPath, bytes);
    return reference;
  }

  const parts: BridgeArtifactPartReference[] = [];
  for (let index = 0; index < totalParts; index++) {
    const start = index * MAX_GITHUB_BRIDGE_CHUNK_BYTES;
    const chunk = bytes.subarray(start, Math.min(start + MAX_GITHUB_BRIDGE_CHUNK_BYTES, bytes.length));
    const partPath = artifactPath + '.part-' +
      String(index + 1).padStart(4, '0') + '-of-' + String(totalParts).padStart(4, '0');
    const localPath = resolveArtifactPath(paths.root, requestId, partPath);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await writeFileAtomic(localPath, chunk);
    parts.push({
      path: partPath,
      bytes: chunk.length,
      sha256: createHash('sha256').update(chunk).digest('hex'),
    });
  }
  return { ...reference, parts };
}

async function externalizeOversizedResponse(
  response: BridgeResponseReference,
  requestId: string,
  paths: AgentGitHubBridgeCachePaths,
): Promise<boolean> {
  if (serializeResponse(response).length <= MAX_GITHUB_INLINE_RESPONSE_BYTES) return false;

  type ExternalizableField = {
    commandIndex: number;
    result?: BridgeCommandResultReference;
    field: 'content' | 'structuredContent' | 'error' | 'response_error';
    bytes: Buffer;
  };
  const fields: ExternalizableField[] = [];
  for (const [commandIndex, result] of (response.results || []).entries()) {
    if (Array.isArray(result.content) && result.content.length > 0) {
      fields.push({ commandIndex, result, field: 'content', bytes: serializeJsonValue(result.content) });
    }
    if (result.structuredContent !== undefined) {
      fields.push({ commandIndex, result, field: 'structuredContent', bytes: serializeJsonValue(result.structuredContent) });
    }
    if (typeof result.error === 'string' && result.error.length > 0) {
      fields.push({ commandIndex, result, field: 'error', bytes: serializeJsonValue(result.error) });
    }
  }
  if (typeof response.error === 'string' && response.error.length > 0) {
    fields.push({ commandIndex: -1, field: 'response_error', bytes: serializeJsonValue(response.error) });
  }
  fields.sort((left, right) => right.bytes.length - left.bytes.length);

  let changed = false;
  for (const field of fields) {
    if (serializeResponse(response).length <= MAX_GITHUB_INLINE_RESPONSE_BYTES) break;
    const commandLabel = field.commandIndex >= 0
      ? 'command-' + String(field.commandIndex + 1).padStart(3, '0')
      : 'response';
    const artifactPath = 'artifacts/' + requestId + '/' + commandLabel + '-' + field.field + '.json';
    const artifact = await writeBufferArtifact(paths, requestId, artifactPath, field.bytes);
    const location = artifact.parts?.length
      ? artifact.path + ' (read all ' + artifact.parts.length + ' parts in listed order)'
      : artifact.path;

    if (field.result) {
      field.result.artifacts = [...(field.result.artifacts || []), artifact];
      if (field.field === 'content') {
        field.result.content = [{
          type: 'text',
          text: 'The tool output was too large to include in the response and was moved to a JSON artifact at ' + location + '. Retrieve the artifact from the repository and parse the JSON to restore the complete original tool output.',
        }];
      } else if (field.field === 'structuredContent') {
        field.result.structuredContent = {
          externalized: true,
          artifact_path: artifact.path,
          ...(artifact.parts ? { parts: artifact.parts } : {}),
        };
      } else if (field.field === 'error') {
        field.result.error = 'The full error detail was saved as a JSON artifact at ' + location + '.';
      }
    } else {
      response.error = 'The full response error was saved as a JSON artifact at ' + location + '.';
    }
    response.artifacts = [...(response.artifacts || []), artifact];
    changed = true;
  }

  const finalSize = serializeResponse(response).length;
  if (finalSize > MAX_GITHUB_INLINE_RESPONSE_BYTES) {
    throw new Error(
      'Response response-' + requestId + '.json remains ' + finalSize +
      ' bytes after externalizing large result fields; it cannot fit within the safe 1 MB GitHub upload target.',
    );
  }
  return changed;
}

async function splitLargeLocalArtifact(
  paths: AgentGitHubBridgeCachePaths,
  requestId: string,
  artifact: BridgeArtifactReference,
): Promise<{ artifact: BridgeArtifactReference; changed: boolean }> {
  if (artifact.parts !== undefined) {
    if (!Array.isArray(artifact.parts) || artifact.parts.length === 0) {
      throw new Error('Response artifact ' + artifact.path + ' has an invalid empty parts list.');
    }
    return { artifact, changed: false };
  }

  const localPath = resolveArtifactPath(paths.root, requestId, artifact.path);
  const stat = await fs.lstat(localPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Response artifact is not a regular local file: ' + artifact.path);
  }
  if (stat.size !== artifact.bytes) {
    throw new Error('Response artifact ' + artifact.path + ' does not match its recorded byte count.');
  }
  if (stat.size <= MAX_GITHUB_BRIDGE_CHUNK_BYTES) {
    return { artifact, changed: false };
  }

  const totalParts = Math.ceil(stat.size / MAX_GITHUB_BRIDGE_CHUNK_BYTES);
  const parts: BridgeArtifactPartReference[] = [];
  const wholeHash = createHash('sha256');
  const handle = await fs.open(localPath, 'r');
  let position = 0;
  try {
    for (let index = 0; index < totalParts; index++) {
      const chunkLength = Math.min(MAX_GITHUB_BRIDGE_CHUNK_BYTES, stat.size - position);
      const chunk = Buffer.allocUnsafe(chunkLength);
      let offset = 0;
      while (offset < chunkLength) {
        const read = await handle.read(chunk, offset, chunkLength - offset, position + offset);
        if (read.bytesRead === 0) {
          throw new Error('Response artifact ' + artifact.path + ' changed while it was being split.');
        }
        offset += read.bytesRead;
      }
      wholeHash.update(chunk);
      const partPath = artifact.path + '.part-' +
        String(index + 1).padStart(4, '0') + '-of-' + String(totalParts).padStart(4, '0');
      const partLocalPath = resolveArtifactPath(paths.root, requestId, partPath);
      await fs.mkdir(path.dirname(partLocalPath), { recursive: true });
      await writeFileAtomic(partLocalPath, chunk);
      parts.push({
        path: partPath,
        bytes: chunk.length,
        sha256: createHash('sha256').update(chunk).digest('hex'),
      });
      position += chunkLength;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw new Error('Response artifact ' + artifact.path + ' changed while it was being split.');
    }
  } finally {
    await handle.close();
  }
  if (wholeHash.digest('hex') !== artifact.sha256) {
    throw new Error('Response artifact ' + artifact.path + ' does not match its recorded SHA-256 hash.');
  }
  return { artifact: { ...artifact, parts }, changed: true };
}

async function prepareResponseArtifacts(
  response: BridgeResponseReference,
  requestId: string,
  paths: AgentGitHubBridgeCachePaths,
): Promise<boolean> {
  const results = response.results || [];
  const references = [
    ...(response.artifacts || []),
    ...results.flatMap((result) => result.artifacts || []),
  ];
  const unique = new Map<string, BridgeArtifactReference>();
  for (const artifact of references) {
    if (!artifact || typeof artifact.path !== 'string') {
      throw new Error('Response contains an invalid artifact reference.');
    }
    if (!unique.has(artifact.path)) unique.set(artifact.path, artifact);
  }

  const prepared = new Map<string, BridgeArtifactReference>();
  let changed = false;
  for (const [artifactPath, artifact] of unique) {
    const result = await splitLargeLocalArtifact(paths, requestId, artifact);
    prepared.set(artifactPath, result.artifact);
    changed ||= result.changed;
  }

  response.artifacts = [...prepared.values()];
  for (const result of results) {
    if (result.artifacts) {
      result.artifacts = result.artifacts.map((artifact) => {
        const value = prepared.get(artifact.path);
        if (!value) throw new Error('Response references an artifact that could not be prepared: ' + artifact.path);
        return value;
      });
    }
  }
  return changed;
}

async function uploadResponseArtifact(
  client: GitHubRepositoryClient,
  paths: AgentGitHubBridgeCachePaths,
  agentId: string,
  requestId: string,
  artifact: BridgeArtifactReference,
): Promise<void> {
  const parts = artifact.parts || [{
    path: artifact.path,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
  }];
  const wholeHash = createHash('sha256');
  let totalBytes = 0;
  for (const part of parts) {
    const localPath = resolveArtifactPath(paths.root, requestId, part.path);
    const stat = await fs.lstat(localPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Response artifact part is not a regular local file: ' + part.path);
    }
    if (!Number.isSafeInteger(part.bytes) || part.bytes < 1
      || part.bytes > MAX_GITHUB_BRIDGE_CHUNK_BYTES || stat.size !== part.bytes) {
      throw new Error('Response artifact part ' + part.path + ' does not match the safe upload size or recorded byte count.');
    }
    const bytes = await fs.readFile(localPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== part.sha256) {
      throw new Error('Response artifact part ' + part.path + ' does not match its recorded SHA-256 hash.');
    }
    wholeHash.update(bytes);
    totalBytes += bytes.length;
    await client.createFileIfAbsent(
      'agents/' + agentId + '/' + part.path,
      bytes,
      'Store Desktop Commander bridge artifact ' + agentId + '/' + requestId,
    );
  }
  if (totalBytes !== artifact.bytes || wholeHash.digest('hex') !== artifact.sha256) {
    throw new Error('Response artifact ' + artifact.path + ' does not match its recorded byte count or SHA-256 hash.');
  }
}

export class GitHubBridgeSync {
  private syncPromise?: Promise<void>;
  private syncRequestedWhileRunning = false;
  private readonly observedRequestBlobShas = new Map<string, string>();
  constructor(
    private readonly client: GitHubRepositoryClient,
    private readonly paths: AgentGitHubBridgeCachePaths,
  ) {}

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.paths.root, { recursive: true }),
      fs.mkdir(this.paths.requests, { recursive: true }),
      fs.mkdir(this.paths.responses, { recursive: true }),
      fs.mkdir(this.paths.artifacts, { recursive: true }),
    ]);

    // Do not list queue directories through the Contents API: GitHub caps
    // directory listings at 1,000 entries. Probe each sentinel by exact path.
    const queueDirectories = ['requests', 'responses', 'artifacts'];
    await Promise.all(queueDirectories.map(async (directory) => {
      const sentinelPath = directory + '/.gitkeep';
      try {
        await this.client.readFile(sentinelPath);
      } catch (error) {
        if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
        await this.client.createFileIfAbsent(
          sentinelPath,
          Buffer.from('Desktop Commander bridge queue directory.\n', 'utf8'),
          'Initialize Desktop Commander bridge queue',
        );
      }
    }));

    // Publishing the generated guide is a one-time/version-change operation.
    // Persist its digest in the local cache so routine restarts do not make
    // extra root-list, README-download, and README-update API round trips.
    const guideDirectory = await fs.mkdtemp(path.join(this.paths.root, '.github-guide-'));
    let guideDigest: string;
    let readme: Buffer;
    try {
      await createGuideIfMissing(guideDirectory);
      readme = await fs.readFile(path.join(guideDirectory, 'README.md'));
      guideDigest = createHash('sha256').update(readme).digest('hex');
    } finally {
      await fs.rm(guideDirectory, { recursive: true, force: true });
    }

    const guideMarkerPath = path.join(this.paths.root, '.github-guide-sha256');
    const previousDigest = await readOptional(guideMarkerPath);
    if (previousDigest?.toString('utf8').trim() !== guideDigest) {
      await this.client.deleteFileIfPresent(
        'DESKTOP_COMMANDER_BRIDGE.md',
        'Remove obsolete separate Desktop Commander bridge guide',
      );
      await this.client.writeFile(
        'README.md',
        readme,
        'Publish shared Desktop Commander AI README',
      );
      await writeFileAtomic(guideMarkerPath, Buffer.from(guideDigest + '\n', 'utf8'));
    }
  }

  async syncOnce(): Promise<void> {
    if (this.syncPromise) {
      // A webhook or local response event can arrive after the current pass has
      // already listed its inputs. Remember that signal and run one more pass.
      this.syncRequestedWhileRunning = true;
      return this.syncPromise;
    }

    const running = (async () => {
      let lastError: unknown;
      do {
        this.syncRequestedWhileRunning = false;
        try {
          await this.syncInternal();
          lastError = undefined;
        } catch (error) {
          // A webhook or response-folder event may have arrived during a failed
          // pass. Honor that queued signal and retry before surfacing the error.
          lastError = error;
        }
      } while (this.syncRequestedWhileRunning);
      if (lastError) throw lastError;
    })().finally(() => {
      this.syncPromise = undefined;
    });
    this.syncPromise = running;
    return running;
  }

  private async syncInternal(): Promise<void> {
    let remoteRequests: GitHubContentEntry[] = [];
    let remoteResponses: GitHubContentEntry[] = [];
    let queueDiscoveryError: unknown;
    try {
      const queue = await this.client.listQueueFiles();
      remoteRequests = queue.requests;
      remoteResponses = queue.responses;
    } catch (error) {
      // Do not let a remote listing outage block publication of results that
      // the local worker has already completed.
      queueDiscoveryError = error;
    }
    const remoteResponseByRequestId = new Map<string, GitHubContentEntry>();
    for (const entry of remoteResponses) {
      if (entry.type !== 'file') continue;
      const match = RESPONSE_PATTERN.exec(entry.name);
      if (match) remoteResponseByRequestId.set(match[1], entry);
    }
    const completedRequestIds = new Set(remoteResponseByRequestId.keys());

    const requestSyncErrors: string[] = [];
    if (!queueDiscoveryError) {
      const pendingRequests = remoteRequests.filter((entry) =>
        entry.type === 'file' && REQUEST_PATTERN.test(entry.name),
      );
      // Bound concurrent reads: parallel staging is faster for independent
      // requests without flooding the GitHub API or local filesystem.
      for (let offset = 0; offset < pendingRequests.length; offset += 8) {
        const batch = pendingRequests.slice(offset, offset + 8);
        await Promise.all(batch.map(async (entry) => {
          try {
            if (entry.size > MAX_GITHUB_BRIDGE_FILE_BYTES) {
              throw new Error('Remote request ' + entry.path + ' exceeds the 50 MiB GitHub bridge file limit.');
            }
            const match = REQUEST_PATTERN.exec(entry.name);
            if (!match) return;
            const requestId = match[1];
            const remoteResponse = remoteResponseByRequestId.get(requestId);
            const previouslyObservedSha = this.observedRequestBlobShas.get(requestId);
            const firstObservation = previouslyObservedSha === undefined;
            if (previouslyObservedSha && previouslyObservedSha !== entry.sha && remoteResponse) {
              console.warn(
                'GitHub bridge: ignored updated ' + entry.name + ' because response ' + requestId +
                ' already exists. Request IDs cannot be reused; submit this work with a new ID.',
              );
            }
            this.observedRequestBlobShas.set(requestId, entry.sha);
            if (remoteResponse) return;

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

            if (!cached) await writeFileAtomic(localPath, requestBytes);
            if (firstObservation) {
              console.log('GitHub bridge: ' + entry.name + ' is staged locally for execution.');
            }
          } catch (error) {
            requestSyncErrors.push(entry.name + ': ' + errorMessage(error));
          }
        }));
      }
    }
    // Artifacts must reach GitHub before the response file signals completion.
    const localResponses = (await fs.readdir(this.paths.responses, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && RESPONSE_PATTERN.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const responseSyncErrors: string[] = [];
    for (const entry of localResponses) {
      const match = RESPONSE_PATTERN.exec(entry.name);
      if (!match) continue;
      const requestId = match[1];
      const responsePath = path.join(this.paths.responses, entry.name);
      try {
        const sourceResponseBytes = await fs.readFile(responsePath);
        let response: BridgeResponseReference;
        try {
          response = JSON.parse(sourceResponseBytes.toString('utf8')) as BridgeResponseReference;
        } catch {
          throw new Error('Local bridge response ' + entry.name + ' is not valid JSON.');
        }
        if (response.id !== requestId || typeof response.request_hash !== 'string') {
          throw new Error('Local bridge response ' + entry.name + ' has an invalid id or request hash.');
        }
        await ensureSafeArtifactDirectory(this.paths, requestId);

        let responseChanged = await externalizeOversizedResponse(response, requestId, this.paths);
        responseChanged = (await prepareResponseArtifacts(response, requestId, this.paths)) || responseChanged;
        const responseBytes = serializeResponse(response);
        if (responseBytes.length > MAX_GITHUB_BRIDGE_FILE_BYTES) {
          throw new Error('Response ' + entry.name + ' exceeds the 50 MiB GitHub bridge file limit after preparing its artifacts.');
        }
        if (responseChanged) await writeFileAtomic(responsePath, responseBytes);

        // Keep artifact parts below the 50 MiB Contents API file limit, while
        // avoiding a commit/push for every small slice of a large artifact.
        for (const artifact of response.artifacts || []) {
          await uploadResponseArtifact(this.client, this.paths, requestId, artifact);
        }

        await this.client.createFileIfAbsent(
          'responses/' + entry.name,
          responseBytes,
          'Publish Desktop Commander bridge response ' + requestId,
        );
        console.log(
          'GitHub bridge: published responses/' + entry.name + ' to GitHub' +
          (typeof response.status === 'string' ? ' (' + response.status + ')' : '') + '.',
        );

        // The remote response is durable now. Remove local staging copies so the
        // cache does not grow forever; remote queue history remains untouched.
        await fs.rm(responsePath, { force: true });
        await Promise.all([
          fs.rm(path.join(this.paths.requests, requestId + '.json'), { force: true }),
          fs.rm(path.join(this.paths.requests, requestId + '.md'), { force: true }),
          fs.rm(path.join(this.paths.requests, 'request-' + requestId + '.json'), { force: true }),
          fs.rm(path.join(this.paths.requests, 'request-' + requestId + '.md'), { force: true }),
        ]);
        await fs.rm(path.join(this.paths.artifacts, requestId), { recursive: true, force: true });
      } catch (error) {
        // One malformed or unpublishable response must not block unrelated
        // completed responses in the same local queue snapshot.
        responseSyncErrors.push(entry.name + ': ' + errorMessage(error));
      }
    }
    if (responseSyncErrors.length > 0) {
      throw new Error(
        'Could not synchronize ' + responseSyncErrors.length + ' local response file(s): ' +
        responseSyncErrors.join('; '),
      );
    }
    if (requestSyncErrors.length > 0) {
      throw new Error(
        'Could not stage ' + requestSyncErrors.length + ' remote request file(s): ' +
        requestSyncErrors.join('; '),
      );
    }
    if (queueDiscoveryError) {
      throw new Error(
        'Could not discover the remote GitHub request queue; local response publication was still attempted: ' +
        errorMessage(queueDiscoveryError),
      );
    }

    // A response may already have been published by a previous run. Do not
    // stage its request again or re-execute it after a restart.
    for (const entry of remoteRequests) {
      const match = entry.type === 'file' ? REQUEST_PATTERN.exec(entry.name) : null;
      if (!match || !completedRequestIds.has(match[1])) continue;
      await fs.rm(path.join(this.paths.requests, entry.name), { force: true });
    }
  }
}
