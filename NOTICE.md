# Attribution and third-party licenses

Codex with MCP for Buzz is a panosdigital project. Original project code and
documentation are licensed under the MIT License in [LICENSE](LICENSE).

The `displayCommand` function in `plugin.js` is adapted from the `shellCommand`
helper in Block's Buzz application:

- Source: https://github.com/block/buzz-app/blob/51d63954c074e94497dc030b54a204d34b7471be/src/bundled/codex/transcript.ts
- Copyright 2026 Block, Inc.
- License: Apache License, Version 2.0, reproduced in
  [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt).
- Changes: renamed the helper and adapted it to the standalone JavaScript
  transcript formatter. Its shell-unquoting behavior is preserved.

That adapted portion retains its Apache-2.0 license. The package's combined
license expression is `MIT AND Apache-2.0`; this does not relicense the original
project code under Apache-2.0.

Buzz supplies React and the host UI styles at runtime. This repository does
not redistribute React, the Buzz application or the Codex executable. Those
projects and configured MCP servers retain their own licenses and terms.

Third-party names and marks identify compatible software. No trademark rights
or endorsement are granted by the project license.
