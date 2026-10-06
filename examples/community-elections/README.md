# Community elections

A tenant-local ranked-choice election for a community coordinator. Editors prepare a candidate slate, authenticated members submit or replace ordered preferences, and readers see aggregate rounds only after voting closes.

This is the SQLite domain selected for [research issue #6](https://github.com/andrueandersoncs/effect-domains/issues/6). Its distinguishing constraints are confidential per-account ballots, atomic replacement of an ordered collection, and an explicit vote-transfer calculation. It is not a production election system or a cryptographically anonymous ballot box: database operators can associate a ballot with its account.

## Start an isolated application

From the repository root:

```bash
bun install
bun run build
export EFFECT_DOMAINS_DEMO_PASSWORD='choose-a-local-bootstrap-password'
export COMMUNITY_ELECTIONS_DB="$(mktemp -d)/elections.sqlite"
export COMMUNITY_ELECTIONS_IDENTITY_DB="$(mktemp -d)/identity.sqlite"
bun run community-elections:server
```

Open `http://127.0.0.1:3000/`. The generated Application UI interprets the same compiled operations used by the CLI and MCP. Application and identity databases must be separate. Default files are `data/community-elections.sqlite` and `data/community-elections-identity.sqlite`.

In another terminal, use the same password and sign in:

```bash
export EFFECT_DOMAINS_DEMO_PASSWORD='choose-a-local-bootstrap-password'
export COMMUNITY_ELECTIONS_TOKEN="$(
  bun run community-elections identity.login --input-json "$(
    bun -e 'console.log(JSON.stringify({ username: "alice", password: process.env.EFFECT_DOMAINS_DEMO_PASSWORD }))'
  )" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).token)'
)"
```

Alice is an Acme editor, Bob an Acme reader, and Admin an Acme administrator. Outsider belongs to another tenant. See the [shared identity guide](../README.md#demonstration-identity) for account invitation and session controls. When changing the server port, set `COMMUNITY_ELECTIONS_URL` to its `/rpc/v1` URL; the CLI defaults to `http://127.0.0.1:3000/rpc/v1`.

## Prepare a slate and open voting

```bash
bun run community-elections election.create --input-json '{"title":"Garden coordinator"}'
```

Copy the returned election `id` into `ELECTION_ID`. A new election is `draft`, version `1`.

```bash
export ELECTION_ID='<returned UUID>'
bun run community-elections election.addCandidate --input-json "$(
  bun -e 'console.log(JSON.stringify({ electionId: process.env.ELECTION_ID, expectedVersion: 1, name: "Ada" }))'
)"
bun run community-elections election.addCandidate --input-json "$(
  bun -e 'console.log(JSON.stringify({ electionId: process.env.ELECTION_ID, expectedVersion: 2, name: "Bea" }))'
)"
bun run community-elections election.addCandidate --input-json "$(
  bun -e 'console.log(JSON.stringify({ electionId: process.env.ELECTION_ID, expectedVersion: 3, name: "Cora" }))'
)"
bun run community-elections election.slate --input-json "$(
  bun -e 'console.log(JSON.stringify({ electionId: process.env.ELECTION_ID }))'
)"
```

Each candidate addition returns the complete slate and advances the election version in the same transaction. Record the candidate UUIDs as `ADA_ID`, `BEA_ID`, and `CORA_ID`. Names are display labels, not ballot identifiers.

```bash
bun run community-elections election.open --input-json "$(
  bun -e 'console.log(JSON.stringify({ electionId: process.env.ELECTION_ID, expectedVersion: 4 }))'
)"
```

Opening requires 2–20 candidates. The open slate cannot be edited. Opening advances the version to `5` for this sequence.

## Cast and replace a ballot

A ballot ranks 1–20 distinct candidates from this election; ranking every candidate is optional. Identity supplies the voter account and tenant: callers cannot choose either.

```bash
export ADA_ID='<Ada UUID>'
export BEA_ID='<Bea UUID>'
export CORA_ID='<Cora UUID>'
bun run community-elections election.vote --input-json "$(
  bun -e 'console.log(JSON.stringify({ electionId: process.env.ELECTION_ID, ranking: [process.env.CORA_ID, process.env.BEA_ID] }))'
)"
bun run community-elections election.myBallot --input-json "$(
  bun -e 'console.log(JSON.stringify({ electionId: process.env.ELECTION_ID }))'
)"
```

Another `election.vote` call replaces the whole ballot, not just its first preference. A failed replacement preserves the previous complete ranking. One unique ballot header per tenant/election/account prevents duplicate participation. Preference rows have distinct rank and candidate constraints and scoped foreign keys to both the ballot and the candidate.

Log in as Bob or Admin to submit separate ballots. `election.myBallot` returns only the authenticated account's ranking; it accepts no account identifier. There are no ballot/preference CRUD operations, no live results, and no pre-close turnout query. Private schemas remain inspectable; inspection is not a disclosure of stored votes.

In the browser, use `Identity Login`, then **Cast or replace my ballot**. The complete-JSON input accepts the same `electionId` and ordered `ranking` array. Browser login retains its bearer only in memory.

## Close and read aggregate rounds

```bash
bun run community-elections election.close --input-json "$(
  bun -e 'console.log(JSON.stringify({ electionId: process.env.ELECTION_ID, expectedVersion: 5 }))'
)"
bun run community-elections election.result --input-json "$(
  bun -e 'console.log(JSON.stringify({ electionId: process.env.ELECTION_ID }))'
)"
```

Closing is irreversible. Votes are then immutable, and any tenant reader may obtain the election, candidates, and tally; individual ballots and voter identifiers are not included.

The application-owned instant-runoff rule is explicit:

1. Count each ballot for its highest-ranked remaining candidate.
2. A ballot with no remaining preference is exhausted and excluded from the majority denominator.
3. A candidate wins only with strictly more than half the non-exhausted votes.
4. Otherwise eliminate the single lowest-count candidate and transfer preferences in the next round.
5. If multiple candidates share the minimum, stop with `outcome: "tie"` and `tiedCandidateIds`. This may be a tie over whom to eliminate, not a tie between finalists. There is no arbitrary tie-break or inferred batch elimination.
6. An election without votes reports `outcome: "noVotes"`, no winner, and no rounds.

Candidate IDs order round counts deterministically. For example, nine ballots split Ada `4`, Bea `3`, Cora `2`, with both Cora ballots ranking Bea next, eliminate Cora and elect Bea `5–4`. Six ballots split `3/2/1`, with the last transferring to the second candidate, end in a reported `3–3` tie instead.

Stop and restart the server using the same database paths. Existing slates, account sessions, and complete ballots persist. Results remain reproducible because closed elections cannot accept ballot or slate changes.

## Observable failures

| Scenario | Result |
| --- | --- |
| Anonymous operation | `Unauthenticated` |
| Reader creates, changes, opens, or closes an election | `Forbidden` |
| Election belongs to another tenant | `ElectionNotFound` |
| Slate edit outside draft | `ElectionNotDraft` |
| Open with fewer than two candidates, or add beyond twenty | `InvalidSlate` |
| Slate/open/close uses a stale version | `VersionConflict` |
| Vote before opening or after closure | `ElectionNotOpen` |
| Repeated candidate or foreign/unknown candidate in a ranking | `InvalidRanking` |
| Empty or oversized ranking | RPC schema decoding failure |
| Own ballot has not been submitted | `BallotNotFound` |
| Result requested before closure | `ElectionNotClosed` |
| Storage fails during a write | `ElectionsUnavailable`; transaction rolls back |

## Source and derivation boundary

- [`domain.ts`](domain.ts): canonical entities, operation inputs, tally results, and domain errors; no persistence or authorization annotations.
- [`resources.ts`](resources.ts): tenant/owner policies, generated election/candidate reads, versions/transitions, and scoped relational constraints. Private ballot/preference resources publish no generated operations.
- [`sqlite.ts`](sqlite.ts): authored commands for immutable slates, versioned administration, ballot validation/replacement, own-ballot reads, and result gating.
- [`store.ts`](store.ts): schema-decoded SQLite reads, including ordered nested preference aggregation.
- [`tally.ts`](tally.ts): the application-specific vote-transfer, majority, exhaustion, and tie policy.
- [`application.ts`](application.ts): explicit parts and compilation, with native identity.
- [`migrations.ts`](migrations.ts): frozen initial artifact imports.
- [`main.ts`](main.ts): runtime identity and display-only generated-UI configuration.

Resource derivation removes ordinary storage/codec/authorization/read/transport plumbing. Ordered nested ballots and vote-transfer semantics remain authored; there is no election DSL, aggregate inference, or framework-specific collection encoding. The normalized preference rows retain domain ordering without requiring a nested-field table compiler.
