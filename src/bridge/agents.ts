import fs from 'node:fs/promises';
import path from 'node:path';

export const LEGACY_AGENT_DIRECTORY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const AGENT_DIRECTORY_PATTERN = /^agent-[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const LEGACY_DEFAULT_AGENT = 'agent-default';

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

async function moveTreeWithoutOverwrite(source: string, destination: string): Promise<void> {
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
      await moveTreeWithoutOverwrite(path.join(source, entry), path.join(destination, entry));
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
  await fs.rename(source, destination);
}

export async function initializeAgentLayout(bridgeRoot: string, stateDirectory: string): Promise<string> {
  const rootStat = await fs.lstat(bridgeRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('The bridge root must be a real directory: ' + bridgeRoot);
  }

  // Move existing flat queues into one explicit default-agent namespace. This
  // preserves pending work and completed results without exposing flat queues.
  // Requests move first, then their artifacts, and responses last because a
  // response file is the durable completion marker consumed by the agent.
  for (const queueName of ['requests', 'artifacts', 'responses']) {
    const legacyPath = path.join(bridgeRoot, queueName);
    if (!await pathExists(legacyPath)) continue;
    const destination = path.join(bridgeRoot, LEGACY_DEFAULT_AGENT, queueName);
    await moveTreeWithoutOverwrite(legacyPath, destination);
  }

  // Migrate the previous agents/<name>/ layout into root-level agent-<name>/ folders.
  // Capture the old names before moving them so the matching durable request
  // ledgers can be moved into the same new conversation folder.
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

  // Durable idempotency ledgers use the same folder identity as queue data.
  // Older releases stored per-agent ledgers at requests/<old-agent-name>/,
  // while flat legacy queues stored their ledgers directly under requests/.
  const legacyLedgers = path.join(stateDirectory, 'requests');
  if (await pathExists(legacyLedgers)) {
    const legacyLedgerStat = await fs.lstat(legacyLedgers);
    if (!legacyLedgerStat.isDirectory() || legacyLedgerStat.isSymbolicLink()) {
      throw new Error('Legacy bridge request ledgers must be stored in a real directory: ' + legacyLedgers);
    }
    const ledgerEntries = await fs.readdir(legacyLedgers, { withFileTypes: true });
    const migratedLegacyAgentLedgers = new Set<string>();

    // Move ledgers for known nested agents before moving their queue folders.
    // If startup is interrupted, the old queue folder remains available to
    // identify its ledger on the next start.
    for (const entry of ledgerEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !previousAgentNames.has(entry.name)) continue;
      const source = path.join(legacyLedgers, entry.name);
      if (!await pathExists(source)) continue;
      await moveTreeWithoutOverwrite(source, path.join(legacyLedgers, 'agent-' + entry.name));
      migratedLegacyAgentLedgers.add(entry.name);
    }

    const defaultLedgers = path.join(legacyLedgers, LEGACY_DEFAULT_AGENT);
    const ensureDefaultLedgers = async (): Promise<void> => {
      await fs.mkdir(defaultLedgers, { recursive: true });
      const defaultLedgerStat = await fs.lstat(defaultLedgers);
      if (!defaultLedgerStat.isDirectory() || defaultLedgerStat.isSymbolicLink()) {
        throw new Error('The default agent ledger path must be a real directory: ' + defaultLedgers);
      }
    };

    for (const entry of ledgerEntries) {
      if (migratedLegacyAgentLedgers.has(entry.name) || entry.name === LEGACY_DEFAULT_AGENT) continue;
      const source = path.join(legacyLedgers, entry.name);
      if (!await pathExists(source)) continue;
      if (entry.isFile()) {
        await ensureDefaultLedgers();
        await moveTreeWithoutOverwrite(source, path.join(defaultLedgers, entry.name));
        continue;
      }
      if (entry.name === 'default' && entry.isDirectory() && !entry.isSymbolicLink()) {
        await ensureDefaultLedgers();
        await moveTreeWithoutOverwrite(source, defaultLedgers);
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()
        && LEGACY_AGENT_DIRECTORY_PATTERN.test(entry.name)
        && !entry.name.startsWith('agent-')) {
        await moveTreeWithoutOverwrite(source, path.join(legacyLedgers, 'agent-' + entry.name));
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()
        && AGENT_DIRECTORY_PATTERN.test(entry.name)) continue;
      console.warn(
        'Preserved unrecognized legacy request-ledger content rather than changing its identity: ' + source,
      );
    }
  }

  // Migrate old queue folders only after their corresponding durable ledgers
  // have moved. A restart can then safely resume any partially-completed move.
  if (await pathExists(previousAgentsRoot)) {
    for (const entry of await fs.readdir(previousAgentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || !LEGACY_AGENT_DIRECTORY_PATTERN.test(entry.name)) continue;
      const destination = path.join(bridgeRoot, 'agent-' + entry.name);
      await moveTreeWithoutOverwrite(path.join(previousAgentsRoot, entry.name), destination);
    }
    // The old GitHub layout used this exact generated sentinel to keep
    // agents/ tracked. Remove only that known file; preserve unknown content.
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
