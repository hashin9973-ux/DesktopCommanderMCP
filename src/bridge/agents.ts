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
  const agentsRoot = bridgeRoot;
  const rootStat = await fs.lstat(agentsRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('The bridge root must be a real directory: ' + agentsRoot);
  }

  // Move existing flat queues into one explicit default-agent namespace. This
  // preserves pending work and completed results without exposing flat queues.
  // Requests move first, then their artifacts, and responses last because a
  // response file is the durable completion marker consumed by the agent.
  for (const queueName of ['requests', 'artifacts', 'responses']) {
    const legacyPath = path.join(bridgeRoot, queueName);
    if (!await pathExists(legacyPath)) continue;
    const destination = path.join(agentsRoot, LEGACY_DEFAULT_AGENT, queueName);
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
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || !LEGACY_AGENT_DIRECTORY_PATTERN.test(entry.name)) continue;
      previousAgentNames.add(entry.name);
      const destination = path.join(bridgeRoot, 'agent-' + entry.name);
      await moveTreeWithoutOverwrite(path.join(previousAgentsRoot, entry.name), destination);
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
    for (const entry of await fs.readdir(legacyLedgers, { withFileTypes: true })) {
      if (entry.name === LEGACY_DEFAULT_AGENT) continue;
      const source = path.join(legacyLedgers, entry.name);
      if (entry.isFile()) {
        await moveTreeWithoutOverwrite(source, path.join(legacyLedgers, LEGACY_DEFAULT_AGENT, entry.name));
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()
        && entry.name !== 'default'
        && !entry.name.startsWith('agent-')
        && LEGACY_AGENT_DIRECTORY_PATTERN.test(entry.name)) {
        const destinationAgent = 'agent-' + entry.name;
        await moveTreeWithoutOverwrite(source, path.join(legacyLedgers, destinationAgent));
        continue;
      }
      if (entry.name === 'default' && entry.isDirectory() && !entry.isSymbolicLink()) {
        await moveTreeWithoutOverwrite(source, path.join(legacyLedgers, LEGACY_DEFAULT_AGENT));
        continue;
      }
      if (entry.isDirectory() && previousAgentNames.has(entry.name)) {
        await moveTreeWithoutOverwrite(source, path.join(legacyLedgers, 'agent-' + entry.name));
        continue;
      }
      console.warn(
        'Preserved unrecognized legacy request-ledger content rather than changing its identity: ' + source,
      );
    }
  }

  if (await pathExists(previousAgentsRoot)) {
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
  return agentsRoot;
}

export async function discoverAgentQueuePaths(
  agentsRoot: string,
  stateDirectory: string,
): Promise<AgentQueuePaths[]> {
  const entries = await fs.readdir(agentsRoot, { withFileTypes: true });
  const result: AgentQueuePaths[] = [];
  for (const entry of entries) {
    if (!isValidAgentDirectoryName(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error('Agent folder must not be a symbolic link: ' + path.join(agentsRoot, entry.name));
    }
    if (!entry.isDirectory()) continue;
    const root = path.join(agentsRoot, entry.name);
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
