import { existsSync, chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import os from 'os';
import { resolveShellPath } from './shell.js';

let cachedRgPath: string | null = null;

/**
 * pkg stores packaged files in a read-only snapshot. ripgrep is an external
 * process, so Windows cannot spawn it from that virtual path. Materialize the
 * binary once into the per-user app-data cache, then reuse the real file.
 */
function materializePackagedBinary(sourcePath: string): string {
  const packaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg)
    || /(?:^|[\\/])snapshot[\\/]/i.test(sourcePath);
  if (!packaged) return sourcePath;

  const appData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const cacheDirectory = path.join(appData, 'DesktopCommanderBridge', 'runtime');
  const destination = path.join(cacheDirectory, process.platform === 'win32' ? 'rg.exe' : 'rg');
  const hashPath = destination + '.sha256';
  mkdirSync(cacheDirectory, { recursive: true });

  const sourceHash = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
  const cachedHash = existsSync(hashPath) ? readFileSync(hashPath, 'utf8').trim() : '';
  if (!existsSync(destination) || cachedHash !== sourceHash) {
    const temporary = destination + '.' + process.pid + '.tmp';
    copyFileSync(sourcePath, temporary);
    try {
      if (existsSync(destination)) unlinkSync(destination);
      renameSync(temporary, destination);
      writeFileSync(hashPath, sourceHash, 'utf8');
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  if (process.platform !== 'win32') {
    try { chmodSync(destination, 0o755); } catch {}
  }
  return destination;
}

/**
 * Resolve ripgrep binary path with multiple fallback strategies
 * This handles cases where @vscode/ripgrep postinstall fails in npx environments
 */
export async function getRipgrepPath(): Promise<string> {
  if (cachedRgPath) {
    return cachedRgPath;
  }

  // Strategy 1: Try @vscode/ripgrep package
  try {
    const { rgPath } = await import('@vscode/ripgrep');
    if (existsSync(rgPath)) {
      // Ensure executable permissions on Unix systems
      if (process.platform !== 'win32') {
        try {
          chmodSync(rgPath, 0o755);
        } catch (e) {
          // Ignore chmod errors - might not have write access
        }
      }
      cachedRgPath = materializePackagedBinary(rgPath);
      return cachedRgPath;
    }
  } catch (e) {
    // @vscode/ripgrep import or binary resolution failed, continue to fallbacks
  }

  // Strategy 2: system ripgrep on PATH (never the working folder, which
  // 'where' searched first on Windows)
  const systemRg = resolveShellPath(process.platform === 'win32' ? 'rg.exe' : 'rg');
  if (systemRg) {
    cachedRgPath = systemRg;
    return systemRg;
  }

  // Strategy 3: Try common installation paths
  const commonPaths: string[] = [];

  if (process.platform === 'win32') {
    // Windows' own Program Files folders, which aren't always on C:
    commonPaths.push(
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Ripgrep', 'rg.exe'),
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Ripgrep', 'rg.exe'),
      path.join(os.homedir(), 'scoop', 'apps', 'ripgrep', 'current', 'rg.exe'),
      path.join(os.homedir(), '.cargo', 'bin', 'rg.exe')
    );
  } else {
    commonPaths.push(
      '/usr/local/bin/rg',
      '/usr/bin/rg',
      path.join(os.homedir(), '.cargo', 'bin', 'rg'),
      '/opt/homebrew/bin/rg' // Apple Silicon Homebrew
    );
  }

  for (const possiblePath of commonPaths) {
    if (existsSync(possiblePath)) {
      cachedRgPath = possiblePath;
      return possiblePath;
    }
  }

  // No ripgrep found - provide helpful error message
  throw new Error(
    'ripgrep binary not found. Desktop Commander requires ripgrep to perform searches. ' +
    'Please install ripgrep:\n' +
    '  macOS: brew install ripgrep\n' +
    '  Linux: See https://github.com/BurntSushi/ripgrep#installation\n' +
    '  Windows: choco install ripgrep or download from https://github.com/BurntSushi/ripgrep/releases'
  );
}

/**
 * Clear the cached ripgrep path (useful for testing)
 */
export function clearRipgrepCache(): void {
  cachedRgPath = null;
}
