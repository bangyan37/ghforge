# ghforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bangyan37/ghforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bangyan37/ghforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process, standard library only — no git binary, no dependencies. It serves git smart HTTP (protocol v2 ls-refs and fetch with shallow/deepen, v0 fetch, and receive-pack with report-status and per-ref non-fast-forward refusal), the REST v3 surface (repositories, branches, commits, contents, labels, issues, comments, pull requests with files and squash/merge merges), GraphQL v4 (the documents gh and github-mcp-server send, with cursor pagination and opaque global ids), and a streamable-HTTP MCP endpoint whose six tools act on the same store as REST. All state lives in one in-memory object store per repository, so an object created through any surface is the same object through all of them. The kit's own conformance suite passes 120/120 against it locally, with 188/200 on the calibrated benchmark workloads.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=z0d47ycp&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
