# Codex with MCP for Buzz

A **panosdigital** plugin that runs local [Codex](https://github.com/openai/codex) agents in [Buzz](https://buzz.xyz) with the MCP servers already configured for Codex.

## Features

- Use enabled local and remote Codex MCP servers with their configured authentication and tool restrictions.
- Reply through Buzz tools under the agent's own identity and permissions.
- Choose a model and supported reasoning effort from the local Codex catalog.
- Set thinking effort from Buzz’s composer without changing the agent’s saved settings.
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

## Install from Git

1. In Buzz Desktop, open **Settings → Plugins → Manage plugins → Add**.
2. In **Git or GitHub repository**, enter `https://github.com/panosdigital/buzz-plugin-codex-with-mcp`. Leave **Branch or tag** blank to follow `main`, or enter a tag from [GitHub Releases](https://github.com/panosdigital/buzz-plugin-codex-with-mcp/releases) to install that release.
3. Review the process, file and MCP access, then confirm installation and enable the plugin.
4. Create an agent with the **Codex with MCP** type. Choose its workspace and instructions, then ask it for a read-only action using one of your configured MCP servers.

For an existing Git installation, use **Check for updates** in the plugin's settings.

## Install from a local folder

Download and extract a source archive from [GitHub Releases](https://github.com/panosdigital/buzz-plugin-codex-with-mcp/releases).

1. Obtain a reviewed source folder containing `manifest.json`, `plugin.js` and `README.md`.
2. In Buzz, open **Settings → Plugins → Manage plugins → Add → Browse** and select that folder.
3. Review the process, file and MCP grants, then confirm installation.
4. Create a test agent and select **Codex with MCP**. Set its Workspace directory and instructions.
5. Keep Model and Thinking on their Default choices to inherit local Codex settings, or select explicit values.
6. Ask for one harmless read through an MCP server you already use, then verify the result and Buzz reply.

Use **Browse** to retain a reloadable source-folder link. Buzz's normal install review owns permissions and activation.

Development and public builds use plugin ID `digital.panos.buzz-plugin-codex-with-mcp` and agent type `digital.panos.buzz-plugin-codex-with-mcp/codex-mcp`. Both use the same local session-storage namespace, `digital.panos.buzz-plugin-codex-with-mcp/session/`.

## Thinking controls in the composer

When you mention one of your Codex with MCP agents, open the composer’s model and effort controls to pick a thinking level for its current model. Ordinary messages apply the choice to the next run. Solo chats remember their choice until you reset it. Set the agent’s model and default thinking level in its Identity settings.

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

- Protected agents, execution targets, voice, Compact and usage reporting are not implemented.
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

## Licenses for packaged distributions

The license texts below accompany the code in Buzz’s packed plugin.

### MIT License

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

### Apache License 2.0

<details>
<summary>Full license text for the adapted displayCommand helper</summary>

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

Copyright 2026 Block, Inc.

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

</details>
