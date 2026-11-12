import { toolArgSchemas } from '../tools/schemas.js';
import { detectUnsupportedParams } from '../utils/unsupportedParams.js';

export interface BridgeCommand {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface BridgeRequest {
  protocol_version: 1;
  id: string;
  commands: BridgeCommand[];
  command_delay_ms?: number;
}

const REQUEST_FILE_PATTERN = /^(?:request-)?([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.(json|md)$/i;
// Root-level agent-<uniqueid>/ folders identify conversations and subagents.
// The mailbox is exposed through GitHub Bridge requests only. Cloud-folder
// queues intentionally keep mailbox contents out of synchronized storage.
export type BridgeTransport = 'cloud' | 'github';
const HIDDEN_TOOLS = new Set(['track_ui_event']);

export function getBridgeToolNames(transport: BridgeTransport = 'cloud'): string[] {
  return Object.keys(toolArgSchemas)
    .filter((name) => !HIDDEN_TOOLS.has(name) && (name !== 'mailbox' || transport === 'github'))
    .sort();
}

// Backwards-compatible default for cloud-folder mode.
export const BRIDGE_TOOL_NAMES = getBridgeToolNames('cloud');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) {
    throw new Error(label + ' contains unsupported field(s): ' + extra.join(', '));
  }
}

function parseCommand(value: unknown, index: number, transport: BridgeTransport): BridgeCommand {
  if (!isRecord(value)) throw new Error('Command ' + (index + 1) + ' must be a JSON object.');
  assertOnlyKeys(value, ['tool', 'arguments'], 'Command ' + (index + 1));

  if (typeof value.tool !== 'string' || !value.tool.trim()) {
    throw new Error('Command ' + (index + 1) + ' must include a non-empty tool name.');
  }
  if (!Object.prototype.hasOwnProperty.call(toolArgSchemas, value.tool)
    || HIDDEN_TOOLS.has(value.tool)
    || (value.tool === 'mailbox' && transport !== 'github')) {
    throw new Error('Command ' + (index + 1) + ' uses unknown or unavailable tool "' + value.tool + '".');
  }
  if (!isRecord(value.arguments)) {
    throw new Error('Command ' + (index + 1) + ' arguments must be a JSON object (use {} for tools with no arguments).');
  }

  if (value.arguments.origin === 'ui') {
    throw new Error('Command ' + (index + 1) + ' cannot use origin "ui"; the bridge only supports agent-originated tool calls.');
  }

  const schema = toolArgSchemas[value.tool];
  const schemaArguments = { ...value.arguments };

  const unsupported = detectUnsupportedParams(schemaArguments, schema);
  if (unsupported.length) {
    throw new Error('Command ' + (index + 1) + ' (' + value.tool + ') has unsupported argument(s): ' + unsupported.join(', ') + '.');
  }

  const parsed = schema.safeParse(schemaArguments);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const at = issue.path.length ? issue.path.join('.') + ': ' : '';
      return at + issue.message;
    }).join('; ');
    throw new Error('Invalid arguments for command ' + (index + 1) + ' (' + value.tool + '): ' + issues);
  }

  if (!isRecord(parsed.data)) {
    throw new Error('Command ' + (index + 1) + ' (' + value.tool + ') did not produce an object argument set.');
  }
  return { tool: value.tool, arguments: { ...parsed.data } };
}

function parseJsonRequest(idFromFilename: string, content: string, transport: BridgeTransport): BridgeRequest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error('Invalid request JSON: ' + (error instanceof Error ? error.message : String(error)));
  }
  if (!isRecord(value)) throw new Error('The JSON request root must be an object.');
  assertOnlyKeys(value, ['protocol_version', 'id', 'commands', 'command_delay_ms'], 'Request');

  if (value.protocol_version !== 1) {
    throw new Error('Unsupported protocol_version "' + String(value.protocol_version) + '"; expected 1.');
  }
  if (typeof value.id !== 'string' || value.id !== idFromFilename) {
    throw new Error('Request id must exactly match the filename id "' + idFromFilename + '".');
  }
  if (!Array.isArray(value.commands) || value.commands.length === 0) {
    throw new Error('Request commands must be a non-empty array.');
  }
  if (value.command_delay_ms !== undefined
    && (!Number.isInteger(value.command_delay_ms) || Number(value.command_delay_ms) < 0 || Number(value.command_delay_ms) > 60_000)) {
    throw new Error('command_delay_ms must be an integer from 0 to 60000.');
  }

  return {
    protocol_version: 1,
    id: idFromFilename,
    commands: value.commands.map((command, index) => parseCommand(command, index, transport)),
    ...(value.command_delay_ms === undefined ? {} : { command_delay_ms: Number(value.command_delay_ms) }),
  };
}

function parseMarkdownRequest(idFromFilename: string, content: string, transport: BridgeTransport): BridgeRequest {
  const commands: BridgeCommand[] = [];
  const lines = content.split(/\r?\n/);
  let fenceCharacter: string | undefined;
  let fenceLength = 0;
  let executableFence = false;
  let commandLines: string[] = [];

  for (const line of lines) {
    if (!fenceCharacter) {
      const opening = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
      if (!opening) continue;
      fenceCharacter = opening[1][0];
      fenceLength = opening[1].length;
      executableFence = opening[2].trim().toLowerCase() === 'desktop-commander-v1';
      commandLines = [];
      continue;
    }

    const closing = /^ {0,3}(\x60{3,}|~{3,})[ \t]*$/.exec(line);
    if (closing && closing[1][0] === fenceCharacter && closing[1].length >= fenceLength) {
      if (executableFence) {
        let command: unknown;
        try {
          command = JSON.parse(commandLines.join('\n').trim());
        } catch (error) {
          throw new Error('Invalid JSON in desktop-commander-v1 block ' + (commands.length + 1) + ': ' + (error instanceof Error ? error.message : String(error)));
        }
        commands.push(parseCommand(command, commands.length, transport));
      }
      fenceCharacter = undefined;
      fenceLength = 0;
      executableFence = false;
      commandLines = [];
    } else if (executableFence) {
      commandLines.push(line);
    }
  }

  if (executableFence) {
    throw new Error('Unterminated desktop-commander-v1 fenced block.');
  }
  if (commands.length === 0) {
    throw new Error('Markdown request contains no executable desktop-commander-v1 fenced blocks.');
  }
  return { protocol_version: 1, id: idFromFilename, commands };
}
export function parseBridgeRequest(
  filename: string,
  content: string,
  transport: BridgeTransport = 'cloud',
): BridgeRequest {
  const match = REQUEST_FILE_PATTERN.exec(filename);
  if (!match) {
    throw new Error('Request filename must be request-<id>.json or request-<id>.md; id may contain letters, digits, underscores and hyphens.');
  }
  const id = match[1];
  return match[2].toLowerCase() === 'json'
    ? parseJsonRequest(id, content, transport)
    : parseMarkdownRequest(id, content, transport);
}
