'use strict';

function resolveModeChoice(choice) {
  const selection = choice == null ? '' : String(choice).trim();

  switch (selection || '1') {
    case '1':
      return ['remote'];
    case '2':
      // Standard MCP stdio is intentionally quiet when opened directly.
      // It is meant to be spawned and driven by an MCP host.
      return [];
    case '3':
      return ['bridge', '--provider', 'cloud'];
    case '4':
      return ['bridge', '--provider', 'github'];
    case '5':
      return ['local-api'];
    default:
      throw new Error('Invalid mode selection. Choose 1, 2, 3, 4, or 5.');
  }
}

module.exports = { resolveModeChoice };
