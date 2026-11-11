import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeAgentLayout, isValidAgentDirectoryName, LEGACY_AGENT_DIRECTORY_PATTERN, LEGACY_DEFAULT_AGENT, LEGACY_FLAT_MIGRATION_MARKER } from './agents.js';
import { createHash, randomUUID } from 'node:crypto';
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
      agentId + '/' + part.path,
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
    private readonly paths: GitHubBridgeCachePaths,
    private readonly workerStateDirectory: string,
  ) {}

  private agentPaths(agentId: string): AgentGitHubBridgeCachePaths {
    if (!isValidAgentDirectoryName(agentId)) {
      throw new Error('Invalid agent folder name in GitHub bridge queue: ' + agentId);
    }
    const root = path.join(this.paths.root, agentId);
    return {
      root,
      requests: path.join(root, 'requests'),
      responses: path.join(root, 'responses'),
      artifacts: path.join(root, 'artifacts'),
    };
  }

  private async ensureAgentPaths(agentId: string): Promise<AgentGitHubBridgeCachePaths> {
    const paths = this.agentPaths(agentId);
    await fs.mkdir(this.paths.root, { recursive: true });
    const rootStat = await fs.lstat(this.paths.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('The local GitHub bridge cache root must be a real directory.');
    }

    const samePath = (left: string, right: string): boolean => {
      const resolvedLeft = path.resolve(left);
      const resolvedRight = path.resolve(right);
      return process.platform === 'win32'
        ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
        : resolvedLeft === resolvedRight;
    };
    const realRoot = await fs.realpath(this.paths.root);
    await fs.mkdir(paths.root, { recursive: true });
    const agentStat = await fs.lstat(paths.root);
    if (!agentStat.isDirectory() || agentStat.isSymbolicLink()) {
      throw new Error('The local cache directory for agent ' + agentId + ' must be a real directory.');
    }
    const realAgent = await fs.realpath(paths.root);
    if (!samePath(realAgent, path.join(realRoot, agentId))) {
      throw new Error('The local cache directory for agent ' + agentId + ' resolves outside the agent cache root.');
    }

    for (const directory of [paths.requests, paths.responses, paths.artifacts]) {
      await fs.mkdir(directory, { recursive: true });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('The local queue directory for agent ' + agentId + ' must be a real directory: ' + directory);
      }
      const realDirectory = await fs.realpath(directory);
      if (!samePath(realDirectory, path.join(realAgent, path.basename(directory)))) {
        throw new Error('The local queue directory for agent ' + agentId + ' resolves outside its cache: ' + directory);
      }
    }
    return paths;
  }

  private parseQueueEntry(entry: GitHubContentEntry, queueName: 'requests' | 'responses'):
    { agentId: string; requestId: string } | undefined {
    const segments = entry.path.split('/');
    if (segments.length !== 3 || segments[1] !== queueName) return undefined;
    if (!isValidAgentDirectoryName(segments[0])) return undefined;
    const match = (queueName === 'requests' ? REQUEST_PATTERN : RESPONSE_PATTERN).exec(segments[2]);
    return match ? { agentId: segments[0], requestId: match[1] } : undefined;
  }

  private async readRemoteFlatMigrationAgent(): Promise<string | undefined> {
    let bytes: Buffer;
    try {
      bytes = await this.client.readFile(LEGACY_FLAT_MIGRATION_MARKER);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return undefined;
      throw error;
    }
    let marker: unknown;
    try {
      marker = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new Error('GitHub legacy flat-queue migration marker is invalid; source files were preserved: ' + errorMessage(error));
    }
    if (!marker || typeof marker !== 'object'
      || (marker as Record<string, unknown>).version !== 1
      || typeof (marker as Record<string, unknown>).agentId !== 'string') {
      throw new Error('GitHub legacy flat-queue migration marker has an unsupported format.');
    }
    const agentId = (marker as { agentId: string }).agentId;
    if (agentId !== LEGACY_DEFAULT_AGENT && !/^agent-legacy-flat-[0-9a-f]{32}$/.test(agentId)) {
      throw new Error('GitHub legacy flat-queue migration marker contains an invalid destination.');
    }
    return agentId;
  }

  private async writeRemoteFlatMigrationAgent(agentId: string): Promise<void> {
    const bytes = Buffer.from(JSON.stringify({ version: 1, agentId }) + '\n', 'utf8');
    await this.client.createFileIfAbsent(
      LEGACY_FLAT_MIGRATION_MARKER,
      bytes,
      'Record the destination for an interrupted legacy flat-queue migration',
    );
    const verified = await this.client.readFile(LEGACY_FLAT_MIGRATION_MARKER);
    if (!verified.equals(bytes)) {
      throw new Error('A different GitHub flat-queue migration marker already exists; no data was overwritten.');
    }
  }

  private async migrateLegacyRemoteQueue(localAgentIds: Set<string>, hasLocalFlatLegacyData: boolean): Promise<string | undefined> {
    const legacy = await this.client.listQueueFiles();
    const transfers: Array<{ source: string; destination: string }> = [];
    const flatTransfers: Array<{ source: string; queue: string; name: string }> = [];

    for (const entry of [...legacy.requests, ...legacy.responses]) {
      if (entry.path.startsWith('requests/') || entry.path.startsWith('responses/')) {
        const queue = entry.path.split('/')[0];
        flatTransfers.push({ source: entry.path, queue, name: entry.name });
        continue;
      }
      const previousAgent = /^agents\/([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)\/(requests|responses)\/([^/]+)$/.exec(entry.path);
      if (previousAgent) {
        transfers.push({
          source: entry.path,
          destination: 'agent-' + previousAgent[1] + '/' + previousAgent[2] + '/' + previousAgent[3],
        });
      }
    }

    for (const entry of legacy.legacyArtifacts) {
      const match = /^artifacts\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/([A-Za-z0-9][A-Za-z0-9._-]*)$/i.exec(entry.path);
      const previous = /^agents\/([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)\/artifacts\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/([A-Za-z0-9][A-Za-z0-9._-]*)$/i.exec(entry.path);
      if (match) {
        flatTransfers.push({ source: entry.path, queue: 'artifacts', name: match[1] + '/' + match[2] });
      } else if (previous) {
        transfers.push({
          source: entry.path,
          destination: 'agent-' + previous[1] + '/artifacts/' + previous[2] + '/' + previous[3],
        });
      }
    }

    let flatAgentId = await this.readRemoteFlatMigrationAgent();
    if (!flatAgentId && (flatTransfers.length > 0 || hasLocalFlatLegacyData)) {
      const occupied = new Set([...legacy.agentDirectories, ...localAgentIds]);
      flatAgentId = LEGACY_DEFAULT_AGENT;
      if (occupied.has(LEGACY_DEFAULT_AGENT)) {
        do {
          flatAgentId = 'agent-legacy-flat-' + randomUUID().replace(/-/g, '');
        } while (occupied.has(flatAgentId));
      }
      await this.writeRemoteFlatMigrationAgent(flatAgentId);
    }
    if (flatAgentId && flatTransfers.length > 0) {
      for (const transfer of flatTransfers) {
        const destination = transfer.queue === 'artifacts'
          ? flatAgentId + '/artifacts/' + transfer.name
          : flatAgentId + '/' + transfer.queue + '/' + transfer.name;
        transfers.push({ source: transfer.source, destination });
      }
    }

    // A response is the durable completion marker. Move requests first,
    // artifacts next, and responses last so agents cannot observe a response
    // before its referenced artifacts are present.
    const migrationOrder = (source: string): number =>
      /(?:^|\/)requests\//.test(source) ? 0 : /(?:^|\/)artifacts\//.test(source) ? 1 : 2;
    transfers.sort((left, right) =>
      migrationOrder(left.source) - migrationOrder(right.source)
      || left.source.localeCompare(right.source),
    );

    // Copy, verify exact bytes, and only then delete the legacy source. A
    // conflict aborts without overwriting either copy. The marker remains so
    // an interrupted migration resumes to the same destination.
    for (const transfer of transfers) {
      if (transfer.source === transfer.destination) continue;
      const sourceBytes = await this.client.readFile(transfer.source);
      await this.client.createFileIfAbsent(
        transfer.destination,
        sourceBytes,
        'Migrate legacy Desktop Commander queue item into its root-level agent folder',
      );
      const destinationBytes = await this.client.readFile(transfer.destination);
      if (!destinationBytes.equals(sourceBytes)) {
        throw new Error(
          'Legacy GitHub queue migration could not verify ' + transfer.destination +
          '. The original ' + transfer.source + ' was preserved.',
        );
      }
      await this.client.deleteFileIfPresent(
        transfer.source,
        'Remove verified legacy Desktop Commander queue item after migration',
      );
    }

    // The old release wrote this exact sentinel to keep agents/ tracked.
    // Preserve unrelated user files, including unknown sentinels.
    let previousAgentSentinel: Buffer | undefined;
    try {
      previousAgentSentinel = await this.client.readFile('agents/.gitkeep');
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
    }
    if (previousAgentSentinel?.equals(Buffer.from('Desktop Commander agent-scoped queues.\n', 'utf8'))) {
      await this.client.deleteFileIfPresent(
        'agents/.gitkeep',
        'Remove verified generated nested agent namespace sentinel after root-level migration',
      );
    }

    // Do not delete flat queue sentinels or other unrecognized content. They
    // are not protocol requests and may be user-owned files.
    // Keep the marker in the repository as durable migration identity. The
    // local cache may still contain old flat files which must move to this
    // same compatibility folder on a later restart. It is tiny metadata, not
    // an agent registry or a source of identity for new conversations.
    return flatAgentId;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.paths.root, { recursive: true });
    const rootStat = await fs.lstat(this.paths.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('The local GitHub bridge cache root must be a real directory.');
    }

    // Collect local agent identities and old nested names before choosing a
    // compatibility destination for any unscoped flat cache/remote queues.
    const localAgentIds = new Set<string>();
    let hasLocalFlatLegacyData = false;
    for (const entry of await fs.readdir(this.paths.root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && isValidAgentDirectoryName(entry.name)) {
        localAgentIds.add(entry.name);
      }
      if (['requests', 'responses', 'artifacts'].includes(entry.name)) {
        hasLocalFlatLegacyData = true;
      }
    }
    const previousAgentsRoot = path.join(this.paths.root, 'agents');
    try {
      const previousStat = await fs.lstat(previousAgentsRoot);
      if (!previousStat.isDirectory() || previousStat.isSymbolicLink()) {
        throw new Error('The previous local GitHub agents namespace must be a real directory.');
      }
      for (const entry of await fs.readdir(previousAgentsRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()
          && LEGACY_AGENT_DIRECTORY_PATTERN.test(entry.name)) {
          localAgentIds.add('agent-' + entry.name);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    // A local worker state may contain legacy flat request ledgers even when
    // its cache queue folders are empty. Preserve those records in the same
    // destination selected for remote flat queues.
    const legacyLedgerRoot = path.join(this.workerStateDirectory, 'requests');
    try {
      const ledgerStat = await fs.lstat(legacyLedgerRoot);
      if (!ledgerStat.isDirectory() || ledgerStat.isSymbolicLink()) {
        throw new Error('The local GitHub ledger root must be a real directory.');
      }
      const entries = await fs.readdir(legacyLedgerRoot, { withFileTypes: true });
      if (entries.some(entry => entry.isFile() && !entry.isSymbolicLink()
        || entry.name === 'default' && entry.isDirectory() && !entry.isSymbolicLink())) {
        hasLocalFlatLegacyData = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    // Reconcile the remote legacy layout first so local cache requests and
    // their durable ledgers use exactly the same compatibility destination.
    const flatMigrationAgentId = await this.migrateLegacyRemoteQueue(localAgentIds, hasLocalFlatLegacyData);

    // Move local staged queues, artifacts, and durable idempotency ledgers
    // together before the worker starts processing anything.
    await initializeAgentLayout(this.paths.root, this.workerStateDirectory, flatMigrationAgentId);

    // README.md is the repository-root marker; actual queue folders are
    // created only when a conversation or legacy queue has work to store.

    // Publish the single current README whenever its generated content changes.
    // The local digest avoids an unnecessary remote README fetch on each poll.
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

  private async listLocalResponses(): Promise<Array<{
    agentId: string;
    paths: AgentGitHubBridgeCachePaths;
    name: string;
    responsePath: string;
    requestId: string;
  }>> {
    const results: Array<{
      agentId: string;
      paths: AgentGitHubBridgeCachePaths;
      name: string;
      responsePath: string;
      requestId: string;
    }> = [];
    let agentEntries;
    try {
      agentEntries = await fs.readdir(this.paths.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return results;
      throw error;
    }
    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory() || agentEntry.isSymbolicLink()
        || !isValidAgentDirectoryName(agentEntry.name)) continue;
      const paths = await this.ensureAgentPaths(agentEntry.name);
      let responseEntries;
      try {
        responseEntries = await fs.readdir(paths.responses, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of responseEntries) {
        const match = entry.isFile() ? RESPONSE_PATTERN.exec(entry.name) : null;
        if (!match) continue;
        results.push({
          agentId: agentEntry.name,
          paths,
          name: entry.name,
          responsePath: path.join(paths.responses, entry.name),
          requestId: match[1],
        });
      }
    }
    return results.sort((a, b) =>
      a.agentId.localeCompare(b.agentId) || a.name.localeCompare(b.name),
    );
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
      queueDiscoveryError = error;
    }

    const remoteResponseByRequestKey = new Map<string, GitHubContentEntry>();
    for (const entry of remoteResponses) {
      if (entry.type !== 'file') continue;
      const identity = this.parseQueueEntry(entry, 'responses');
      if (identity) remoteResponseByRequestKey.set(identity.agentId + ':' + identity.requestId, entry);
    }
    const completedRequestKeys = new Set(remoteResponseByRequestKey.keys());

    const requestSyncErrors: string[] = [];
    if (!queueDiscoveryError) {
      const pendingRequests = remoteRequests.filter((entry) =>
        entry.type === 'file' && this.parseQueueEntry(entry, 'requests') !== undefined,
      );
      // Batch remote reads so independent agents can make progress concurrently
      // without flooding the GitHub API or the local disk.
      for (let offset = 0; offset < pendingRequests.length; offset += 8) {
        const batch = pendingRequests.slice(offset, offset + 8);
        await Promise.all(batch.map(async (entry) => {
          try {
            if (entry.size > MAX_GITHUB_BRIDGE_FILE_BYTES) {
              throw new Error('Remote request ' + entry.path + ' exceeds the 50 MiB GitHub bridge file limit.');
            }
            const identity = this.parseQueueEntry(entry, 'requests');
            if (!identity) return;
            const requestKey = identity.agentId + ':' + identity.requestId;
            const remoteResponse = remoteResponseByRequestKey.get(requestKey);
            const previouslyObservedSha = this.observedRequestBlobShas.get(requestKey);
            const firstObservation = previouslyObservedSha === undefined;
            if (previouslyObservedSha && previouslyObservedSha !== entry.sha && remoteResponse) {
              console.warn(
                'GitHub bridge: ignored updated ' + entry.path + ' because its matching response already exists. ' +
                'Request IDs are scoped to one agent folder and cannot be reused.',
              );
            }
            this.observedRequestBlobShas.set(requestKey, entry.sha);
            if (remoteResponse) return;

            const paths = await this.ensureAgentPaths(identity.agentId);
            const localPath = path.join(paths.requests, entry.name);
            const cached = await readOptional(localPath);
            let requestBytes: Buffer;
            if (cached) {
              if (gitBlobSha(cached) !== entry.sha) {
                throw new Error('Local cache conflicts with remote request ' + entry.path + '; the local file was not overwritten.');
              }
              requestBytes = cached;
            } else {
              requestBytes = await this.client.readFile(entry.path);
              if (gitBlobSha(requestBytes) !== entry.sha) {
                throw new Error('GitHub request ' + entry.path + ' changed while being downloaded. The next poll will retry.');
              }
            }
            if (!cached) await writeFileAtomic(localPath, requestBytes);
            if (firstObservation) {
              console.log('GitHub bridge: staged ' + entry.path + ' locally for execution.');
            }
          } catch (error) {
            requestSyncErrors.push(entry.path + ': ' + errorMessage(error));
          }
        }));
      }
    }

    const localResponses = await this.listLocalResponses();
    const responseSyncErrors: string[] = [];
    for (const entry of localResponses) {
      const requestKey = entry.agentId + ':' + entry.requestId;
      const responsePath = entry.responsePath;
      try {
        const sourceResponseBytes = await fs.readFile(responsePath);
        let response: BridgeResponseReference;
        try {
          response = JSON.parse(sourceResponseBytes.toString('utf8')) as BridgeResponseReference;
        } catch {
          throw new Error('Local bridge response ' + entry.agentId + '/' + entry.name + ' is not valid JSON.');
        }
        if (response.id !== entry.requestId || typeof response.request_hash !== 'string') {
          throw new Error('Local bridge response ' + entry.agentId + '/' + entry.name + ' has an invalid id or request hash.');
        }
        await fs.mkdir(entry.paths.artifacts, { recursive: true });
        await ensureSafeArtifactDirectory(entry.paths, entry.requestId);

        let responseChanged = await externalizeOversizedResponse(response, entry.requestId, entry.paths);
        responseChanged = (await prepareResponseArtifacts(response, entry.requestId, entry.paths)) || responseChanged;
        const responseBytes = serializeResponse(response);
        if (responseBytes.length > MAX_GITHUB_BRIDGE_FILE_BYTES) {
          throw new Error('Response ' + entry.name + ' exceeds the 50 MiB GitHub bridge file limit after preparing artifacts.');
        }
        if (responseChanged) await writeFileAtomic(responsePath, responseBytes);

        for (const artifact of response.artifacts || []) {
          await uploadResponseArtifact(this.client, entry.paths, entry.agentId, entry.requestId, artifact);
        }

        const remoteResponsePath = entry.agentId + '/responses/' + entry.name;
        await this.client.createFileIfAbsent(
          remoteResponsePath,
          responseBytes,
          'Publish Desktop Commander response ' + entry.agentId + '/' + entry.requestId,
        );
        console.log(
          'GitHub bridge: published ' + remoteResponsePath +
          (typeof response.status === 'string' ? ' (' + response.status + ')' : '') + '.',
        );

        await fs.rm(responsePath, { force: true });
        await Promise.all([
          fs.rm(path.join(entry.paths.requests, entry.requestId + '.json'), { force: true }),
          fs.rm(path.join(entry.paths.requests, entry.requestId + '.md'), { force: true }),
          fs.rm(path.join(entry.paths.requests, 'request-' + entry.requestId + '.json'), { force: true }),
          fs.rm(path.join(entry.paths.requests, 'request-' + entry.requestId + '.md'), { force: true }),
        ]);
        await fs.rm(path.join(entry.paths.artifacts, entry.requestId), { recursive: true, force: true });
      } catch (error) {
        responseSyncErrors.push(entry.agentId + '/' + entry.name + ': ' + errorMessage(error));
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
        'Could not discover the remote GitHub agent queues; local response publication was still attempted: ' +
        errorMessage(queueDiscoveryError),
      );
    }

    // Completed request files are never staged again after a restart. This
    // comparison is agent-scoped, so two agents may use the same request ID.
    for (const entry of remoteRequests) {
      const identity = entry.type === 'file' ? this.parseQueueEntry(entry, 'requests') : undefined;
      if (!identity) continue;
      const requestKey = identity.agentId + ':' + identity.requestId;
      if (!completedRequestKeys.has(requestKey)) continue;
      const agentPaths = await this.ensureAgentPaths(identity.agentId);
      const localPath = path.join(agentPaths.requests, entry.name);
      await fs.rm(localPath, { force: true });
    }
  }
}
