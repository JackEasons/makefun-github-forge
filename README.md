# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/JackEasons/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/JackEasons/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process: git smart HTTP (protocol v2 and v0), the REST v3 API, GraphQL, and MCP, all served from one in-memory, content-addressed object store. No UI, no dependencies beyond the Node standard library, no git binary, no network access — it implements the whole surface itself: SHA-1 objects, packfiles, three-way merges, cursor-paginated issues and pull requests, and the six MCP tools.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry follows the make.fun lifecycle: it binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL`, and polls until the environment says the trial is done. `MAKEFUN_SHOP_TOKEN` names the bearer token the API surfaces accept; without one, any non-empty bearer token is accepted (local testing).

---

<sub>Entered on [make.fun](https://make.fun/?ref=gbg9q3ye&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
