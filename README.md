# Codex with MCP for Buzz

A **panosdigital** plugin that runs local Codex agents in Buzz with the MCP servers already configured for Codex.

## Features

- Use enabled local and remote Codex MCP servers with their configured authentication and tool restrictions.
- Reply through Buzz tools under the agent's own identity and permissions.
- Choose a model and supported reasoning effort from the local Codex catalog.
- Keep separate conversations per thread or per channel, with saved session bindings.
- Open live and saved transcripts from an agent's activity bubble, with expandable tool details and code formatting.
- Use Stop and New session controls, with explicit execution-access settings.
- Sync model, reasoning effort and conversation scope through Buzz; instructions use Buzz's separate instructions artifact.

## Requirements

| Component | Compatibility                                                                                |
| --------- | -------------------------------------------------------------------------------------------- |
| Buzz      | Desktop 1.0.x verified, plugin API 1. Buzz 0.5 is unsupported. Other builds need validation. |
| Codex     | An already installed, signed-in `codex` executable on Buzz's process PATH.                   |

There is no plugin dependency-install or build step. The runtime is the self-contained `plugin.js` module plus `manifest.json`; artwork is included in the source folder.

## Install from a local folder

This repository is being prepared for a future release. No public download or installation URL is available yet.

1. Obtain a reviewed source folder containing `manifest.json`, `plugin.js` and `README.md`.
2. In Buzz, open **Settings → Plugins → Manage plugins → Add → Browse** and select that folder.
3. Review the process, file and MCP grants, then confirm installation.
4. Create a test agent and select **Codex with MCP**. Set its Workspace directory and instructions.
5. Keep Model and Thinking on their Default choices to inherit local Codex settings, or select explicit values.
6. Ask for one harmless read through an MCP server you already use, then verify the result and Buzz reply.

Use **Browse** to retain a reloadable source-folder link. Buzz's normal install review owns permissions and activation.

Development and public builds use plugin ID `digital.panos.buzz-plugin-codex-with-mcp` and agent type `digital.panos.buzz-plugin-codex-with-mcp/codex-mcp`. Both use the same local session-storage namespace, `digital.panos.buzz-plugin-codex-with-mcp/session/`.

## Workspace and execution access

Workspace is the agent's starting directory and the main write boundary in workspace-only mode. The default is `~/.buzz`; choose a narrower project directory when appropriate. Reads outside that tree, permitted temporary directories and additional configured roots follow Codex's effective policy.

| Execution access         | Command behavior                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read only                | Restricts filesystem writes. Networking and local services may also be restricted.                                                                |
| Workspace only — default | Allows workspace/temp writes subject to Codex policy. Local services, background utilities and access outside the permitted roots may be blocked. |
| Full host access         | Permits broad filesystem and network access for commands.                                                                                         |

Workspace and execution access stay local to the device. Saving an explicit access choice applies when the next turn starts or resumes its saved session. Updating the plugin preserves saved choices. The workspace-only default differs from Buzz 1.0.2's bundled Codex harness, which uses full host access for ordinary turns.

MCP servers have their own execution and service permissions. Restricting Codex's command sandbox does not make MCP operations read-only. Runs decline interactive approval and elicitation requests; complete authentication before using a server.

## Access and data handling

The manifest requests:

- **Process access:** launch the locally installed `codex app-server`.
- **File access:** resolve the workspace and read files for host-authorized operations such as attachments.
- **MCP access:** serve a loopback Buzz bridge bound to the admitted agent and conversation.

Buzz authorizes and signs its own operations. The plugin does not pass a private Buzz signing key to Codex. Its host-bound Buzz tool catalog is approved at the Codex layer; Buzz still enforces the agent's identity and permissions. External MCP approval policies, enabled state, transports and tool filters are preserved. The internal server name `buzz_codex_mcp` is reserved.

The plugin stores session IDs, workspace, prompt cursor and optional conversation label/time locally. It does not copy transcript bodies, normalized MCP configuration or authentication headers into that store. Codex, Buzz and MCP servers retain their own storage and data-handling behavior. Prompts, files and tool calls may reach the configured model provider and connected services. The plugin operates no separate telemetry backend.

## Limitations and troubleshooting

- Protected agents, execution targets, voice, Compact, usage reporting and a per-message model picker are not implemented.
- Each provider uses separate sessions. When switching types, supported destinations carry over instructions and custom workspace paths. Codex with MCP and the bundled Codex and Claude types share the `~/.buzz` default. Review the new provider's settings.
- Conversational turns can reuse their Codex process for up to two minutes after completion. The plugin keeps up to four idle processes and starts a fresh one on the next turn once a process is ten minutes old. Each turn gets a fresh Buzz tool connection and reloads the configured MCP servers when Codex resumes the thread. Run utilities that need to outlive a turn under a separate service manager.
- An initial visible MCP tool list may be incomplete while optional servers start. Tool discovery alone does not verify authentication or a successful call.
- In Buzz 1.0.2, changing away from native Codex can fail during the previous harness's cleanup with `thread not found`. A restart while agent work is idle, followed by retrying the Save before another native turn, resolved an observed case. This is a host-transition recovery, not a plugin session reset.
- The transcript and settings use host CSS roles with native HTML menus. Full visual parity with bundled controls is not guaranteed.

When reporting an issue, include the plugin version and Buzz revision, Buzz/Codex versions, operating system, selected execution mode and a minimal reproduction. Remove credentials and private conversation content from shared diagnostics.

## Development

Use an already installed Node.js and Codex CLI. No package installation is required:

```sh
node --check plugin.js
node --test
node scripts/smoke.mjs
```

The complete test suite uses Node's built-in runner. The integration check starts real Codex with isolated local MCP fixtures and a local model stub. It makes no external model calls and loads no user-configured MCP programs. It covers reads, publishing, approval restrictions, process reuse, fresh MCP configuration on resume, access changes and live/saved transcript reads.

## License and disclaimer

Original project code and documentation are **MIT licensed, copyright 2026 panosdigital**. See [LICENSE](LICENSE).

The `displayCommand` helper was renamed and adapted from Buzz’s `shellCommand` helper, copyright 2026 Block, Inc. It retains its Apache-2.0 license. See [NOTICE.md](NOTICE.md) for the source and changes and [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt) for the full license.

This is an independent panosdigital project. It is not affiliated with, sponsored by or endorsed by OpenAI, Block or the Buzz maintainers. Product names and marks belong to their respective owners. The plugin is provided **as is**, without warranty; it does not guarantee model output, tool behavior, compatibility, availability or third-party service access. Review the access you grant and use it only with resources you are authorized to access. The applicable license texts govern warranty and liability.

## MIT license for packaged distributions

Buzz's packed artifact includes README content, but arbitrary neighboring license files are not included automatically. The MIT license below and the Apache-2.0 license in a comment at the end of `plugin.js` accompany the code in that format.

```text
MIT License

Copyright (c) 2026 panosdigital

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
