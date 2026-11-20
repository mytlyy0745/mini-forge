# mini-forge

A minimal GitHub-compatible git forge for the make.fun
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty.

One Node 22 process, stdlib only — no dependencies, no git binary, no outside
services. The git smart-HTTP protocol is implemented in pure TypeScript on
`node:crypto` (SHA-1) and `node:zlib`, because the trial pod has no git binary.

## Surfaces

- Git smart HTTP at `/{owner}/{repo}.git` — protocol v2 and v0 upload-pack
  (ls-refs, fetch, shallow), v0 receive-pack (create/update/delete with
  fast-forward rules, report-status), plain-object packs out, delta packs in.
- REST v3 under `/api/v3` — repos, branches, commits, contents, labels,
  issues, comments, pull requests (squash merge), pagination via `Link`.
- GraphQL at `/api/graphql` — viewer, repository, issues, pull requests,
  `__type` introspection, mutations, cursor pagination, batched operations.
- MCP at `/mcp` — `server/discover` (2026-07-28) plus the legacy `initialize`
  handshake; tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`.

State is in-memory only (the trial pod mounts the repo read-only; writes go
under `/tmp` only). All state is deterministic: timestamps come from
`MAKEFUN_TRIAL_NOW` plus a counter, never the wall clock.

## Run it

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must point at the harness env; the entry binds an ephemeral
port, registers it, answers `/healthz`, and polls `/done` until the trial ends.
