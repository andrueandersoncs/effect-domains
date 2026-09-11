# Field notes: shared reports with encrypted stored bodies

This guide files a handover report, reads it as a different role, updates it, and removes it as an administrator. The report collection is intentionally global: role checks decide what a caller may do, while an authenticated subject's tenant does not decide which reports are visible. Separately, the SQLite representation encrypts each report body with a key supplied by the server.

The one resource is `reports`. Its [canonical record](domain.ts) has an application-supplied `id`, `title`, `site`, and `body`; all four are non-empty strings. The identifier must match `report_` followed by 8 through 32 lowercase letters or digits.

## Before you start

Run all commands from the repository root with Bun installed. Install dependencies and build the prebuilt Foldkit assets before serving:

```bash
bun install
bun run build
```

Generate one new 32-byte key in unpadded Base64URL form. Save the resulting value in a password manager or another secure local secret store: this example has no key rotation or recovery workflow.

```bash
export FIELD_NOTES_ENCRYPTION_KEY="$(bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"))')"
```

Start a disposable instance in the **server terminal**. The encryption key and required bootstrap identity settings must be in this process's environment; keep the identity database physically separate from the field-notes database:

```bash
export PORT=3002
export FIELD_NOTES_DB="$(mktemp -d)/field-notes.sqlite"
export EFFECT_DOMAINS_IDENTITY_DB="$(mktemp -d)/field-notes-identity.sqlite"
export EFFECT_DOMAINS_DEMO_PASSWORD='choose-a-local-bootstrap-password'
bun run field-notes:server
```

In a separate **client terminal**, configure the endpoint and issue the editor, reader, outsider, and administrator credentials used below:

```bash
export FIELD_NOTES_URL=http://127.0.0.1:3002/rpc/v1
export DEMO_PASSWORD='choose-a-local-bootstrap-password' # same value used by the server
issue_notes_token() {
  bun run field-notes identity.login --input-json "$(
    bun -e 'const [username, password] = process.argv.slice(2); if (!password) throw new Error("DEMO_PASSWORD is required"); console.log(JSON.stringify({ username, password }))' "$1" "$DEMO_PASSWORD"
  )" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).token)'
}
export FIELD_NOTES_TOKEN="$(issue_notes_token alice)"
export BOB_TOKEN="$(issue_notes_token bob)"
export OUTSIDER_TOKEN="$(issue_notes_token outsider)"
export ADMIN_TOKEN="$(issue_notes_token admin)"
```

The client does not receive the encryption key; the server's storage codec encrypts and decrypts bodies. Tokens are secret, per-call bearer credentials. `identity.current` reports the verified subject and expiry; `identity.logout` revokes the selected session. Accounts bootstrap only once and sessions expire after the configured lifetime; see [example identity](../README.md#example-identity).

## Run it

Alice files a report and retrieves a site-filtered page:

```bash
bun run field-notes reports.create --input-json '{"id":"report_pump7handover","title":"Pump 7 pressure-test handover","site":"North Yard","body":"Gauge held 180 psi for ten minutes. Attach the site-tablet photo before closing the work order."}'
bun run field-notes reports.list --input-json '{"filter":{"site":"North Yard"},"limit":10}'
```

Creation and reads use canonical plaintext JSON. The returned report has the same `body` string; ciphertext is a storage concern and is never CLI input or output. Empty `title`, `site`, or `body`, or an identifier outside the required pattern, is rejected. For example:

```bash
bun run field-notes reports.create --input-json '{"id":"report_BAD","title":"Bad identifier","site":"North Yard","body":"This request is invalid."}'
```

The command exits nonzero and does not create a report.

### Read globally, authorize by role

Bob is a reader. He can read the report Alice created even though he is not its owner—reports have no owner field—and he can see it regardless of tenant-based partitioning:

```bash
FIELD_NOTES_TOKEN="$BOB_TOKEN" bun run field-notes reports.get --input-json '{"id":"report_pump7handover"}'
FIELD_NOTES_TOKEN="$BOB_TOKEN" bun run field-notes reports.create --input-json '{"id":"report_northyardsurvey","title":"Denied survey","site":"North Yard","body":"A reader cannot file reports."}'
FIELD_NOTES_TOKEN="$OUTSIDER_TOKEN" bun run field-notes reports.get --input-json '{"id":"report_pump7handover"}'
```

Both get commands return the full report, including plaintext body. The attempted reader create exits nonzero with `Forbidden`. The issued `outsider` session is an editor in a different tenant but can also list, get, create, and update this global collection. Editors and administrators have create/update access; only administrators have remove access. Missing, expired, revoked, or unknown bearer credentials fail with `Unauthenticated`.

The exported mutation for an existing report is **`reports.update`**, not `reports.patch`. Update requires a complete replacement record, including the unchanged identifier:

```bash
bun run field-notes reports.update --input-json '{"id":"report_pump7handover","title":"Pump 7 pressure-test handover","site":"North Yard","body":"Gauge held 180 psi for ten minutes. Photo attached to the work order."}'
FIELD_NOTES_TOKEN="$ADMIN_TOKEN" bun run field-notes reports.remove --input-json '{"id":"report_pump7handover"}'
```

The update succeeds for Alice; the administrator remove succeeds and returns no value. `reports.get`, `.list`, `.create`, `.update`, and `.remove` are the published generated operations. The resource's local repository has a patch method, but this application does **not** export `reports.patch`; do not assume a generic partial-update endpoint.

### Page filtered reports

`reports.list` accepts only an equality `filter.site`, an opaque `cursor`, and `limit`. The configured limit is both the default and maximum: omission returns up to 50 reports and the accepted explicit range is 1 through 50. Results are identifier-ascending and return `{ "items": [...], "nextCursor": string | null }`.

To see cursor use with a fresh report database, create two distinct matching reports, then ask for one at a time:

```bash
bun run field-notes reports.create --input-json '{"id":"report_northyardsurvey","title":"North Yard survey","site":"North Yard","body":"Drainage cover inspected."}'
bun run field-notes reports.create --input-json '{"id":"report_northyardsafety","title":"North Yard safety check","site":"North Yard","body":"Access route clear."}'
bun run field-notes reports.list --input-json '{"filter":{"site":"North Yard"},"limit":1}'
```

Copy a non-null `nextCursor` exactly into the client terminal, then keep the filter identical:

```bash
export REPORT_CURSOR='paste-the-returned-nextCursor-here'
bun run field-notes reports.list --input-json "{\"filter\":{\"site\":\"North Yard\"},\"limit\":1,\"cursor\":\"$REPORT_CURSOR\"}"
```

An undeclared filter (including `title`), a malformed cursor, a cursor made for different filters, or a limit greater than 50 is rejected. There is no owner/tenant filter, text search, custom ordering, unbounded list, attachment, geospatial validation, offline synchronization, or report workflow state.

## Browser, admin, and MCP

Open [http://127.0.0.1:3002/](http://127.0.0.1:3002/) for the hand-authored Foldkit report page. It starts signed out; use its login form with a seeded account password. The page uses the canonical native RPC client and retains the issued bearer token only in memory. It lists title, site, and identifier; **Open** fetches the full report and fills the edit form, while **File report** calls `reports.create` and **Save changes** calls full `reports.update`. Its form trims the identifier, title, site, and body, and shows field-specific validation failures.

**Load more** appends later site-filtered pages. Changing the site filter or identity clears rows and invalidates stale requests; server authorization remains authoritative.

The same server exposes generated admin at [http://127.0.0.1:3002/admin](http://127.0.0.1:3002/admin) and Streamable HTTP MCP at `http://127.0.0.1:3002/mcp`. Paste a real issued credential into admin; MCP tools likewise use the same policy and arguments `{ "input": <RPC payload> }`.

## Encryption, persistence, and settings

Only the stored `body` field is transformed. [`storage.ts`](storage.ts) JSON-encodes the canonical string and encrypts it with AES-256-GCM using a fresh random 96-bit nonce. SQLite holds a canonical Base64URL envelope:

```text
v1.<nonce>.<ciphertext-and-tag>
```

The `id`, `title`, and `site` columns remain plaintext so identifier lookup and the declared site filter work. On decode, the storage codec requires the `v1` shape, canonical Base64URL parts, a 96-bit nonce, an authentication tag, successful AES-GCM authentication with the configured key, valid UTF-8, and a JSON string. A modified body, malformed envelope, or wrong key therefore fails to decode; it does not yield unauthenticated text.

This is field-level at-rest protection for bodies only. It is not whole-database or backup encryption, key management, audit logging, access control, or a replacement for role checks. Read authorization still decides who may request the plaintext report.

| Setting | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `FIELD_NOTES_ENCRYPTION_KEY` | required | server | unpadded Base64URL encoding of exactly 32 bytes for AES-256-GCM |
| `FIELD_NOTES_DB` | `data/field-notes.sqlite` | server | SQLite database path |
| `EFFECT_DOMAINS_IDENTITY_DB` | `data/identity.sqlite` | server | Separate SQLite identity store |
| `EFFECT_DOMAINS_DEMO_PASSWORD` | required | server | Bootstrap password for the seed accounts |
| `PORT` | `3000` | server | loopback HTTP port |
| `FIELD_NOTES_URL` | `http://127.0.0.1:3000/rpc/v1` | CLI | RPC endpoint |
| `FIELD_NOTES_TOKEN` | unset | CLI | bearer token sent to each RPC call |

Server startup rejects a missing key, a padded/noncanonical Base64URL value, a value other than 32 bytes, or material that cannot be imported as AES-GCM. To restart against the same database, provide the **same** key. A different syntactically valid key can open the database but cannot authenticate existing body ciphertext when it is read; a lost old key makes those stored bodies unavailable to this example. Real key rotation requires an explicit authenticated data migration, which this application does not implement.

[`001_initial`](migrations/001_initial.json) is a fresh field-report history. Its imported [migration list](migrations.ts) is tracked at startup; an old prefix-encoded note database is deliberately incompatible and rejected rather than guessed. Export and validate old data, then import canonical reports under the chosen key. The server binds to `127.0.0.1`, and changing `PORT` does not change `FIELD_NOTES_URL`.

Inspection is local and needs no server, token, or encryption key:

```bash
bun run field-notes inspect reports.create
```

For common RPC, page, endpoint, and failure contracts, see the [runtime reference](../../docs/reference/runtime.md) and [resource reference](../../docs/reference/resources.md). The global role policy and exported operation set are in [`resources.ts`](resources.ts); encryption is in [`storage.ts`](storage.ts); the server provisions the encryption service, Foldkit route, and admin in [`main.ts`](main.ts); and browser behavior is in [`web/main.ts`](web/main.ts).

[All examples](../README.md) · [Team tasks: tenant-owned work](../team-tasks/README.md)
