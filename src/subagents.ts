import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import lockfile from 'proper-lockfile';
import { writeFileAtomic } from './utils/atomic-write.js';

const execFileAsync = promisify(execFile);
const CHATGPT_URL = 'https://chatgpt.com/';
const SUBAGENT_FOLDER = 'subagents';
const AGENT_ID_PATTERN = /^agent-[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const GENERATION_TIMEOUT_MS = 30 * 60 * 1000;

export interface SubagentParentContext {
  agentId: string;
  workspacePath: string;
  transport: 'github' | 'cloud';
}
const parentContext = new AsyncLocalStorage<SubagentParentContext>();

export function runWithSubagentParentContext<T>(
  context: SubagentParentContext,
  operation: () => Promise<T>,
): Promise<T> {
  return parentContext.run(context, operation);
}

export function getSubagentParentContext(): SubagentParentContext | undefined {
  return parentContext.getStore();
}

export interface SubagentToolArguments {
  action: 'spawn' | 'continue' | 'status' | 'delete';
  prompt?: string;
  subagent_id?: string;
  parent_agent_id?: string;
  parent_workspace_path?: string;
}

interface SubagentRecord {
  id: string;
  parentAgentId: string;
  parentAgentPath: string;
  agentPath: string;
  parentWorkspacePath: string;
  workspacePath: string;
  transport: 'github' | 'cloud' | 'mcp';
  targetId: string;
  conversationUrl: string;
  createdAt: string;
  updatedAt: string;
  lastSubmittedAt: string;
  deleted?: boolean;
}
interface SubagentState { version: 1; records: SubagentRecord[]; }
interface BrowserTarget { targetId: string; sessionId: string; }
interface BrowserInfo { executable: string; appPath?: string; }

/**
 * Headless is the default. Set DC_SUBAGENT_HEADLESS=0 only when the dedicated
 * profile needs a one-time interactive sign-in or UI troubleshooting.
 */
export function shouldUseHeadlessBrowser(value = process.env.DC_SUBAGENT_HEADLESS): boolean {
  return !['0', 'false', 'no', 'off'].includes(value?.trim().toLowerCase() || '');
}

export function buildBrowserLaunchArgs(profilePath: string, headless = shouldUseHeadlessBrowser()): string[] {
  return [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profilePath,
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-automation',
    ...(headless ? ['--headless'] : []),
    CHATGPT_URL,
  ];
}

function stateDirectory(): string {
  // This stable per-user location is deliberately independent of XDG_STATE_HOME
  // and LOCALAPPDATA overrides used by the isolated GitHub worker process.
  // All three transports therefore share one CDP browser profile and registry.
  return process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Local', 'DesktopCommander', 'subagents')
    : path.join(os.homedir(), '.local', 'state', 'desktop-commander', 'subagents');
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function leafAgentId(id: string): string {
  const segments = id.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : id;
}
function validateAgentId(id: string): string {
  if (!AGENT_ID_PATTERN.test(id)) {
    throw new Error('Agent IDs must use agent- followed by a lowercase letter or digit, with optional lowercase letters, digits, dots, underscores, or hyphens.');
  }
  return id;
}
async function exists(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function realDirectory(target: string, label: string): Promise<string> {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(label + ' must be a real directory.');
  return fs.realpath(target);
}
async function readState(filePath: string): Promise<SubagentState> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as SubagentState;
    if (value.version !== 1 || !Array.isArray(value.records)) throw new Error('Unsupported registry format.');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
    throw new Error('Could not read subagent registry: ' + errorMessage(error));
  }
}
async function saveState(filePath: string, state: SubagentState): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
function firstCommand(commandLine: string): string | undefined {
  const match = /^"([^"]+)"|^'([^']+)'|^(\S+)/.exec(commandLine.trim());
  return match?.[1] || match?.[2] || match?.[3];
}

async function resolveBrowserExecutable(): Promise<BrowserInfo> {
  const override = process.env.DC_SUBAGENT_BROWSER_PATH;
  if (override?.trim()) {
    const executable = path.resolve(override.trim());
    await fs.access(executable);
    return { executable };
  }

  if (process.platform === 'win32') {
    const choice = await execFileAsync('reg.exe', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
      '/v',
      'ProgId',
    ], { timeout: 5000, windowsHide: true, maxBuffer: 65536 });
    const progId = /\bProgId\s+REG_SZ\s+([^\r\n]+)/i.exec(choice.stdout)?.[1]?.trim();
    if (!progId) throw new Error('Could not read the Windows default HTTPS browser association.');
    const command = await execFileAsync('reg.exe', [
      'query', 'HKCR\\' + progId + '\\shell\\open\\command', '/ve',
    ], { timeout: 5000, windowsHide: true, maxBuffer: 65536 });
    const line = command.stdout.split(/\r?\n/).find(value => /\.exe/i.test(value));
    const executable = line ? firstCommand(line.replace(/^.*REG_[A-Z_]+\s+/i, '')) : undefined;
    if (!executable) throw new Error('Could not resolve the Windows default browser executable.');
    if (!/(chrome|msedge|edge|brave|chromium)/i.test(path.basename(executable))) {
      throw new Error('The system-default browser is not Chromium-based. Use Chrome, Edge, Brave, or Chromium, or set DC_SUBAGENT_BROWSER_PATH.');
    }
    return { executable };
  }

  if (process.platform === 'darwin') {
    const result = await execFileAsync('osascript', [
      '-e', 'POSIX path of (path to default application for "https")',
    ], { timeout: 5000, maxBuffer: 65536 });
    const appPath = result.stdout.trim().replace(/\/$/, '');
    if (!appPath.endsWith('.app')) throw new Error('Could not resolve the macOS default browser application.');
    const info = await fs.readFile(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    const name = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(info)?.[1];
    if (!name || !/(chrome|msedge|edge|brave|chromium)/i.test(name + appPath)) {
      throw new Error('The system-default browser is not Chromium-based. Use Chrome, Edge, Brave, or Chromium, or set DC_SUBAGENT_BROWSER_PATH.');
    }
    return { executable: path.join(appPath, 'Contents', 'MacOS', name), appPath };
  }

  if (process.platform === 'linux') {
    const result = await execFileAsync('xdg-settings', ['get', 'default-web-browser'], {
      timeout: 5000, maxBuffer: 65536,
    });
    const desktopId = result.stdout.trim();
    if (!desktopId || desktopId.includes('/') || desktopId.includes('..')) {
      throw new Error('Could not resolve the Linux default browser desktop entry.');
    }
    const locations = [
      path.join(os.homedir(), '.local', 'share', 'applications', desktopId),
      path.join('/usr/local/share/applications', desktopId),
      path.join('/usr/share/applications', desktopId),
    ];
    let desktop: string | undefined;
    for (const candidate of locations) {
      try { desktop = await fs.readFile(candidate, 'utf8'); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const execLine = desktop && /^\s*Exec=(.+)$/m.exec(desktop)?.[1];
    let executable = execLine ? firstCommand(execLine) : undefined;
    if (executable === 'env' && execLine) {
      const tokens = execLine.split(/\s+/).filter(value =>
        value !== 'env' && !value.startsWith('%') && !/^[A-Z_][A-Z0-9_]*=/.test(value));
      executable = tokens[0];
    }
    if (!executable) throw new Error('Could not resolve the Linux default browser executable.');
    if (!path.isAbsolute(executable)) {
      const resolved = await execFileAsync('which', [executable], { timeout: 5000, maxBuffer: 65536 });
      executable = resolved.stdout.trim().split(/\r?\n/)[0];
    }
    if (!/(chrome|msedge|edge|brave|chromium)/i.test(path.basename(executable))) {
      throw new Error('The system-default browser is not Chromium-based. Use Chrome, Edge, Brave, or Chromium, or set DC_SUBAGENT_BROWSER_PATH.');
    }
    return { executable };
  }
  throw new Error('Automatic ChatGPT browser control is not supported on this operating system.');
}

class DevToolsConnection {
  private socket?: WebSocket;
  private nextId = 0;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  constructor(private readonly url: string) {}
  isOpen(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url, { handshakeTimeout: 10000 });
      this.socket = socket;
      socket.once('open', resolve);
      socket.once('error', error => {
        socket.close();
        reject(error);
      });
      socket.on('message', raw => {
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try { message = JSON.parse(raw.toString()) as typeof message; } catch { return; }
        if (typeof message.id !== 'number') return;
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message || 'Browser DevTools command failed.'));
        else waiter.resolve(message.result);
      });
      socket.once('close', () => {
        for (const waiter of this.pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('The controlled browser connection closed.'));
        }
        this.pending.clear();
      });
    });
  }
  async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('The controlled browser is disconnected.');
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Browser command timed out: ' + method));
      }, 10000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('The controlled browser connection was closed.'));
    }
    this.pending.clear();
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
  }
}

class ChatGptBrowser {
  private connection?: DevToolsConnection;
  private readonly profilePath: string;
  private readonly portFile: string;
  constructor(root: string) {
    this.profilePath = path.join(root, 'browser-profile');
    this.portFile = path.join(this.profilePath, 'DevToolsActivePort');
  }

  private async connectActive(): Promise<DevToolsConnection | undefined> {
    let connection: DevToolsConnection | undefined;
    try {
      const lines = (await fs.readFile(this.portFile, 'utf8')).trim().split(/\r?\n/);
      const port = Number(lines[0]);
      const endpoint = lines[1];
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !endpoint?.startsWith('/devtools/browser/')) return undefined;
      connection = new DevToolsConnection('ws://127.0.0.1:' + port + endpoint);
      await connection.connect();
      this.connection = connection;
      return connection;
    } catch {
      connection?.close();
      return undefined;
    }
  }

  private async isConfiguredMode(connection: DevToolsConnection): Promise<boolean> {
    try {
      // Chromium exposes this CDP command only when --enable-automation is set.
      // Checking the real browser arguments prevents silently reusing an older
      // visible Chromium process after headless mode becomes the default.
      const result = await connection.send<{ arguments?: string[] }>('Browser.getBrowserCommandLine');
      if (!Array.isArray(result.arguments)) return false;
      const actualHeadless = result.arguments.some(argument => /^--headless(?:=|$)/i.test(argument));
      return actualHeadless === shouldUseHeadlessBrowser();
    } catch {
      return false;
    }
  }

  private async stopBrowser(connection: DevToolsConnection): Promise<void> {
    // This profile is dedicated to subagents, never the user's regular browser
    // profile. Restart it only when its launch mode differs from configuration.
    await connection.send('Browser.close').catch(() => undefined);
    connection.close();
    this.connection = undefined;

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const stillRunning = await this.connectActive();
      if (!stillRunning) break;
      stillRunning.close();
      this.connection = undefined;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const stillRunning = await this.connectActive();
    if (stillRunning) {
      stillRunning.close();
      this.connection = undefined;
      throw new Error('The existing dedicated Chromium process could not be stopped to apply the configured headless mode.');
    }
    await fs.rm(this.portFile, { force: true });
  }

  private async connect(): Promise<DevToolsConnection> {
    let active = this.connection?.isOpen() ? this.connection : await this.connectActive();
    if (active) {
      if (await this.isConfiguredMode(active)) return active;
      await this.stopBrowser(active);
    }

    this.connection = undefined;
    await fs.mkdir(this.profilePath, { recursive: true, mode: 0o700 });
    await fs.rm(this.portFile, { force: true });
    const browser = await resolveBrowserExecutable();
    const args = buildBrowserLaunchArgs(this.profilePath);
    const child = process.platform === 'darwin' && browser.appPath
      ? spawn('/usr/bin/open', ['-na', browser.appPath, '--args', ...args], {
        stdio: 'ignore', detached: true, windowsHide: true,
      })
      : spawn(browser.executable, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.once('error', error => {
      process.stderr.write('Could not launch the system-default browser: ' + error.message + '\n');
    });
    child.unref();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      active = await this.connectActive();
      if (active) {
        if (await this.isConfiguredMode(active)) return active;
        await this.stopBrowser(active);
        throw new Error('Chromium started, but its reported command-line switches did not confirm the configured headless mode.');
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('The default Chromium browser did not expose its local DevTools endpoint.');
  }

  async createChat(): Promise<BrowserTarget> {
    const connection = await this.connect();
    const created = await connection.send<{ targetId: string }>('Target.createTarget', { url: CHATGPT_URL });
    const attached = await connection.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: created.targetId, flatten: true,
    });
    const target = { targetId: created.targetId, sessionId: attached.sessionId };
    await connection.send('Runtime.enable', {}, target.sessionId);
    return target;
  }

  private async connectExisting(): Promise<DevToolsConnection | undefined> {
    const active = this.connection?.isOpen() ? this.connection : await this.connectActive();
    if (!active) return undefined;
    if (await this.isConfiguredMode(active)) return active;
    await this.stopBrowser(active);
    return undefined;
  }

  async attach(
    targetId: string,
    conversationUrl?: string,
    restoreIfMissing = false,
  ): Promise<BrowserTarget> {
    const connection = restoreIfMissing
      ? await this.connect()
      : await this.connectExisting();
    if (!connection) throw new Error('The shared ChatGPT browser session is not running.');
    let resolvedTargetId = targetId;
    try {
      await connection.send('Target.getTargetInfo', { targetId });
    } catch {
      const conversationId = conversationUrl
        ? /\/c\/([0-9a-f-]{16,})/i.exec(conversationUrl)?.[1]
        : undefined;
      if (!conversationId) {
        throw new Error('The saved ChatGPT conversation URL is missing a valid conversation ID.');
      }
      const targets = await connection.send<{ targetInfos?: Array<{ targetId?: string; url?: string; type?: string }> }>(
        'Target.getTargets',
      );
      const match = (targets.targetInfos || []).find(target =>
        target.type === 'page'
        && typeof target.targetId === 'string'
        && typeof target.url === 'string'
        && (target.url === conversationUrl || target.url.includes('/c/' + conversationId)),
      );
      if (match?.targetId) {
        resolvedTargetId = match.targetId;
      } else if (restoreIfMissing) {
        // ChatGPT conversations are server-side. Reopen the persisted URL in a
        // new tab when the user closed the original tab or restarted Chromium.
        const created = await connection.send<{ targetId: string }>(
          'Target.createTarget',
          { url: conversationUrl },
        );
        resolvedTargetId = created.targetId;
      } else {
        throw new Error('The saved ChatGPT conversation tab is closed; use continue to reopen it.');
      }
    }
    const attached = await connection.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: resolvedTargetId, flatten: true,
    });
    const target = { targetId: resolvedTargetId, sessionId: attached.sessionId };
    await connection.send('Runtime.enable', {}, target.sessionId);
    return target;
  }

  async evaluate<T>(target: BrowserTarget, expression: string): Promise<T> {
    const connection = await this.connect();
    const result = await connection.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string };
    }>('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    }, target.sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'ChatGPT page evaluation failed.');
    return result.result?.value as T;
  }

  async waitForComposer(target: BrowserTarget): Promise<boolean> {
    const expression = [
      '(() => {',
      'const selectors = [\'textarea#prompt-textarea\', \'textarea[data-testid="prompt-textarea"]\', \'[contenteditable="true"]\'];',
      'return selectors.some(selector => [...document.querySelectorAll(selector)].some(element => {',
      'const style = getComputedStyle(element);',
      'return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;',
      '}));',
      '})()',
    ].join('\n');
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const ready = await this.evaluate<boolean>(target, expression).catch(() => false);
      if (ready) return true;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  }

  async ensureThinkingMode(target: BrowserTarget): Promise<void> {
    const readMode = async (): Promise<{ modelText: string; thinkingActive: boolean }> =>
      this.evaluate<{ modelText: string; thinkingActive: boolean }>(target, [
        '(() => {',
        'const visible = e => { const s = getComputedStyle(e); return s.visibility !== "hidden" && s.display !== "none" && e.getClientRects().length > 0; };',
        'const buttons = [...document.querySelectorAll("button,[role=button]")].filter(visible);',
        'const picker = document.querySelector("[data-testid=\\"model-switcher-dropdown-button\\"]") || buttons.find(e => /model|instant|thinking|medium|high/i.test((e.getAttribute("aria-label") || "") + " " + (e.innerText || "")));',
        'const modeText = picker ? ((picker.innerText || "") + " " + (picker.getAttribute("aria-label") || "")) : "";',
        'const activeToggle = buttons.find(e => /^(think|thinking)$/i.test((e.getAttribute("aria-label") || e.innerText || "").trim()) && (e.getAttribute("aria-pressed") === "true" || e.getAttribute("data-state") === "on" || e.getAttribute("aria-selected") === "true"));',
        'const selectedOption = document.querySelector("[role=menuitemradio][aria-checked=true],[role=option][aria-selected=true],[role=radio][aria-checked=true]");',
        'const selectedText = selectedOption ? (selectedOption.innerText || "") : "";',
        'const reasoningMode = /\\b(thinking|medium|high|extra high|pro standard|pro extended)\\b/i.test(modeText + " " + selectedText);',
        'return { modelText: modeText, thinkingActive: !!activeToggle || reasoningMode };',
        '})()',
      ].join("\\n"));

    const initial = await readMode();
    if (initial.thinkingActive) return;

    // The web picker has account-dependent labels. Prefer an explicit
    // reasoning choice and verify the resulting selected state.
    const openedPicker = await this.evaluate<boolean>(target, [
      '(() => {',
      'const visible = e => { const s = getComputedStyle(e); return s.visibility !== "hidden" && s.display !== "none" && e.getClientRects().length > 0; };',
      'const buttons = [...document.querySelectorAll("button")].filter(visible);',
      'const picker = document.querySelector("[data-testid=\\"model-switcher-dropdown-button\\"]") || buttons.find(e => /instant|model|thinking|medium|high/i.test((e.getAttribute("aria-label") || "") + " " + (e.innerText || "")));',
      'if (!picker) return false;',
      'picker.click(); return true;',
      '})()',
    ].join("\\n")).catch(() => false);

    if (openedPicker) {
      await new Promise(resolve => setTimeout(resolve, 400));
      const selected = await this.evaluate<boolean>(target, [
        '(() => {',
        'const visible = e => { const s = getComputedStyle(e); return s.visibility !== "hidden" && s.display !== "none" && e.getClientRects().length > 0; };',
        'const options = [...document.querySelectorAll("[role=menuitem],[role=menuitemradio],[role=option],button")].filter(visible);',
        'const labels = ["Extra High", "High", "Medium", "Thinking", "Think", "Pro Extended", "Pro Standard"];',
        'for (const label of labels) {',
        '  const choice = options.find(e => { const text = (e.innerText || e.getAttribute("aria-label") || "").trim().toLowerCase(); const wanted = label.toLowerCase(); return text === wanted || text.startsWith(wanted + " "); });',
        '  if (choice) { choice.click(); return true; }',
        '}',
        'return false;',
        '})()',
      ].join("\\n")).catch(() => false);
      if (selected) await new Promise(resolve => setTimeout(resolve, 500));
    }

    const afterPicker = await readMode().catch(() => ({ modelText: "", thinkingActive: false }));
    if (afterPicker.thinkingActive) return;

    // Free/Go layouts can expose Thinking as a composer action in the + menu
    // instead of a model-picker entry.
    const openedToolsMenu = await this.evaluate<boolean>(target, [
      '(() => {',
      'const visible = e => { const s = getComputedStyle(e); return s.visibility !== "hidden" && s.display !== "none" && e.getClientRects().length > 0; };',
      'const buttons = [...document.querySelectorAll("button")].filter(visible);',
      'const plus = document.querySelector("[data-testid=\\"composer-plus-btn\\"]") || buttons.find(e => /add tools|tools and more|more options/i.test(e.getAttribute("aria-label") || ""));',
      'if (!plus) return false;',
      'plus.click(); return true;',
      '})()',
    ].join("\\n")).catch(() => false);

    if (openedToolsMenu) {
      await new Promise(resolve => setTimeout(resolve, 350));
      const selected = await this.evaluate<boolean>(target, [
        '(() => {',
        'const visible = e => { const s = getComputedStyle(e); return s.visibility !== "hidden" && s.display !== "none" && e.getClientRects().length > 0; };',
        'const options = [...document.querySelectorAll("[role=menuitem],[role=menuitemradio],[role=option],button")].filter(visible);',
        'const choice = options.find(e => /^thinking(?:\\b|\\s)/i.test((e.innerText || e.getAttribute("aria-label") || "").trim()));',
        'if (!choice) return false;',
        'choice.click(); return true;',
        '})()',
      ].join("\\n")).catch(() => false);
      if (selected) await new Promise(resolve => setTimeout(resolve, 500));
    }

    const finalMode = await readMode().catch(() => ({ modelText: "", thinkingActive: false }));
    if (!finalMode.thinkingActive) {
      throw new Error(
        "Could not verify that ChatGPT is in a reasoning mode (Thinking/Medium/High). " +
        "The prompt was not sent. Retry after choosing a supported Thinking option; set DC_SUBAGENT_HEADLESS=0 only if interactive UI selection is required.",
      );
    }
  }

  async send(target: BrowserTarget, content: string): Promise<void> {
    await this.ensureThinkingMode(target);
    const expression = [
      '(() => {',
      'const input = [...document.querySelectorAll(\'textarea#prompt-textarea, [contenteditable="true"]\')].find(element => element.getClientRects().length > 0);',
      'if (!input) return false;',
      'input.focus();',
      'const value = ' + JSON.stringify(content) + ';',
      'if (input instanceof HTMLTextAreaElement) {',
      'Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, value);',
      'input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));',
      '} else {',
      'document.execCommand("selectAll", false);',
      'document.execCommand("insertText", false, value);',
      'input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));',
      '}',
      'return true;',
      '})()',
    ].join('\n');
    const prepared = await this.evaluate<boolean>(target, expression);
    if (!prepared) throw new Error('ChatGPT is not signed in or its message composer is unavailable. The dedicated profile is headless by default; set DC_SUBAGENT_HEADLESS=0 for one-time sign-in, then restore the default headless mode.');

    const clicked = await this.evaluate<boolean>(target, [
      '(() => {',
      'const button = [...document.querySelectorAll("button")].find(element =>',
      'element.getAttribute("data-testid") === "send-button" || /^send(?: prompt)?$/i.test(element.getAttribute("aria-label") || ""));',
      'if (!button || button.disabled) return false;',
      'button.click();',
      'return true;',
      '})()',
    ].join('\n'));
    if (!clicked) {
      const connection = await this.connect();
      await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, target.sessionId);
      await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, target.sessionId);
    }
  }

  async getConversationUrl(target: BrowserTarget): Promise<string> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const url = await this.evaluate<string>(target, 'location.href').catch(() => CHATGPT_URL);
      if (/\/c\/[0-9a-f-]{16,}/i.test(url)) return url;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return await this.evaluate<string>(target, 'location.href').catch(() => CHATGPT_URL);
  }

  async inspect(target: BrowserTarget, submittedAt: string): Promise<{ status: string; detail: string }> {
    const expression = [
      '(() => {',
      'const visible = element => { const style = getComputedStyle(element); return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0; };',
      'const buttons = [...document.querySelectorAll("button")].filter(visible);',
      'const generating = buttons.some(button => /stop generating|stop streaming/i.test(button.getAttribute("aria-label") || "") || button.getAttribute("data-testid") === "stop-button");',
      'const composer = [...document.querySelectorAll(\'textarea#prompt-textarea, [contenteditable="true"]\')].some(visible);',
      'const alerts = [...document.querySelectorAll(\'[role="alert"], [data-testid*="error"], [role="dialog"]\')].filter(visible).map(element => element.innerText || "").join("\\n");',
      'const messages = [...document.querySelectorAll("[data-message-author-role]")];',
      'const lastMessage = messages.length ? (messages[messages.length - 1].innerText || "") : "";',
      'const lastRole = messages.length ? (messages[messages.length - 1].getAttribute("data-message-author-role") || "") : "";',
      'const statusText = alerts + "\\n" + lastMessage;',
      'const contextLimit = /(?:maximum context length|conversation is too long|reached the maximum length|too many messages in this conversation|start a new chat to continue)/i.test(statusText);',
      'const error = /(?:something went wrong|error generating response|network error|unable to load conversation|response generation failed)/i.test(statusText);',
      'return { composer, generating, contextLimit, error, lastRole };',
      '})()',
    ].join('\n');
    const value = await this.evaluate<{
      composer: boolean; generating: boolean; contextLimit: boolean; error: boolean; lastRole: string;
    }>(target, expression);
    if (!value?.composer) return { status: 'unknown', detail: 'ChatGPT composer state is not observable.' };
    if (value.contextLimit) return { status: 'context_limit', detail: 'A ChatGPT conversation-length warning is visible.' };
    if (value.error) return { status: 'error', detail: 'ChatGPT displays a visible generation, network, or conversation error.' };
    const lastTurnStillPending = value.lastRole === 'user';
    if (value.generating || lastTurnStillPending) {
      if (Date.now() - Date.parse(submittedAt) > GENERATION_TIMEOUT_MS) {
        return { status: 'timed_out', detail: 'The last submitted user turn has not visibly completed within the 30-minute timeout.' };
      }
      return { status: 'generating', detail: value.generating
        ? 'ChatGPT displays an active stop-generation control.'
        : 'The latest visible conversation turn is still the user turn; an assistant response has not appeared yet.' };
    }
    if (value.lastRole === 'assistant') {
      return { status: 'idle', detail: 'The latest conversation turn is an assistant turn; no active generation or visible error was detected.' };
    }
    return { status: 'unknown', detail: 'ChatGPT generation state could not be determined from visible conversation controls.' };
  }

  async close(targetId: string): Promise<void> {
    const connection = await this.connectExisting();
    if (!connection) return;
    await connection.send('Target.closeTarget', { targetId });
  }
}

function composePrompt(input: {
  id: string; parentId: string; workspace: string; parentWorkspace: string;
  task: string; transport: 'github' | 'cloud' | 'mcp';
}): string {
  return [
    'You are an independently operating ChatGPT subagent managed by Desktop Commander.',
    'Your agent ID is ' + input.id + '. Your parent agent ID is ' + input.parentId + '.',
    'Your assigned Bridge workspace is exactly: ' + input.workspace,
    'Use only this workspace: requests/, responses/, artifacts/, and subagents/. Never read or write your parent or sibling workspaces.',
    'The exact assigned workspace path above overrides any README example that assumes a root-level agent folder. Always put requests/, responses/, artifacts/, and subagents/ under this assigned workspace.',
    'Read the complete operating guide at https://github.com/hashin9973-ux/Bridge/blob/main/README.md before using Bridge, and follow its current protocol.',
    input.transport === 'github'
      ? 'GitHub Bridge transport: use the GitHub request/response queue for every Desktop Commander tool call, including mailbox. Your mailbox identity is your complete assigned workspace path: ' + input.workspace + '. No mailbox registration or username is used.'
      : 'Mailbox messaging is available only through GitHub Repository Bridge. For cloud-folder or direct MCP work, report progress, blockers, and completion in your own response files.',
    input.transport === 'github'
      ? 'Send parent reports with tool=mailbox arguments={action:send, to:' + input.parentWorkspace + ', message:<report>} through this GitHub Bridge queue; sender identity is supplied automatically from your assigned workspace. Check notifications in every Bridge response and read messages with action=inbox_unread (optionally include limit to read only a subset).'
      : 'Use your response files to make progress, blockers, and completion visible to the parent.',
    'You may create child subagents of your own. Put them only in your workspace/subagents/ directory.',
    input.transport === 'mcp'
      ? 'When using the direct MCP subagent tool, include parent_agent_id=' + input.id + ' and parent_workspace_path=' + input.workspace + ' on every action so parent ownership is explicit.'
      : 'Create and manage child subagents by submitting the subagent tool through your Bridge workspace. Bridge execution supplies parent identity and workspace automatically; the repository-relative workspace path is not a local filesystem path for direct MCP calls.',
    'Task from parent:',
    input.task,
  ].join('\n\n');
}

async function collectAgentIds(root: string, ids: Set<string>, depth = 0): Promise<void> {
  if (depth > 24) throw new Error('Subagent nesting exceeds safe discovery depth.');
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (AGENT_ID_PATTERN.test(entry.name)) {
      ids.add(entry.name);
      await collectAgentIds(path.join(root, entry.name, SUBAGENT_FOLDER), ids, depth + 1);
    } else if (entry.name === SUBAGENT_FOLDER) {
      await collectAgentIds(path.join(root, entry.name), ids, depth + 1);
    }
  }
}

class SubagentManager {
  private readonly root = stateDirectory();
  private readonly registryPath = path.join(this.root, 'registry.json');
  private readonly browser = new ChatGptBrowser(this.root);
  private queue: Promise<unknown> = Promise.resolve();

  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous.catch(() => undefined);
    try { return await work(); } finally { release(); }
  }

  async handle(args: SubagentToolArguments): Promise<string> {
    return this.serial(async () => {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      const lockPath = this.registryPath + '.lockfile';
      const handle = await fs.open(lockPath, 'a', 0o600);
      await handle.close();
      const release = await lockfile.lock(lockPath, {
        retries: { retries: 40, minTimeout: 50, maxTimeout: 500 },
      });
      try {
        switch (args.action) {
          case 'spawn': return await this.spawn(args);
          case 'continue': return await this.continue(args);
          case 'status': return await this.status(args);
          case 'delete': return await this.delete(args);
        }
      } finally {
        await release();
      }
    });
  }

  private async getParent(args: SubagentToolArguments): Promise<{
    id: string; agentPath: string; workspace: string; transport: 'github' | 'cloud' | 'mcp';
  }> {
    const context = parentContext.getStore();
    const agentPath = context?.agentId || args.parent_agent_id || '';
    const id = validateAgentId(leafAgentId(agentPath));
    const workspace = context?.workspacePath || args.parent_workspace_path;
    if (!workspace?.trim()) {
      throw new Error('Direct MCP spawn requires parent_agent_id and parent_workspace_path so the child can be placed under the parent workspace.');
    }
    if (!context && !args.parent_agent_id?.trim()) {
      throw new Error('Direct MCP spawn requires parent_agent_id to establish parent ownership and mailbox routing.');
    }
    return {
      id,
      agentPath,
      workspace: await realDirectory(path.resolve(workspace), 'Parent agent workspace'),
      transport: context?.transport || 'mcp',
    };
  }

  private async spawn(args: SubagentToolArguments): Promise<string> {
    if (!args.prompt?.trim()) throw new Error('spawn requires a non-empty prompt.');
    const parent = await this.getParent(args);
    const subagentsPath = path.join(parent.workspace, SUBAGENT_FOLDER);
    if (!await exists(subagentsPath)) await fs.mkdir(subagentsPath);
    await realDirectory(subagentsPath, 'Parent subagents folder');

    const target = await this.browser.createChat();
    let workspace: string | undefined;
    try {
      if (!await this.browser.waitForComposer(target)) {
        throw new Error('No signed-in ChatGPT composer was detected in the dedicated profile. It runs headlessly by default; set DC_SUBAGENT_HEADLESS=0 for one-time sign-in, then restart Desktop Commander in the default headless mode.');
      }

      const state = await readState(this.registryPath);
      const used = new Set(state.records.filter(record => !record.deleted).map(record => record.id));
      for (const ancestor of parent.agentPath.split('/').filter(segment => AGENT_ID_PATTERN.test(segment))) {
        used.add(ancestor);
      }
      const bridgeRoot = await this.getBridgeRoot(parent.workspace);
      if (bridgeRoot) await collectAgentIds(bridgeRoot, used);
      const id = await this.makeId(used, subagentsPath);
      workspace = path.join(subagentsPath, id);
      await fs.mkdir(workspace);
      for (const name of ['requests', 'responses', 'artifacts', SUBAGENT_FOLDER]) {
        await fs.mkdir(path.join(workspace, name));
      }
      const realWorkspace = await realDirectory(workspace, 'Subagent workspace');

      const childWorkspacePath = parent.agentPath + '/subagents/' + id;
      await this.browser.send(target, composePrompt({
        id, parentId: parent.id,
        workspace: parent.transport === 'mcp' ? realWorkspace : childWorkspacePath,
        parentWorkspace: parent.transport === 'mcp' ? parent.workspace : parent.agentPath,
        task: args.prompt.trim(),
        transport: parent.transport,
      }));
      const conversationUrl = await this.browser.getConversationUrl(target);
      if (!/\/c\/[0-9a-f-]{16,}/i.test(conversationUrl)) {
        throw new Error('ChatGPT accepted the initial prompt but did not expose a persistent conversation URL; the subagent was not registered.');
      }
      const now = new Date().toISOString();
      const record: SubagentRecord = {
        id, parentAgentId: parent.id, parentAgentPath: parent.agentPath,
        agentPath: parent.agentPath + '/subagents/' + id,
        parentWorkspacePath: parent.workspace, workspacePath: realWorkspace, transport: parent.transport,
        targetId: target.targetId, conversationUrl,
        createdAt: now, updatedAt: now, lastSubmittedAt: now,
      };
      state.records.push(record);
      await saveState(this.registryPath, state);
      return JSON.stringify({
        status: 'created', agent_id: id, parent_agent_id: parent.id,
        workspace_path: realWorkspace, conversation_url: record.conversationUrl,
        mailbox_username: id, parent_mailbox_username: parent.id,
      }, null, 2);
    } catch (error) {
      await this.browser.close(target.targetId).catch(() => undefined);
      if (workspace) await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async getBridgeRoot(workspace: string): Promise<string | undefined> {
    let current = workspace;
    for (let depth = 0; depth < 24; depth++) {
      if (path.basename(path.dirname(current)) === SUBAGENT_FOLDER) {
        current = path.dirname(path.dirname(current));
      } else {
        return AGENT_ID_PATTERN.test(path.basename(current)) ? path.dirname(current) : undefined;
      }
    }
    return undefined;
  }

  private async makeId(used: Set<string>, parentPath: string): Promise<string> {
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
    for (let length = 2; length <= 8; length++) {
      for (let attempt = 0; attempt < 500; attempt++) {
        const bytes = randomBytes(length);
        let suffix = '';
        for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
        const candidate = 'agent-' + suffix;
        if (!used.has(candidate) && !await exists(path.join(parentPath, candidate))) return candidate;
      }
    }
    throw new Error('Could not allocate a collision-free subagent ID.');
  }

  private async find(args: SubagentToolArguments): Promise<{ state: SubagentState; record: SubagentRecord }> {
    const state = await readState(this.registryPath);
    const id = validateAgentId(args.subagent_id || '');
    const record = state.records.find(item => item.id === id && !item.deleted);
    if (!record) throw new Error('Subagent not found: ' + id);
    const context = parentContext.getStore();
    const caller = context?.agentId || args.parent_agent_id;
    const callerWorkspace = context?.workspacePath || args.parent_workspace_path;
    if (!caller || !callerWorkspace?.trim()) {
      throw new Error('Direct MCP subagent actions require parent_agent_id and parent_workspace_path.');
    }
    if (leafAgentId(caller) !== record.parentAgentId
      || path.resolve(callerWorkspace) !== path.resolve(record.parentWorkspacePath)) {
      throw new Error('An agent can only manage its own direct subagents from its assigned workspace.');
    }
    return { state, record };
  }

  private async continue(args: SubagentToolArguments): Promise<string> {
    const { state, record } = await this.find(args);
    const target = await this.browser.attach(record.targetId, record.conversationUrl, true);
    if (!await this.browser.waitForComposer(target)) throw new Error('The subagent conversation is not ready for input.');
    await this.browser.send(target, 'continue.');
    record.targetId = target.targetId;
    record.updatedAt = new Date().toISOString();
    record.lastSubmittedAt = record.updatedAt;
    await saveState(this.registryPath, state);
    return JSON.stringify({ status: 'continued', agent_id: record.id, sent: 'continue.', conversation_url: record.conversationUrl }, null, 2);
  }

  private async status(args: SubagentToolArguments): Promise<string> {
    const { state, record } = await this.find(args);
    try {
      const target = await this.browser.attach(record.targetId, record.conversationUrl);
      const observed = await this.browser.inspect(target, record.lastSubmittedAt);
      record.updatedAt = new Date().toISOString();
      await saveState(this.registryPath, state);
      return JSON.stringify({
        agent_id: record.id, parent_agent_id: record.parentAgentId,
        status: observed.status, detail: observed.detail,
        conversation_url: record.conversationUrl,
        last_submitted_at: record.lastSubmittedAt, updated_at: record.updatedAt,
      }, null, 2);
    } catch (error) {
      return JSON.stringify({
        agent_id: record.id, status: 'unknown',
        detail: 'Could not inspect ChatGPT browser state: ' + errorMessage(error),
        conversation_url: record.conversationUrl,
      }, null, 2);
    }
  }

  private async delete(args: SubagentToolArguments): Promise<string> {
    const { state, record } = await this.find(args);
    const descendants = state.records.filter(item => !item.deleted &&
      (item.workspacePath === record.workspacePath || item.workspacePath.startsWith(record.workspacePath + path.sep)));
    for (const descendant of descendants) await this.browser.close(descendant.targetId).catch(() => undefined);

    const realParent = await realDirectory(record.parentWorkspacePath, 'Parent workspace');
    const subagents = await realDirectory(path.join(realParent, SUBAGENT_FOLDER), 'Parent subagents folder');
    const child = await realDirectory(record.workspacePath, 'Subagent workspace');
    const relative = path.relative(subagents, child);
    if (!relative || path.isAbsolute(relative) || relative.startsWith('..' + path.sep) || path.dirname(relative) !== '.') {
      throw new Error('Refusing to delete a workspace outside the parent subagents folder.');
    }

    if (record.transport === 'github') {
      await fs.rm(child, { recursive: true, force: true });
      await fs.mkdir(child);
      await writeFileAtomic(path.join(child, '.subagent-deleted.json'), JSON.stringify({
        id: record.id, deleted_at: new Date().toISOString(),
      }) + '\n');
    } else {
      await fs.rm(child, { recursive: true, force: true });
    }
    const now = new Date().toISOString();
    for (const descendant of descendants) {
      descendant.deleted = true;
      descendant.updatedAt = now;
    }
    await saveState(this.registryPath, state);
    return JSON.stringify({
      status: 'deleted', agent_id: record.id,
      deleted_descendants: descendants.length,
      remote_cleanup: record.transport === 'github' ? 'pending_github_sync' : 'complete',
    }, null, 2);
  }
}

const manager = new SubagentManager();
export async function handleSubagentTool(args: SubagentToolArguments): Promise<string> {
  return manager.handle(args);
}
