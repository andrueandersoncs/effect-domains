# Purchased guides

Read the guide that a demo account has already unlocked, then observe why a visible locked guide and an out-of-tenant guide fail differently. This application evaluates a current, persisted purchase status at read time; it does not implement checkout or payment processing.

[All examples](../README.md)

## Run it

Run the commands from the repository root. The server serves a Foldkit frontend, so `bun run build` is required even though this application has no generated admin. The timestamped database below is disposable walkthrough state; use a different fresh path when repeating the seed behavior.

**Server terminal**

```bash
bun install
bun run build
export PURCHASED_GUIDES_DB="$PWD/purchased-guides-walkthrough-$(date +%s).sqlite"
export EFFECT_DOMAINS_IDENTITY_DB="$PWD/purchased-guides-identity-$(date +%s).sqlite"
export EFFECT_DOMAINS_DEMO_PASSWORD='choose-a-local-bootstrap-password'
PORT=3003 bun run purchased-guides:server
```

The loopback server is now at `http://127.0.0.1:3003`: its RPC endpoint is `/rpc/v1`, its Streamable HTTP MCP endpoint is `/mcp`, and the frontend is at `/`. There is no `/admin` route for this application. `EFFECT_DOMAINS_IDENTITY_DB` must be distinct from `PURCHASED_GUIDES_DB`; the required bootstrap password does not reset the accounts when the server restarts.

**Client terminal**

```bash
export PURCHASED_GUIDES_URL=http://127.0.0.1:3003/rpc/v1
export DEMO_PASSWORD='choose-a-local-bootstrap-password' # same value used by the server
export PURCHASED_GUIDES_TOKEN="$(
  bun run purchased-guides identity.login --input-json "$(
    bun -e 'const password = process.env.DEMO_PASSWORD; if (!password) throw new Error("DEMO_PASSWORD is required"); console.log(JSON.stringify({ username: "bob", password }))'
  )" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).token)'
)"
```

Bob is the seeded purchase holder in Acme. The issued value is a secret bearer credential, not an input field; `tenantId` and `userId` in a request cannot create or change access. `identity.current` shows the verified subject and expiry, and `identity.logout` revokes the active credential. Sessions expire and accounts bootstrap once; see [example identity](../README.md#example-identity).

## Read the seeded guide

The fresh database seeds three guides and one purchase: Bob in Acme has a `granted` purchase for `guide-sql-basics`. Request it with the exact intrinsic guide id:

```bash
bun run purchased-guides guides.get --input-json '{"id":"guide-sql-basics"}'
```

The response is the complete guide object with keys `id`, `tenantId`, `title`, `summary`, and `body`. It identifies the SQL field guide in tenant `acme`. This success proves tenant visibility and the persisted per-guide entitlement passed; roles alone do not grant a purchase.

The two neighboring requests show the order of the checks:

```bash
# Visible to Bob's tenant, but Bob has no matching granted purchase.
bun run purchased-guides guides.get --input-json '{"id":"guide-audit-trails"}'

# Stored in tenant "other", so it is hidden before its entitlement is considered.
bun run purchased-guides guides.get --input-json '{"id":"guide-other-tenant"}'
```

The audit-trail request fails with `EntitlementRequired` for `guides.read`. The other-tenant request fails with `ResourceNotFound`, not a disclosure of its title or purchase state. A missing or unknown bearer credential instead fails with `Unauthenticated`.

Now request the only generated list operation:

```bash
bun run purchased-guides guides.list --input-json '{}'
```

This request fails with `EntitlementRequired`. Both Acme guides enter Bob's tenant-visible page, but `guide-audit-trails` lacks Bob's grant. Entitlements are checked for every row in the page; the list is not silently filtered down to the guide that Bob can open. `guides.list` accepts only the standard optional `limit` and `cursor` fields—no equality filters—and its configured limit is 25 as both default and maximum. It returns `{ "items": [...], "nextCursor": string | null }` only when every row in that page passes. A non-null cursor can be returned unchanged; the browser appends it with **Load more**.

## How access is resolved

A guide read requires all of the following:

1. A trusted subject with role `reader`, `editor`, or `admin`.
2. A guide whose `tenantId` equals that subject's `tenantId`.
3. A `guide_purchases` row whose `tenantId`, `userId`, and `guideId` exactly match that subject and requested guide, with `status: "granted"`.

The entitlement resolver queries the database each time it checks a guide. `refunded` and `revoked` status values do not grant access. The seed routine uses `INSERT … WHERE NOT EXISTS` for each guide/purchase identifier, so it creates its facts only when absent and never turns a preserved refund or revocation back into `granted` on restart. There is no public grant, refund, revoke, create, update, patch, or remove operation: `guide_purchases` is registered with `Authorization.deny` and publishes no operations. This is an application-owned entitlement demonstration, not a payment-provider simulation, checkout flow, or general purchase-management API.

The seed contains the following initial facts:

| Kind | Identifier | Tenant | Current detail |
| --- | --- | --- | --- |
| Guide | `guide-sql-basics` | `acme` | SQL field guide; Bob has `purchase-bob-sql-basics` with `granted` status |
| Guide | `guide-audit-trails` | `acme` | Audit trail guide; no seeded grant for Bob |
| Guide | `guide-other-tenant` | `other` | Hidden from Acme subjects |

Alice and Admin have valid issued Acme credentials but no seeded purchase; neither can open a guide solely by role. The issued `outsider` session is Alice in tenant `other`; it can pass role/tenant policy for the other-tenant guide but has no seeded grant, so its read fails with `EntitlementRequired`.

## Browser and MCP

Open `http://127.0.0.1:3003/` to use the frontend. It starts signed out; use the login UI with a seeded account password. The page uses the canonical native client and retains the issued bearer token only in memory. After sign-in, select an unlocked, locked, or hidden guide ID and load it; list errors remain visible rather than treating a locked row as absent. **Load more** appends a returned cursor page. Changing identity clears the prior guide, list, and stale request state.

There is no generated admin, but MCP is available at `http://127.0.0.1:3003/mcp`. The generated resource tools are the read-only `guides.get` and `guides.list`; the composed identity group also exposes `identity.login`, `identity.current`, and `identity.logout`. Pass tool arguments as `{ "input": <operation JSON> }`, using `{ "input": null }` for current/logout. A protected MCP call needs the same issued bearer credential on every request. `/rpc/v1` and `/mcp` are RPC endpoints, not REST APIs.

## Storage and source map

| Setting | Default | Use |
| --- | --- | --- |
| `PURCHASED_GUIDES_DB` | `data/purchased-guides.sqlite` | Server SQLite database |
| `PORT` | `3000` | Loopback server port |
| `PURCHASED_GUIDES_URL` | `http://127.0.0.1:3000/rpc/v1` | CLI RPC endpoint |
| `PURCHASED_GUIDES_TOKEN` | unset | CLI bearer token |
| `EFFECT_DOMAINS_IDENTITY_DB` | `data/identity.sqlite` | Server identity database; must differ from guide data |
| `EFFECT_DOMAINS_DEMO_PASSWORD` | required | Bootstrap password for seeded example accounts |

Startup decodes and applies the frozen [migration history](migrations.ts), then runs the idempotent seed routine. It preserves rows; restarts do not reset entitlement state. The runtime rejects an untracked or drifted database rather than adopting it, so choose a fresh `PURCHASED_GUIDES_DB` for a clean walkthrough. The [initial artifact](migrations/001_initial.json) defines the `guides` and private `guide_purchases` tables.

- [`domain.ts`](domain.ts): intrinsic guide identifiers, guide fields, and purchase-status values.
- [`resources.ts`](resources.ts): role/tenant policy, `guides.read` requirement, read-only guide operations, and the private purchase resource.
- [`entitlements.ts`](entitlements.ts): current-status lookup and restart-safe seed facts.
- [`application.ts`](application.ts): the two registered resources.
- [`main.ts`](main.ts): identity, entitlement service, initialization, frontend route, migrations, and runner.
- [`web/main.ts`](web/main.ts): native frontend requests, signed-in guide choices, and cursor navigation.
- [Resource reference](../../docs/reference/resources.md): protected generated reads, all-or-nothing entitlement pages, and cursor/list rules.
- [Runtime reference](../../docs/reference/runtime.md): loopback runtime, CLI, RPC, and migration behavior.
