import { runBridge as runCloudBridge } from './runtime.js';
import { runGitHubBridge } from './github-runtime.js';

export async function runBridge(args: string[] = []): Promise<void> {
  const options = [...args];
  const providerIndex = options.indexOf('--provider');

  if (providerIndex === -1) {
    await runCloudBridge(options);
    return;
  }

  const provider = options[providerIndex + 1];
  if (provider !== 'cloud' && provider !== 'github') {
    throw new Error('--provider must be either cloud or github.');
  }
  options.splice(providerIndex, 2);

  if (provider === 'github') {
    await runGitHubBridge(options);
    return;
  }
  await runCloudBridge(options);
}
