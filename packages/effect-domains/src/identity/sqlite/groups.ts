import { randomBytes } from "node:crypto"
import { Array, Effect, Equivalence, Layer, Schema, Struct } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { Forbidden } from "../../authorization/model.ts"
import { identifier } from "../../domain.ts"
import { AccountUsernameRowSchema, type AccountUsernameRow, database, unavailable } from "../database.ts"

import {
  AccountNotFound, AlreadyMember, GroupNotFound, GroupRecord, GroupRuntime, MemberNotFound,
  type GroupActor,
} from "../groups/index.ts"

import { Table } from "../../table/index.ts"

const IdSchema = identifier(Schema.String)

// The full account table belongs to SqliteIdentity because importing it here would cycle through GroupTables.
const AccountReferenceSchema = Schema.Struct({ username: identifier(Schema.String) })

interface AccountReference extends Schema.Schema.Type<typeof AccountReferenceSchema> {}

const AccountReference = Table.make({ name: "identity_accounts", schema: AccountReferenceSchema })
const AccountKey = Table.reference(AccountReference, [AccountReference.identifier])

const GroupsTableSchema = Schema.Struct({ id: IdSchema, tenant_id: Schema.String, name: Schema.String })

interface GroupsTable extends Schema.Schema.Type<typeof GroupsTableSchema> {}

const Groups = Table.make({
  name: "identity_groups",
  schema: GroupsTableSchema,
  relations: { indexes: [{ name: "identity_groups_tenant", fields: ["tenant_id"] }] },
})

const GroupKey = Table.reference(Groups, [Groups.identifier])
const GroupLinkFields = { id: IdSchema, group_id: Schema.String }

const MembershipsTableSchema = Schema.Struct({ ...GroupLinkFields, username: Schema.String })

interface MembershipsTable extends Schema.Schema.Type<typeof MembershipsTableSchema> {}

const Memberships = Table.make({
  name: "identity_group_memberships",
  schema: MembershipsTableSchema,
  relations: {
    unique: [{ name: "identity_group_memberships_group_user", fields: ["group_id", "username"] }],
    foreignKeys: [
      { name: "identity_group_memberships_group_fkey", fields: ["group_id"], references: GroupKey },
      { name: "identity_group_memberships_account_fkey", fields: ["username"], references: AccountKey },
    ],
    indexes: [{ name: "identity_group_memberships_user", fields: ["username"] }],
  },
})

const AccountGrantsTableSchema = Schema.Struct({
  id: IdSchema, tenant_id: Schema.String, username: Schema.String, permission: Schema.String,
})

interface AccountGrantsTable extends Schema.Schema.Type<typeof AccountGrantsTableSchema> {}

const AccountGrants = Table.make({
  name: "identity_account_grants",
  schema: AccountGrantsTableSchema,
  relations: {
    unique: [{ name: "identity_account_grants_tenant_user_permission", fields: ["tenant_id", "username", "permission"] }],
    foreignKeys: [{ name: "identity_account_grants_account_fkey", fields: ["username"], references: AccountKey }],
    indexes: [{ name: "identity_account_grants_user", fields: ["username", "tenant_id"] }],
  },
})

const GroupGrantsTableSchema = Schema.Struct({ ...GroupLinkFields, permission: Schema.String })

interface GroupGrantsTable extends Schema.Schema.Type<typeof GroupGrantsTableSchema> {}

const GroupGrants = Table.make({
  name: "identity_group_grants",
  schema: GroupGrantsTableSchema,
  relations: {
    unique: [{ name: "identity_group_grants_group_permission", fields: ["group_id", "permission"] }],
    foreignKeys: [{ name: "identity_group_grants_group_fkey", fields: ["group_id"], references: GroupKey }],
  },
})

export const GroupTables = [Groups, Memberships, AccountGrants, GroupGrants] as const

const freshId = Effect.try({ try: () => randomBytes(24).toString("base64url"), catch: unavailable })
const missingGroup = () => GroupNotFound.make({})
const accountMissing = () => AccountNotFound.make({})

const deny = Effect.fn("Group.deny")(function* () {
  return yield* Forbidden.make({})
})

const admin = (actor: GroupActor) => actor.admin ? Effect.void : deny()

const selfOrAdmin = (actor: GroupActor, username: string) => {
  const isSelf = Equivalence.strictEqual<string>()(actor.username, username)

  return actor.admin || isSelf ? Effect.void : deny()
}

const PermissionRowSchema = Schema.Struct({ permission: Schema.String })

interface PermissionRow extends Schema.Schema.Type<typeof PermissionRowSchema> {}

const UsernameRowsSchema = Schema.Array(AccountUsernameRowSchema)
const PermissionRowsSchema = Schema.Array(PermissionRowSchema)

const decodePermissions = Effect.fn("Group.decodePermissions")(function* (rows: unknown) {
  const decoded = Schema.decodeUnknownEffect(PermissionRowsSchema)(rows)
  const grants: ReadonlyArray<PermissionRow> = yield* database(decoded)

  return Array.map(grants, Struct.get("permission"))
})

const makeGroupRuntime = (sql: SqlClient.SqlClient) => {
  const group = Effect.fn("Group.group")(function* (actor: GroupActor, id: string) {
    const found = yield* database(sql`SELECT 1 FROM identity_groups WHERE id = ${id} AND tenant_id = ${actor.tenantId} LIMIT 1`)

    if (Equivalence.strictEqual<number>()(found.length, 0)) return yield* missingGroup()
  })

  const account = Effect.fn("Group.account")(function* (actor: GroupActor, username: string) {
    const found = yield* database(sql`
      SELECT 1 FROM identity_accounts WHERE username = ${username} AND disabled = 0
        AND json_extract(subject_json, '$.tenantId') = ${actor.tenantId} LIMIT 1
    `)

    if (Equivalence.strictEqual<number>()(found.length, 0)) return yield* accountMissing()
  })

  const membership = Effect.fn("Group.membership")(function* (actor: GroupActor, id: string) {
    const found = yield* database(sql`
      SELECT 1 FROM identity_group_memberships WHERE group_id = ${id} AND username = ${actor.username} LIMIT 1
    `)

    if (found.length > 0) return

    return yield* deny()
  })

  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const pending = sql.withTransaction(effect)

    return Effect.catchIf(pending, SqlError.isSqlError, unavailable)
  }

  return GroupRuntime.of({
    create: Effect.fn("Group.create")(function* (actor, name) {
      yield* admin(actor)

      const id = yield* freshId

      yield* database(sql`INSERT INTO identity_groups (id, tenant_id, name) VALUES (${id}, ${actor.tenantId}, ${name})`)

      return GroupRecord.make({ id, name })
    }),
    update: Effect.fn("Group.update")(function* (actor, id, name) {
      yield* admin(actor)

      const changed = yield* database(sql`
        UPDATE identity_groups SET name = ${name} WHERE id = ${id} AND tenant_id = ${actor.tenantId} RETURNING id
      `)

      if (Equivalence.strictEqual<number>()(changed.length, 0)) return yield* missingGroup()
    }),
    delete: Effect.fn("Group.delete")(function* (actor, id) {
      yield* admin(actor)

      const mutation = Effect.gen(function* () {
        yield* group(actor, id)
        yield* database(sql`DELETE FROM identity_group_grants WHERE group_id = ${id}`)
        yield* database(sql`DELETE FROM identity_group_memberships WHERE group_id = ${id}`)
        yield* database(sql`DELETE FROM identity_groups WHERE id = ${id} AND tenant_id = ${actor.tenantId}`)
      })

      yield* transaction(mutation)
    }),
    listMembers: Effect.fn("Group.listMembers")(function* (actor, id) {
      if (!actor.admin) {
        yield* membership(actor, id)
      }

      yield* group(actor, id)

      const rows = yield* database(sql`
        SELECT member.username FROM identity_group_memberships AS member
        JOIN identity_accounts AS account ON account.username = member.username AND account.disabled = 0
        WHERE member.group_id = ${id} AND json_extract(account.subject_json, '$.tenantId') = ${actor.tenantId}
        ORDER BY member.username
      `)

      const decoded = Schema.decodeUnknownEffect(UsernameRowsSchema)(rows)
      const members: ReadonlyArray<AccountUsernameRow> = yield* database(decoded)

      return Array.map(members, Struct.get("username"))
    }),
    isMember: Effect.fn("Group.isMember")(function* (actor, id, username) {
      yield* selfOrAdmin(actor, username)
      yield* group(actor, id)
      yield* account(actor, username)

      const found = yield* database(sql`
        SELECT 1 FROM identity_group_memberships WHERE group_id = ${id} AND username = ${username} LIMIT 1
      `)

      return found.length > 0
    }),
    addMember: Effect.fn("Group.addMember")(function* (actor, id, username) {
      yield* admin(actor)

      const mutation = Effect.gen(function* () {
        yield* group(actor, id)
        yield* account(actor, username)

        const newId = yield* freshId

        const inserted = yield* database(sql`
          INSERT INTO identity_group_memberships (id, group_id, username)
          VALUES (${newId}, ${id}, ${username}) ON CONFLICT(group_id, username) DO NOTHING RETURNING id
        `)

        if (Equivalence.strictEqual<number>()(inserted.length, 0)) return yield* AlreadyMember.make({})
      })

      yield* transaction(mutation)
    }),
    removeMember: Effect.fn("Group.removeMember")(function* (actor, id, username) {
      yield* admin(actor)

      const mutation = Effect.gen(function* () {
        yield* group(actor, id)

        const removed = yield* database(sql`
          DELETE FROM identity_group_memberships WHERE group_id = ${id} AND username = ${username} RETURNING id
        `)

        if (Equivalence.strictEqual<number>()(removed.length, 0)) return yield* MemberNotFound.make({})
      })

      yield* transaction(mutation)
    }),
    grantAccount: Effect.fn("Group.grantAccount")(function* (actor, username, permission) {
      yield* admin(actor)

      const mutation = Effect.gen(function* () {
        yield* account(actor, username)

        const id = yield* freshId

        yield* database(sql`
          INSERT INTO identity_account_grants (id, tenant_id, username, permission)
          VALUES (${id}, ${actor.tenantId}, ${username}, ${permission})
          ON CONFLICT(tenant_id, username, permission) DO NOTHING
        `)

      })

      yield* transaction(mutation)
    }),
    revokeAccount: Effect.fn("Group.revokeAccount")(function* (actor, username, permission) {
      yield* admin(actor)

      const mutation = Effect.gen(function* () {
        yield* account(actor, username)

        yield* database(sql`
          DELETE FROM identity_account_grants
          WHERE tenant_id = ${actor.tenantId} AND username = ${username} AND permission = ${permission}
        `)

      })

      yield* transaction(mutation)
    }),
    listAccount: Effect.fn("Group.listAccount")(function* (actor, username) {
      yield* selfOrAdmin(actor, username)
      yield* account(actor, username)

      const rows = yield* database(sql`
        SELECT permission FROM identity_account_grants
        WHERE tenant_id = ${actor.tenantId} AND username = ${username} ORDER BY permission
      `)

      return yield* decodePermissions(rows)
    }),
    grantGroup: Effect.fn("Group.grantGroup")(function* (actor, id, permission) {
      yield* admin(actor)

      const mutation = Effect.gen(function* () {
        yield* group(actor, id)

        const grantId = yield* freshId

        yield* database(sql`
          INSERT INTO identity_group_grants (id, group_id, permission)
          VALUES (${grantId}, ${id}, ${permission}) ON CONFLICT(group_id, permission) DO NOTHING
        `)

      })

      yield* transaction(mutation)
    }),
    revokeGroup: Effect.fn("Group.revokeGroup")(function* (actor, id, permission) {
      yield* admin(actor)

      const mutation = Effect.gen(function* () {
        yield* group(actor, id)
        yield* database(sql`DELETE FROM identity_group_grants WHERE group_id = ${id} AND permission = ${permission}`)
      })

      yield* transaction(mutation)
    }),
    listGroup: Effect.fn("Group.listGroup")(function* (actor, id) {
      yield* admin(actor)
      yield* group(actor, id)

      const rows = yield* database(sql`
        SELECT permission FROM identity_group_grants WHERE group_id = ${id} ORDER BY permission
      `)

      return yield* decodePermissions(rows)
    }),
    check: Effect.fn("Group.check")(function* (username, tenantId, permission) {
      const rows = yield* database(sql`
        SELECT 1 FROM identity_accounts AS account
        WHERE account.username = ${username} AND account.disabled = 0
          AND json_extract(account.subject_json, '$.tenantId') = ${tenantId}
          AND (
            EXISTS (SELECT 1 FROM identity_account_grants AS direct
              WHERE direct.username = account.username AND direct.tenant_id = ${tenantId}
                AND direct.permission = ${permission})
            OR EXISTS (SELECT 1 FROM identity_group_memberships AS member
              JOIN identity_groups AS grp ON grp.id = member.group_id AND grp.tenant_id = ${tenantId}
              JOIN identity_group_grants AS grant ON grant.group_id = grp.id
              WHERE member.username = account.username AND grant.permission = ${permission})
          ) LIMIT 1
      `)

      return rows.length > 0
    }),
  })
}

const groupRuntime = Effect.map(SqlClient.SqlClient, makeGroupRuntime)

export const GroupRuntimeLive = Layer.effect(GroupRuntime, groupRuntime)
