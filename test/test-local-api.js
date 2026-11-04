import assert from 'node:assert/strict';
import {
  apiPath,
  buildOpenAiTools,
  fetchAvailableModels,
  normalizeOpenAiBaseUrl,
  parseFunctionArguments,
  runAgentTurn,
} from '../dist/local-api/runtime.js';

assert.equal(normalizeOpenAiBaseUrl('http://localhost:5001'), 'http://localhost:5001/v1');
assert.equal(normalizeOpenAiBaseUrl('http://127.0.0.1:5001/v1/'), 'http://127.0.0.1:5001/v1');
assert.equal(normalizeOpenAiBaseUrl('http://[::1]:5001/v1'), 'http://[::1]:5001/v1');
assert.equal(apiPath('http://127.0.0.1:5001/v1', 'chat/completions'), 'http://127.0.0.1:5001/v1/chat/completions');
assert.throws(() => normalizeOpenAiBaseUrl('https://api.openai.com/v1'), /only connects to localhost/);
assert.throws(() => normalizeOpenAiBaseUrl('http://user:password@localhost:5001/v1'), /Do not put credentials/);
assert.deepEqual(parseFunctionArguments('{"path":"notes.txt"}'), { path: 'notes.txt' });
assert.deepEqual(parseFunctionArguments({ path: 'notes.txt' }), { path: 'notes.txt' });
assert.throws(() => parseFunctionArguments('[]'), /must be a JSON object/);
assert.throws(() => parseFunctionArguments('{bad json'), /invalid JSON tool arguments/);

const tools = buildOpenAiTools();
assert.ok(tools.length > 10, 'the local API should advertise the Desktop Commander tool set');
assert.ok(tools.some((tool) => tool.function.name === 'read_file'));
assert.ok(!tools.some((tool) => tool.function.name === 'track_ui_event'));
const readFileTool = tools.find((tool) => tool.function.name === 'read_file');
assert.ok(readFileTool.function.parameters.properties.path);
assert.equal(readFileTool.function.parameters.properties.origin, undefined);
assert.ok(readFileTool.function.parameters.properties.mailbox_user_id);

let discoveredUrl = '';
const models = await fetchAvailableModels(
  'http://127.0.0.1:5001/v1',
  'local-test-key',
  async (url, init) => {
    discoveredUrl = String(url);
    assert.equal(init.headers.authorization, 'Bearer local-test-key');
    return new Response(JSON.stringify({ data: [{ id: 'koboldcpp-model' }] }), { status: 200 });
  },
);
assert.equal(discoveredUrl, 'http://127.0.0.1:5001/v1/models');
assert.deepEqual(models, ['koboldcpp-model']);

const messages = [{ role: 'system', content: 'test system prompt' }, { role: 'user', content: 'Read notes.txt' }];
const requests = [];
const executions = [];
const replies = [
  {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-read-1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'notes.txt', origin: 'ui' }),
          },
        }],
      },
    }],
  },
  {
    choices: [{
      message: {
        role: 'assistant',
        content: 'The file says hello.',
      },
    }],
  },
];

const answer = await runAgentTurn({
  baseUrl: 'http://127.0.0.1:5001/v1',
  model: 'koboldcpp-model',
  apiKey: 'local-test-key',
  messages,
  maxTokens: 1024,
  maxToolRounds: 4,
  fetcher: async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  },
  toolExecutor: async (name, args) => {
    executions.push({ name, args });
    return { content: [{ type: 'text', text: 'File contents: hello.' }] };
  },
});

assert.equal(answer, 'The file says hello.');
assert.equal(requests.length, 2);
assert.equal(requests[0].url, 'http://127.0.0.1:5001/v1/chat/completions');
assert.equal(requests[0].body.model, 'koboldcpp-model');
assert.equal(requests[0].body.tool_choice, 'auto');
assert.ok(Array.isArray(requests[0].body.tools));
assert.equal(requests[0].headers.authorization, 'Bearer local-test-key');
assert.deepEqual(executions, [{ name: 'read_file', args: { path: 'notes.txt', origin: 'llm' } }]);
assert.equal(messages.some((message) => message.role === 'tool'
  && message.tool_call_id === 'call-read-1'
  && message.content.includes('File contents: hello.')), true);
assert.equal(messages[messages.length - 1].content, 'The file says hello.');

console.log('Local OpenAI-compatible API mode tests passed.');
