import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024;
const DEFAULT_TUNNEL_STARTUP_TIMEOUT_MS = 45_000;
const MAX_SEEN_DELIVERIES = 4_096;

export interface GitHubWebhookServerOptions {
  repository: string;
  defaultBranch: string;
  secret: string;
  onPush: () => void | Promise<void>;
  onError?: (error: Error) => void;
  maxBodyBytes?: number;
}

export interface GitHubWebhookServer {
  originUrl: string;
  path: string;
  close: () => Promise<void>;
}

interface ReadBodyResult {
  body: Buffer | null;
  tooLarge: boolean;
}

async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<ReadBodyResult> {
  const contentLength = request.headers['content-length'];
  if (typeof contentLength === 'string') {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      request.resume();
      return { body: null, tooLarge: true };
    }
  }

  return new Promise<ReadBodyResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    request.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(bytes);
    });
    request.once('end', () => {
      resolve({
        body: tooLarge ? null : Buffer.concat(chunks, size),
        tooLarge,
      });
    });
    request.once('error', reject);
    request.once('aborted', () => reject(new Error('GitHub webhook request was aborted.')));
  });
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function hasValidSignature(body: Buffer, secret: string, supplied: string | undefined): boolean {
  if (!supplied || !/^sha256=[0-9a-f]{64}$/i.test(supplied)) return false;
  const expected = Buffer.from(
    'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
    'utf8',
  );
  const actual = Buffer.from(supplied, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function startGitHubWebhookServer(
  options: GitHubWebhookServerOptions,
): Promise<GitHubWebhookServer> {
  if (!options.repository || !options.defaultBranch || !options.secret) {
    throw new Error('GitHub webhook server requires a repository, default branch, and secret.');
  }

  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_WEBHOOK_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error('GitHub webhook body limit must be a positive integer.');
  }

  const webhookPath = '/github-webhook/' + randomBytes(24).toString('hex');
  const seenDeliveries = new Set<string>();
  const deliveryOrder: string[] = [];

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== webhookPath) {
        response.writeHead(404).end();
        return;
      }

      const result = await readRequestBody(request, maxBodyBytes);
      if (result.tooLarge || !result.body) {
        response.writeHead(413).end();
        return;
      }

      if (!hasValidSignature(
        result.body,
        options.secret,
        headerValue(request, 'x-hub-signature-256'),
      )) {
        response.writeHead(401).end();
        return;
      }

      const event = headerValue(request, 'x-github-event');
      const deliveryId = headerValue(request, 'x-github-delivery');
      if (!event || !deliveryId || deliveryId.length > 200) {
        response.writeHead(400).end();
        return;
      }

      if (event === 'ping') {
        response.writeHead(200).end('pong');
        return;
      }

      if (event !== 'push') {
        response.writeHead(204).end();
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(result.body.toString('utf8')) as unknown;
      } catch {
        response.writeHead(400).end();
        return;
      }

      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        response.writeHead(400).end();
        return;
      }
      const push = payload as {
        ref?: unknown;
        repository?: { full_name?: unknown } | null;
      };
      if (push.repository?.full_name !== options.repository
        || push.ref !== 'refs/heads/' + options.defaultBranch) {
        response.writeHead(202).end();
        return;
      }

      if (seenDeliveries.has(deliveryId)) {
        response.writeHead(202).end();
        return;
      }

      seenDeliveries.add(deliveryId);
      deliveryOrder.push(deliveryId);
      if (deliveryOrder.length > MAX_SEEN_DELIVERIES) {
        const oldest = deliveryOrder.shift();
        if (oldest) seenDeliveries.delete(oldest);
      }

      response.writeHead(202).end();
      setImmediate(() => {
        Promise.resolve()
          .then(() => options.onPush())
          .catch((error: unknown) => {
            options.onError?.(error instanceof Error ? error : new Error(String(error)));
          });
      });
    })().catch((error: unknown) => {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    });
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Could not determine the local GitHub webhook listener address.');
  }

  return {
    originUrl: 'http://127.0.0.1:' + address.port,
    path: webhookPath,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

export function extractQuickTunnelUrl(output: string): string | undefined {
  const matches = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/ig) || [];
  for (const candidate of matches) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'https:' && parsed.hostname.endsWith('.trycloudflare.com')) {
        return parsed.origin;
      }
    } catch {
      // Ignore malformed text from the child process.
    }
  }
  return undefined;
}

export function resolveCloudflaredPath(): string {
  const bundled = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../tools/cloudflared.exe',
  );
  if (process.platform === 'win32' && existsSync(bundled)) return bundled;
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

export interface QuickTunnelOptions {
  executablePath?: string;
  startupTimeoutMs?: number;
  spawnProcess?: typeof spawn;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface QuickTunnel {
  url: string;
  close: () => Promise<void>;
}

export async function startCloudflareQuickTunnel(
  originUrl: string,
  options: QuickTunnelOptions = {},
): Promise<QuickTunnel> {
  let origin: URL;
  try {
    origin = new URL(originUrl);
  } catch {
    throw new Error('Quick Tunnel origin must be a valid local HTTP URL.');
  }
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') {
    throw new Error('Quick Tunnel origin must use plain HTTP on 127.0.0.1.');
  }

  const executable = options.executablePath || resolveCloudflaredPath();
  const spawnProcess = options.spawnProcess || spawn;
  const child: ChildProcess = spawnProcess(
    executable,
    ['tunnel', '--url', origin.origin, '--no-autoupdate'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    },
  );

  let output = '';
  let settled = false;
  let startupTimer: NodeJS.Timeout | undefined;
  let finishResolve!: (value: string) => void;
  let finishReject!: (error: Error) => void;

  const ready = new Promise<string>((resolve, reject) => {
    finishResolve = resolve;
    finishReject = reject;
    startupTimer = setTimeout(() => {
      fail(new Error(
        'cloudflared did not publish a trycloudflare.com URL within ' +
        (options.startupTimeoutMs ?? DEFAULT_TUNNEL_STARTUP_TIMEOUT_MS) +
        ' ms. ' + output.slice(-2_000),
      ));
    }, options.startupTimeoutMs ?? DEFAULT_TUNNEL_STARTUP_TIMEOUT_MS);
  });

  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    if (startupTimer) clearTimeout(startupTimer);
    finishReject(error);
  };

  const inspectOutput = (chunk: Buffer | string) => {
    output = (output + chunk.toString()).slice(-16_000);
    const url = extractQuickTunnelUrl(output);
    if (!settled && url) {
      settled = true;
      if (startupTimer) clearTimeout(startupTimer);
      finishResolve(url);
    }
  };

  child.stdout?.on('data', inspectOutput);
  child.stderr?.on('data', inspectOutput);
  child.once('error', (error) => {
    fail(new Error(
      'Could not start cloudflared (' + executable + '): ' + error.message +
      '. Re-extract the portable ZIP or install cloudflared on PATH.',
    ));
  });
  child.once('exit', (code, signal) => {
    if (!settled) {
      fail(new Error(
        'cloudflared exited before the Quick Tunnel became ready' +
        (signal ? ' (signal ' + signal + ')' : ' (exit code ' + code + ')') +
        '. ' + output.slice(-2_000),
      ));
    } else {
      options.onExit?.(code, signal);
    }
  });

  try {
    const url = await ready;
    return {
      url,
      close: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>((resolve) => {
          let completed = false;
          const finish = () => {
            if (completed) return;
            completed = true;
            clearTimeout(forceTimer);
            child.removeListener('exit', finish);
            resolve();
          };
          const forceTimer = setTimeout(() => {
            child.kill();
            finish();
          }, 5_000);
          child.once('exit', finish);
          child.kill('SIGTERM');
        });
      },
    };
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}
