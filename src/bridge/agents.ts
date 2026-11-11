import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const LEGACY_AGENT_DIRECTORY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const AGENT_DIRECTORY_PATTERN = /^agent-[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const LEGACY_DEFAULT_AGENT = 'agent-default';
export const LEGACY_FLAT_MIGRATION_MARKER = '.desktop-commander-flat-migration.json';
const GENERATED_LEGACY_FLAT_AGENT_PATTERN = /^agent-legacy-flat-[0-9a-f]{32}$/;

const WINDOWS_RESERVED_AGENT_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function isValidAgentDirectoryName(value: string): boolean {
  return AGENT_DIRECTORY_PATTERN.test(value) && !WINDOWS_RESERVED_AGENT_NAMES.test(value);
}

export interface AgentQueuePaths {
  agentId: string;
  root: string;
  requests: string;
  responses: string;
  artifacts: string;
  ledgers: string;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureSafeDestinationParent(boundaryRoot: string, destination: string): Promise<void> {
  const relative = path.relative(boundaryRoot, path.dirname(destination));
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Legacy bridge migration destination escapes its storage root: ' + destination);
  }
  let current = boundaryRoot;
  const rootStat = await fs.lstat(boundaryRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Legacy bridge migration storage root must be a real directory: ' + boundaryRoot);
  }
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Legacy bridge migration refuses a symlink or non-directory destination parent: ' + current);
    }
  }
}

async function moveTreeWithoutOverwrite(
  source: string,
  destination: string,
  boundaryRoot: string,
): Promise<void> {
  await ensureSafeDestinationParent(boundaryRoot, destination);
  const sourceStat = await fs.lstat(source);
  if (sourceStat.isSymbolicLink()) {
    throw new Error('Legacy bridge migration refuses to follow symbolic links: ' + source);
  }
  if (sourceStat.isDirectory()) {
    if (await pathExists(destination)) {
      const destinationStat = await fs.lstat(destination);
      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
        throw new Error('Legacy bridge migration found a conflicting destination: ' + destination);
      }
    } else {
      await fs.mkdir(destination, { recursive: true });
    }
    for (const entry of await fs.readdir(source)) {
      await moveTreeWithoutOverwrite(path.join(source, entry), path.join(destination, entry), boundaryRoot);
    }
    await fs.rmdir(source);
    return;
  }
  if (!sourceStat.isFile()) {
    throw new Error('Legacy bridge migration only supports regular files and directories: ' + source);
  }
  if (await pathExists(destination)) {
    const destinationStat = await fs.lstat(destination);
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
      throw new Error('Legacy bridge migration found a conflicting destination: ' + destination);
    }
    const [oldBytes, newBytes] = await Promise.all([fs.readFile(source), fs.readFile(destination)]);
    if (!oldBytes.equals(newBytes)) {
      throw new Error(
        'Legacy bridge migration stopped rather than overwrite different data at ' + destination +
        '. Resolve the conflict manually, then restart the bridge.',
      );
    }
    await fs.unlink(source);
    return;
  }
  // Build and verify a complete temporary file, then publish it with a
  // same-directory hard link. link() is atomic and fails rather than replacing
  // a destination created by another process. A crash can leave only an
  // unreferenced temporary file; the legacy source remains available to retry.
  const sourceBytes = await fs.readFile(source);
  const temporary = destination + '.dc-migrate-' + randomUUID().replaceAll('-', '') + '.tmp';
  let tempCreated = false;
  try {
    const handle = await fs.open(temporary, 'wx', sourceStat.mode & 0o777);
    tempCreated = true;
    try {
      await handle.writeFile(sourceBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const temporaryBytes = await fs.readFile(temporary);
    if (!temporaryBytes.equals(sourceBytes)) {
      throw new Error('Legacy bridge migration could not verify temporary data for ' + destination + '; the source was preserved.');
    }
    try {
      await fs.link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existingStat = await fs.lstat(destination);
      if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
        throw new Error('Legacy bridge migration found a conflicting destination: ' + destination);
      }
      const destinationBytes = await fs.readFile(destination);
      if (!destinationBytes.equals(sourceBytes)) {
        throw new Error(
          'Legacy bridge migration stopped rather than overwrite different data at ' + destination +
          '. Resolve the conflict manually, then restart the bridge.',
        );
      }
    }
    await fs.unlink(temporary);
    tempCreated = false;
    const destinationBytes = await fs.readFile(destination);
    if (!destinationBytes.equals(sourceBytes)) {
      throw new Error('Legacy bridge migration could not verify published data at ' + destination + '; the source was preserved.');
    }
    await fs.unlink(source);
  } finally {
    if (tempCreated) {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}

async function readFlatMigrationMarker(bridgeRoot: string): Promise<string | undefined> {
  const markerPath = path.join(bridgeRoot, LEGACY_FLAT_MIGRATION_MARKER);
  if (!await pathExists(markerPath)) return undefined;
  const stat = await fs.lstat(markerPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Legacy flat-queue migration marker must be a regular file: ' + markerPath);
  }
  let marker: unknown;
  try {
    marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  } catch (error) {
    throw new Error('Legacy flat-queue migration marker is invalid; the original data was preserved: ' + String(error));
  }
  if (!marker || typeof marker !== 'object'
    || (marker as Record<string, unknown>).version !== 1
    || typeof (marker as Record<string, unknown>).agentId !== 'string') {
    throw new Error('Legacy flat-queue migration marker has an unsupported format: ' + markerPath);
  }
  const agentId = (marker as { agentId: string }).agentId;
  if (agentId !== LEGACY_DEFAULT_AGENT && !GENERATED_LEGACY_FLAT_AGENT_PATTERN.test(agentId)) {
    throw new Error('Legacy flat-queue migration marker contains an invalid destination: ' + markerPath);
  }
  return agentId;
}

async function writeFlatMigrationMarker(bridgeRoot: string, agentId: string): Promise<void> {
  const markerPath = path.join(bridgeRoot, LEGACY_FLAT_MIGRATION_MARKER);
  const bytes = Buffer.from(JSON.stringify({ version: 1, agentId }) + '\n', 'utf8');
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(markerPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readFlatMigrationMarker(bridgeRoot);
    if (existing !== agentId) {
      throw new Error('A different legacy flat-queue migration is already recorded; no data was overwritten.');
    }
  } finally {
    await handle?.close();
  }
}

async function resolveFlatMigrationAgent(
  bridgeRoot: string,
  previousAgentNames: Set<string>,
  preferredAgentId?: string,
): Promise<string> {
  const recordedAgentId = await readFlatMigrationMarker(bridgeRoot);
  if (recordedAgentId) {
    if (preferredAgentId && preferredAgentId !== recordedAgentId) {
      throw new Error('Local and GitHub legacy flat-queue migration destinations disagree; migration was stopped safely.');
    }
    return recordedAgentId;
  }

  if (preferredAgentId) {
    if (preferredAgentId !== LEGACY_DEFAULT_AGENT && !GENERATED_LEGACY_FLAT_AGENT_PATTERN.test(preferredAgentId)) {
      throw new Error('The supplied legacy flat-queue destination is invalid: ' + preferredAgentId);
    }
    await writeFlatMigrationMarker(bridgeRoot, preferredAgentId);
    return preferredAgentId;
  }

  // An existing agent-default folder or an old agents/default conversation
  // already owns that identity. Never merge flat legacy data into it.
  const defaultDestinationOccupied = await pathExists(path.join(bridgeRoot, LEGACY_DEFAULT_AGENT))
    || previousAgentNames.has('default');
  let agentId = LEGACY_DEFAULT_AGENT;
  if (defaultDestinationOccupied) {
    do {
      agentId = 'agent-legacy-flat-' + randomUUID().replaceAll('-', '');
    } while (
      await pathExists(path.join(bridgeRoot, agentId))
      || previousAgentNames.has(agentId.slice('agent-'.length))
    );
  }
  await writeFlatMigrationMarker(bridgeRoot, agentId);
  return agentId;
}

export async function initializeAgentLayout(
  bridgeRoot: string,
  stateDirectory: string,
  preferredLegacyFlatAgentId?: string,
): Promise<string> {
  const rootStat = await fs.lstat(bridgeRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('The bridge root must be a real directory: ' + bridgeRoot);
  }

  // Capture old agent identities before flat data moves. An old
  // agents/default folder is a conversation, not the flat-queue bucket.
  const previousAgentsRoot = path.join(bridgeRoot, 'agents');
  const previousAgentNames = new Set<string>();
  if (await pathExists(previousAgentsRoot)) {
    const previousStat = await fs.lstat(previousAgentsRoot);
    if (!previousStat.isDirectory() || previousStat.isSymbolicLink()) {
      throw new Error('The previous bridge agents namespace must be a real directory: ' + previousAgentsRoot);
    }
    for (const entry of await fs.readdir(previousAgentsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()
        && LEGACY_AGENT_DIRECTORY_PATTERN.test(entry.name)) {
        previousAgentNames.add(entry.name);
      }
    }
  }

  const legacyLedgers = path.join(stateDirectory, 'requests');
  let ledgerEntries: import('node:fs').Dirent[] = [];
  if (await pathExists(legacyLedgers)) {
    const legacyLedgerStat = await fs.lstat(legacyLedgers);
    if (!legacyLedgerStat.isDirectory() || legacyLedgerStat.isSymbolicLink()) {
      throw new Error('Legacy bridge request ledgers must be stored in a real directory: ' + legacyLedgers);
    }
    ledgerEntries = await fs.readdir(legacyLedgers, { withFileTypes: true });
  }

  const flatQueueDirs = await Promise.all(
    ['requests', 'artifacts', 'responses'].map(name => pathExists(path.join(bridgeRoot, name))),
  );
  const hasFlatLedgerFiles = ledgerEntries.some(entry => entry.isFile() && !entry.isSymbolicLink());
  const hasUnscopedDefaultLedger = ledgerEntries.some(entry =>
    entry.isDirectory() && !entry.isSymbolicLink() && entry.name === 'default'
      && !previousAgentNames.has('default'));
  const hasFlatLegacyData = flatQueueDirs.some(Boolean) || hasFlatLedgerFiles || hasUnscopedDefaultLedger;
  let flatAgentId = await readFlatMigrationMarker(bridgeRoot);
  if (hasFlatLegacyData) {
    flatAgentId = await resolveFlatMigrationAgent(bridgeRoot, previousAgentNames, preferredLegacyFlatAgentId);
  } else if (preferredLegacyFlatAgentId && flatAgentId && preferredLegacyFlatAgentId !== flatAgentId) {
    throw new Error('Local and GitHub legacy flat-queue migration destinations disagree.');
  }

  // Keep one stable compatibility destination while a flat migration runs.
  // Requests move first, artifacts next, and responses last.
  if (flatAgentId) {
    for (const queueName of ['requests', 'artifacts', 'responses']) {
      const legacyPath = path.join(bridgeRoot, queueName);
      if (!await pathExists(legacyPath)) continue;
      const destination = path.join(bridgeRoot, flatAgentId, queueName);
      await moveTreeWithoutOverwrite(legacyPath, destination, bridgeRoot);
    }
  }

  // Migrate per-conversation ledgers before their old queue folders.
  if (ledgerEntries.length) {
    const migratedLegacyAgentLedgers = new Set<string>();
    for (const entry of ledgerEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !previousAgentNames.has(entry.name)) continue;
      const source = path.join(legacyLedgers, entry.name);
      if (!await pathExists(source)) continue;
      await moveTreeWithoutOverwrite(
        source,
        path.join(legacyLedgers, 'agent-' + entry.name),
        stateDirectory,
      );
      migratedLegacyAgentLedgers.add(entry.name);
    }

    const ensureFlatLedgers = async (): Promise<string> => {
      if (!flatAgentId) throw new Error('Legacy flat request ledgers have no migration destination.');
      const destination = path.join(legacyLedgers, flatAgentId);
      await ensureSafeDestinationParent(stateDirectory, path.join(destination, '.migration-check'));
      await fs.mkdir(destination, { recursive: true });
      const destinationStat = await fs.lstat(destination);
      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
        throw new Error('The flat legacy agent ledger path must be a real directory: ' + destination);
      }
      return destination;
    };

    for (const entry of ledgerEntries) {
      if (migratedLegacyAgentLedgers.has(entry.name)) continue;
      if (entry.name === 'default' && previousAgentNames.has('default')) continue;
      const source = path.join(legacyLedgers, entry.name);
      if (!await pathExists(source)) continue;
      if (entry.isFile()) {
        await moveTreeWithoutOverwrite(
          source,
          path.join(await ensureFlatLedgers(), entry.name),
          stateDirectory,
        );
        continue;
      }
      if (entry.name === 'default' && entry.isDirectory() && !entry.isSymbolicLink()) {
        await moveTreeWithoutOverwrite(source, await ensureFlatLedgers(), stateDirectory);
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()
        && LEGACY_AGENT_DIRECTORY_PATTERN.test(entry.name)
        && !entry.name.startsWith('agent-')) {
        await moveTreeWithoutOverwrite(
          source,
          path.join(legacyLedgers, 'agent-' + entry.name),
          stateDirectory,
        );
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()
        && AGENT_DIRECTORY_PATTERN.test(entry.name)) continue;
      console.warn(
        'Preserved unrecognized legacy request-ledger content rather than changing its identity: ' + source,
      );
    }
  }

  // Migrate old nested queues after their corresponding ledgers.
  if (await pathExists(previousAgentsRoot)) {
    for (const entry of await fs.readdir(previousAgentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || !LEGACY_AGENT_DIRECTORY_PATTERN.test(entry.name)) continue;
      const destination = path.join(bridgeRoot, 'agent-' + entry.name);
      await moveTreeWithoutOverwrite(path.join(previousAgentsRoot, entry.name), destination, bridgeRoot);
    }
    const legacySentinel = path.join(previousAgentsRoot, '.gitkeep');
    if (await pathExists(legacySentinel)) {
      const sentinelStat = await fs.lstat(legacySentinel);
      if (sentinelStat.isFile() && !sentinelStat.isSymbolicLink()) {
        const sentinelBytes = await fs.readFile(legacySentinel);
        if (sentinelBytes.equals(Buffer.from('Desktop Commander agent-scoped queues.\n', 'utf8'))) {
          await fs.unlink(legacySentinel);
        }
      }
    }
    const remainingEntries = await fs.readdir(previousAgentsRoot);
    if (remainingEntries.length === 0) {
      await fs.rmdir(previousAgentsRoot);
    } else {
      console.warn(
        'Preserved unrecognized content in the previous agents/ directory rather than deleting user data: ' +
        previousAgentsRoot,
      );
    }
  }

  // Retain the marker while any flat source remains. It makes an interrupted
  // migration restart at the same destination rather than inventing a new one.
  if (flatAgentId) {
    const flatQueuesRemain = await Promise.all(
      ['requests', 'artifacts', 'responses'].map(name => pathExists(path.join(bridgeRoot, name))),
    ).then(values => values.some(Boolean));
    let flatLedgersRemain = false;
    if (await pathExists(legacyLedgers)) {
      const remaining = await fs.readdir(legacyLedgers, { withFileTypes: true });
      flatLedgersRemain = remaining.some(entry =>
        (entry.isFile() && !entry.isSymbolicLink())
        || (entry.name === 'default' && entry.isDirectory() && !entry.isSymbolicLink()
          && !previousAgentNames.has('default')));
    }
    if (!flatQueuesRemain && !flatLedgersRemain) {
      await fs.unlink(path.join(bridgeRoot, LEGACY_FLAT_MIGRATION_MARKER)).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }
  return bridgeRoot;
}

export async function discoverAgentQueuePaths(
  bridgeRoot: string,
  stateDirectory: string,
): Promise<AgentQueuePaths[]> {
  const entries = await fs.readdir(bridgeRoot, { withFileTypes: true });
  const result: AgentQueuePaths[] = [];
  for (const entry of entries) {
    if (!isValidAgentDirectoryName(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error('Agent folder must not be a symbolic link: ' + path.join(bridgeRoot, entry.name));
    }
    if (!entry.isDirectory()) continue;
    const root = path.join(bridgeRoot, entry.name);
    const requests = path.join(root, 'requests');
    const responses = path.join(root, 'responses');
    const artifacts = path.join(root, 'artifacts');
    for (const directory of [requests, responses, artifacts]) {
      await fs.mkdir(directory, { recursive: true });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Agent queue directory must be a real directory: ' + directory);
      }
    }
    const ledgers = path.join(stateDirectory, 'requests', entry.name);
    await fs.mkdir(ledgers, { recursive: true });
    result.push({ agentId: entry.name, root, requests, responses, artifacts, ledgers });
  }
  return result.sort((left, right) => left.agentId.localeCompare(right.agentId));
}
