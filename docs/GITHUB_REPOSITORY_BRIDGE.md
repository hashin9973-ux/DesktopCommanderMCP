# Desktop Commander GitHub Repository Bridge

The GitHub Repository Bridge uses a GitHub repository as a request/response mailbox. The bridge runs on your computer; GitHub stores queue files and artifacts, while local Desktop Commander executes the requested tools.

## Connect an account

Install GitHub CLI and authenticate once:

```powershell
gh auth login
```

On startup, the bridge reads the token from the local GitHub CLI credential store using `gh auth token --hostname github.com`. It does not write the token into the repository or Desktop Commander settings.

For headless deployments, set `GITHUB_TOKEN` or `GH_TOKEN` in the process environment instead. Never put a token in a request file or commit it to the repository.

## Select or create the repository

Start the portable executable and choose **GitHub repository bridge**. The first connection offers two choices:

1. Select an existing, non-archived repository where the authenticated account has write permission.
2. Create a new repository under the authenticated personal account. The bridge requests that GitHub create it as **private**, initializes it, and then creates the queue folders.

The created repository is a dedicated mailbox; it is not a clone of your application source repository. To create a private repository through the GitHub API, the credential must have repository-creation permissions. For a fine-grained personal access token, GitHub documents the Administration repository permission as required for this endpoint; classic tokens need the `repo` scope. See [GitHub's create-a-repository endpoint](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user).

You can also configure the selection non-interactively:

```powershell
DesktopCommanderBridge.exe bridge --provider github --github-repository owner/name
DesktopCommanderBridge.exe bridge --provider github --create-github-repository my-private-mailbox
```

## Queue protocol

The bridge initializes these repository paths on the existing default branch:

- `requests/` — submit `request-<id>.json` or `request-<id>.md`.
- `responses/` — completed `response-<id>.json` files.
- `artifacts/` — binary outputs referenced by a response.
- `DESKTOP_COMMANDER_BRIDGE.md` — queue usage and security guide.

Requests use protocol version 1 and the same command/tool schemas as Cloud-folder Bridge. A local worker uses the existing Desktop Commander execution engine. The bridge polls GitHub every five seconds by default; configure `--poll-interval-ms` to change the interval (1,000–60,000 ms).

Artifacts are uploaded before the response file. The response file is the durable completion marker. Files are committed directly to the repository's existing default branch. The bridge does not create branches, pull requests, or edit application source files.

## Requirements and limitations

- The selected repository must allow direct writes to its default branch. A branch rule that requires pull requests is incompatible with this no-branches design.
- Use one running bridge worker per repository. GitHub commits are not a distributed worker lock.
- Anyone with write access to the repository can submit commands for local execution on the bridge computer. Use a private repository and share write access only with trusted collaborators. The local tool restrictions are guardrails, not an operating-system sandbox.
- This implementation sets a 50 MiB per-file transport limit for request, response, and artifact files.
- Remote queue history is retained in GitHub; the bridge does not automatically delete remote requests, responses, or artifacts. Repository maintainers can archive or remove old queue entries manually.
- GitHub's Contents API is used for file-level reads and commits. The bridge does not check out the repository or synchronize unrelated source files to the local worker.

## Startup modes

When launched directly in an interactive terminal with no arguments, the portable executable offers **MCP**, **Cloud-folder bridge**, and **GitHub repository bridge**. MCP is the default selection. When launched by an MCP host without an interactive terminal, the launcher starts standard MCP stdio mode without displaying a menu. Existing explicit `bridge --directory ...` invocations continue to use Cloud-folder Bridge.
