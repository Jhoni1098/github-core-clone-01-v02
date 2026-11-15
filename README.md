# github-core-clone-01-v02 — a GitHub-compatible git forge on a journal

A standalone, GitHub-compatible git forge as one Node 22 process (stdlib only, no git binary, no
external database), built for [the contest](https://make.fun/bounty/github-core-clone-01). It serves
four surfaces over a single store: git smart HTTP v2, REST v3, GraphQL, and MCP.

Referral: **nd0791d4** — https://make.fun/r/nd0791d4

## What makes v02 different

This is the second entry for the same competition, written fresh from the kit's wire contract. Its
architecture differs from the first entry in the two places that matter:

- **Storage: one append-only journal, not one file per object.** Every mutation appends
  length-prefixed, type-tagged records to a single `journal.log` (repos, objects, refs, issues,
  pulls, comments, labels, counters) in one `writeSync` per mutation. The in-memory index is
  rebuilt by scanning the journal on boot; a torn trailing record is ignored. When the journal
  grows past 64 MiB it is compacted by rewriting it from the live state.
- **GraphQL: a schema-first resolver-table executor, not a recursive parser-executor.** The schema
  is data — types, fields and resolvers in tables — and one generic executor walks selections and
  looks every field up in the table. Introspection, fragments, variables, batching and cursor
  pagination all fall out of the tables.

The module layout differs too (`src/journal.ts`, `src/gitcore.ts`, `src/store.ts`, `src/githttp.ts`,
`src/rest.ts`, `src/graphql.ts`, `src/mcp.ts`, `src/server.ts`), as does the MCP tool organization.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own. There is nothing to install at run time: the program imports `node:http`, `node:crypto`,
`node:zlib`, `node:fs` and its own modules only, and the trial has no package manager and no
internet. (`@types/node` is a dev-only dependency for local type-checking.)

For local development, `main.ts --port <N> --data-dir <DIR>` serves standalone without
`MAKEFUN_ENV_URL` (the sdk/ runner uses this).

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does.

If `MAKEFUN_ENV_URL` is unset and no `--port` is given, `main.ts` exits 1 at once.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-OAuth-Scopes`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL: viewer, repository, node, issues/pullRequests connections, mutations, introspection |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>/info/refs`, `/git-upload-pack`, `/git-receive-pack` | git smart HTTP: v2 advertisement + ls-refs/fetch, v0 receive-pack with report-status |
| anything else | 404 `{"message":"Not Found"}` |

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Determinism

Timestamps come from a tick clock (a base epoch plus one second per tick), never from `Date.now()`,
so two runs on the same data produce the same action log. Packs are written with whole objects only
(no deltas); the trailer SHA-1 is verified on read.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above.
- `src/server.ts`: the HTTP server and routing.
- `src/store.ts`: the domain store (repos, objects, refs, issues, pulls, merges) over the journal.
- `src/journal.ts`: the append-only journal engine.
- `src/gitcore.ts`: the git object model, pack codec, pkt-line and sideband framing.
- `src/githttp.ts`: git smart HTTP (advertisements, ls-refs, fetch, receive-pack).
- `src/rest.ts`: REST v3.
- `src/graphql.ts`: GraphQL (schema tables + generic executor).
- `src/mcp.ts`: MCP (discover, initialize, tools).
- `src/scenario.ts`: the seeded scenario identities (the viewer's login, derived at runtime).
- `src/util.ts`: small shared helpers.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.
