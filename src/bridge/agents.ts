import fs from 'node:fs/promises';
import path from 'node:path';

export const AGENT_DIRECTORY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const LEGACY_DEFAULT_AGENT = 'default';

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
  const agentsRoot = path.join(bridgeRoot, 'agents');
  await fs.mkdir(agentsRoot, { recursive: true });
  const agentsStat = await fs.lstat(agentsRoot);
  if (!agentsStat.isDirectory() || agentsStat.isSymbolicLink()) {
    throw new Error('The bridge agents path must be a real directory: ' + agentsRoot);
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

  const legacyLedgers = path.join(stateDirectory, 'requests');
  if (await pathExists(legacyLedgers)) {
    const legacyLedgerStat = await fs.lstat(legacyLedgers);
    if (!legacyLedgerStat.isDirectory() || legacyLedgerStat.isSymbolicLink()) {
      throw new Error('Legacy bridge request ledgers must be stored in a real directory: ' + legacyLedgers);
    }
    const defaultLedgers = path.join(legacyLedgers, LEGACY_DEFAULT_AGENT);
    if (!await pathExists(defaultLedgers)) await fs.mkdir(defaultLedgers, { recursive: true });
    const defaultLedgerStat = await fs.lstat(defaultLedgers);
    if (!defaultLedgerStat.isDirectory() || defaultLedgerStat.isSymbolicLink()) {
      throw new Error('The default agent ledger path must be a real directory: ' + defaultLedgers);
    }
    for (const entry of await fs.readdir(legacyLedgers, { withFileTypes: true })) {
      if (entry.name === LEGACY_DEFAULT_AGENT) continue;
      await moveTreeWithoutOverwrite(path.join(legacyLedgers, entry.name), path.join(defaultLedgers, entry.name));
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
