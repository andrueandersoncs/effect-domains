import { Context, type Effect, Schema } from "effect"
import type { Forbidden } from "../../authorization/model.ts"
import type { IdentityUnavailable } from "../index.ts"

export const GroupNameSchema = Schema.NonEmptyString.check(Schema.isMaxLength(200))
export const PermissionSchema = Schema.NonEmptyString.check(Schema.isMaxLength(320))
export const GroupIdSchema = Schema.NonEmptyString.annotate({ identifier: "GroupId" })
export const GroupUsernameSchema = Schema.NonEmptyString.check(Schema.isMaxLength(320))

export const GroupSchema = Schema.Struct({ id: GroupIdSchema, name: GroupNameSchema })

export interface Group extends Schema.Schema.Type<typeof GroupSchema> {}

export const GroupMembersSchema = Schema.Array(GroupUsernameSchema)
export const PermissionListSchema = Schema.Array(PermissionSchema)

export class GroupNotFound extends Schema.TaggedError<GroupNotFound>()("GroupNotFound", {}) {}
export class MemberNotFound extends Schema.TaggedError<MemberNotFound>()("MemberNotFound", {}) {}
export class AlreadyMember extends Schema.TaggedError<AlreadyMember>()("AlreadyMember", {}) {}
export class AccountNotFound extends Schema.TaggedError<AccountNotFound>()("AccountNotFound", {}) {}

export class GroupActor extends Schema.Class<GroupActor>("GroupActor")({
  username: Schema.String,
  tenantId: Schema.String,
  admin: Schema.Boolean,
}) {}

export class GroupRecord extends Schema.Class<GroupRecord>("GroupRecord")({
  id: GroupIdSchema,
  name: GroupNameSchema,
}) {}

type GroupFailure = IdentityUnavailable | Forbidden | GroupNotFound | MemberNotFound | AlreadyMember | AccountNotFound

export class GroupRuntime extends Context.Service<GroupRuntime, {
  readonly create: (actor: GroupActor, name: string) => Effect.Effect<GroupRecord, GroupFailure>
  readonly update: (actor: GroupActor, id: string, name: string) => Effect.Effect<void, GroupFailure>
  readonly delete: (actor: GroupActor, id: string) => Effect.Effect<void, GroupFailure>
  readonly listMembers: (actor: GroupActor, id: string) => Effect.Effect<ReadonlyArray<string>, GroupFailure>
  readonly isMember: (actor: GroupActor, id: string, username: string) => Effect.Effect<boolean, GroupFailure>
  readonly addMember: (actor: GroupActor, id: string, username: string) => Effect.Effect<void, GroupFailure>
  readonly removeMember: (actor: GroupActor, id: string, username: string) => Effect.Effect<void, GroupFailure>
  readonly grantAccount: (actor: GroupActor, username: string, permission: string) => Effect.Effect<void, GroupFailure>
  readonly revokeAccount: (actor: GroupActor, username: string, permission: string) => Effect.Effect<void, GroupFailure>
  readonly listAccount: (actor: GroupActor, username: string) => Effect.Effect<ReadonlyArray<string>, GroupFailure>
  readonly grantGroup: (actor: GroupActor, id: string, permission: string) => Effect.Effect<void, GroupFailure>
  readonly revokeGroup: (actor: GroupActor, id: string, permission: string) => Effect.Effect<void, GroupFailure>
  readonly listGroup: (actor: GroupActor, id: string) => Effect.Effect<ReadonlyArray<string>, GroupFailure>
  readonly check: (username: string, tenantId: string, permission: string) => Effect.Effect<boolean, IdentityUnavailable>
}>()("@effect-domains/GroupRuntime") {}
