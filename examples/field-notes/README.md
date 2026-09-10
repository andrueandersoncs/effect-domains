# Field notes: shared field reports with encrypted stored bodies

This application records shared field reports. A report has a constrained application-supplied identifier, a non-empty title, a non-empty site, and a non-empty body. Readers, editors, and administrators collaborate globally: readers can list and read reports, editors can also create and update them, and administrators can also remove them. The policy is intentionally global rather than tenant-scoped, making a field report useful to every authenticated member of the response team.

The canonical and wire records always contain plaintext `title`, `site`, and `body`. [`storage.ts`](storage.ts) replaces only the physical `body` field with a runtime service-dependent AES-256-GCM codec. SQLite stores a versioned `v1.<nonce>.<ciphertext-and-tag>` Base64URL envelope. The random 96-bit nonce and GCM authentication tag make a changed byte, wrong key, malformed envelope, invalid UTF-8, or non-string decoded payload fail decoding; the codec never strips text or returns unauthenticated bytes.

The codec JSON-encodes the canonical string before encryption so every `Schema.String` value, including a lone UTF-16 surrogate, round-trips exactly. `id`, `title`, and `site` remain plaintext columns so the generated identifier lookup and site filter work. This is field-level at-rest protection only: it is not full-database encryption, key management, backup encryption, audit logging, or an access-control replacement. The generated role policy remains responsible for who may request plaintext.

## Run a handover report

Create one stable 32-byte Base64URL key and keep it for the lifetime of the database:

```bash
export FIELD_NOTES_ENCRYPTION_KEY="$(bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"))')"
```

Start the server from the repository root:

```bash
bun run field-notes:server
```

Alice is an editor and can write a handover report:

```bash
export FIELD_NOTES_TOKEN=alice-demo
bun run field-notes reports.create --input-json '{"id":"report_pump7handover","title":"Pump 7 pressure-test handover","site":"North Yard","body":"Gauge held 180 psi for ten minutes. Attach the site-tablet photo before closing the work order."}'
bun run field-notes reports.list --input-json '{"filter":{"site":"North Yard"},"limit":10}'
```

Bob is a reader and can retrieve the same report but cannot create one:

```bash
FIELD_NOTES_TOKEN=bob-demo bun run field-notes reports.get --input-json '{"id":"report_pump7handover"}'
FIELD_NOTES_TOKEN=bob-demo bun run field-notes reports.create --input-json '{"id":"report_northyardsurvey","title":"Denied survey","site":"North Yard","body":"Reader cannot submit reports."}'
```

The second Bob command exits nonzero with `Forbidden`. An administrator can remove the report:

```bash
FIELD_NOTES_TOKEN=admin-demo bun run field-notes reports.remove --input-json '{"id":"report_pump7handover"}'
```

The identifier must match `report_` followed by 8 to 32 lowercase letters or digits. Generated list accepts only `filter.site`, `limit`, and an opaque cursor; it returns bounded `{ items, nextCursor }` pages ordered by identifier. The example deliberately has no per-report ownership, tenant membership, attachments, geospatial validation, offline synchronization, or workflow state.

## Runtime, key provisioning, and persistence

| Setting | Default | Meaning |
| --- | --- | --- |
| `FIELD_NOTES_ENCRYPTION_KEY` | required | Unpadded Base64URL encoding of exactly 32 random bytes |
| `FIELD_NOTES_DB` | `field-notes.sqlite` | SQLite database file used by the server |
| `FIELD_NOTES_URL` | `http://127.0.0.1:3000/rpc/v1` | RPC endpoint used by the CLI |
| `FIELD_NOTES_TOKEN` | unset | Demo bearer token sent by the CLI |
| `PORT` | `3000` | Loopback HTTP port |

Startup fails if the encryption key is absent, not Base64URL, not 32 bytes, or cannot be imported as AES-GCM. Do not change the key for an existing database: the old report bodies cannot be authenticated or decrypted with a new key. A real key rotation needs an explicit, authenticated data migration; this small example does not implement one.

Use different database, server, endpoint, and key values when running beside another instance:

```bash
PORT=3001 FIELD_NOTES_DB=field-notes-demo.sqlite bun run field-notes:server
FIELD_NOTES_URL=http://127.0.0.1:3001/rpc/v1 FIELD_NOTES_TOKEN=bob-demo bun run field-notes reports.list
```

[`001_initial`](migrations/001_initial.json) is a fresh history for the replacement field-report domain and its encrypted body representation. Existing prefix-encoded note databases are deliberately incompatible: export and validate real note data, then import it through the canonical report API under the configured key. Startup rejects an untracked old database rather than guessing at its contents.

Inspection is local and needs no server, token, or key:

```bash
bun run field-notes inspect reports.create
```

See the [examples overview](../README.md), [team task ownership rules](../team-tasks/README.md), and [expense-ledger](../README.md#expense-ledger).
