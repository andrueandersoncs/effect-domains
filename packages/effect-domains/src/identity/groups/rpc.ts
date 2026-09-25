import { Array, Effect, Option, Schema } from "effect"
import { Headers } from "effect/unstable/http"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Forbidden, Unauthenticated } from "../../authorization/model.ts"
import { IdentityUnavailable } from "../index.ts"
import { authenticateIdentity } from "../authenticate.ts"

import {
  AccountNotFound, AlreadyMember, GroupActor, GroupIdSchema, GroupMembersSchema,
  GroupNameSchema, GroupNotFound, GroupRuntime, GroupSchema, GroupUsernameSchema,
  MemberNotFound, PermissionListSchema, PermissionSchema,
} from "./index.ts"

const ErrorsSchema = Schema.Union([
  Unauthenticated, IdentityUnavailable, Forbidden, GroupNotFound, MemberNotFound, AlreadyMember, AccountNotFound,
])

const CreateGroupSchema = Schema.Struct({ name: GroupNameSchema })

interface CreateGroup extends Schema.Schema.Type<typeof CreateGroupSchema> {}

const GroupIdPayloadSchema = Schema.Struct({ id: GroupIdSchema })

interface GroupIdPayload extends Schema.Schema.Type<typeof GroupIdPayloadSchema> {}

const NamedGroupSchema = Schema.Struct({ id: GroupIdSchema, name: GroupNameSchema })

interface NamedGroup extends Schema.Schema.Type<typeof NamedGroupSchema> {}

const GroupMemberSchema = Schema.Struct({ id: GroupIdSchema, username: GroupUsernameSchema })

interface GroupMember extends Schema.Schema.Type<typeof GroupMemberSchema> {}

const AccountPermissionSchema = Schema.Struct({ username: GroupUsernameSchema, permission: PermissionSchema })

interface AccountPermission extends Schema.Schema.Type<typeof AccountPermissionSchema> {}

const GroupPermissionSchema = Schema.Struct({ id: GroupIdSchema, permission: PermissionSchema })

interface GroupPermission extends Schema.Schema.Type<typeof GroupPermissionSchema> {}

const AccountSchema = Schema.Struct({ username: GroupUsernameSchema })

interface Account extends Schema.Schema.Type<typeof AccountSchema> {}

const PermissionPayloadSchema = Schema.Struct({ permission: PermissionSchema })

interface PermissionPayload extends Schema.Schema.Type<typeof PermissionPayloadSchema> {}

const rpc = <const Name extends string, Payload extends Schema.Top, Success extends Schema.Top>(
  name: Name, payload: Payload, success: Success,
) => Rpc.make(name, { payload, success, error: ErrorsSchema })

const create = rpc("identity.group.create", CreateGroupSchema, GroupSchema)
const update = rpc("identity.group.update", NamedGroupSchema, Schema.Void)
const remove = rpc("identity.group.delete", GroupIdPayloadSchema, Schema.Void)
const listMembers = rpc("identity.group.listMembers", GroupIdPayloadSchema, GroupMembersSchema)
const isMember = rpc("identity.group.isMember", GroupMemberSchema, Schema.Boolean)
const addMember = rpc("identity.group.addMember", GroupMemberSchema, Schema.Void)
const removeMember = rpc("identity.group.removeMember", GroupMemberSchema, Schema.Void)
const grantAccount = rpc("identity.permission.grantAccount", AccountPermissionSchema, Schema.Void)
const revokeAccount = rpc("identity.permission.revokeAccount", AccountPermissionSchema, Schema.Void)
const listAccount = rpc("identity.permission.listAccount", AccountSchema, PermissionListSchema)
const grantGroup = rpc("identity.permission.grantGroup", GroupPermissionSchema, Schema.Void)
const revokeGroup = rpc("identity.permission.revokeGroup", GroupPermissionSchema, Schema.Void)
const listGroup = rpc("identity.permission.listGroup", GroupIdPayloadSchema, PermissionListSchema)
const check = rpc("identity.permission.check", PermissionPayloadSchema, Schema.Boolean)

export const GroupRpcs = RpcGroup.make(
  create, update, remove, listMembers, isMember, addMember, removeMember,
  grantAccount, revokeAccount, listAccount, grantGroup, revokeGroup, listGroup, check,
)

const TenantIdSchema = Schema.NonEmptyString.annotate({ identifier: "GroupTenantId" })
const RolesSchema = Schema.Array(Schema.Unknown)
const decodeTenantId = Schema.decodeUnknownOption(TenantIdSchema)
const decodeRoles = Schema.decodeUnknownOption(RolesSchema)

const actorFor = Effect.fn("Group.actorFor")(function* (headers: Headers.Headers) {
  const identity = yield* authenticateIdentity(headers)
  const tenantId = decodeTenantId(identity.subject.tenantId)

  if (Option.isNone(tenantId)) return yield* Unauthenticated.make({})

  const parsedRoles = decodeRoles(identity.subject.roles)
  const roles = Option.getOrElse(parsedRoles, Array.empty<unknown>)
  const admin = Array.contains(roles, "admin")

  return GroupActor.make({ username: identity.username, tenantId: tenantId.value, admin })
})

const actorAndRuntime = Effect.fn("Group.actorAndRuntime")(function* (headers: Headers.Headers) {
  const actor = yield* actorFor(headers)
  const runtime = yield* GroupRuntime

  return [runtime, actor] as const
})

interface RpcMetadata { readonly headers: Headers.Headers }

const withActor = <Payload, Success, Failure>(
  operation: (runtime: GroupRuntime["Service"], actor: GroupActor, payload: Payload) => Effect.Effect<Success, Failure>,
) => Effect.fn("Group.withActor")(function* (payload: Payload, { headers }: RpcMetadata) {
  const [runtime, actor] = yield* actorAndRuntime(headers)

  return yield* operation(runtime, actor, payload)
})

const groupOperations = {
  insertGroup(runtime: GroupRuntime["Service"], actor: GroupActor, payload: CreateGroup) {
    return runtime.create(actor, payload.name)
  },
  update(runtime: GroupRuntime["Service"], actor: GroupActor, payload: NamedGroup) {
    return runtime.update(actor, payload.id, payload.name)
  },
  delete(runtime: GroupRuntime["Service"], actor: GroupActor, payload: GroupIdPayload) {
    return runtime.delete(actor, payload.id)
  },
  listMembers(runtime: GroupRuntime["Service"], actor: GroupActor, payload: GroupIdPayload) {
    return runtime.listMembers(actor, payload.id)
  },
  evaluateMembership(runtime: GroupRuntime["Service"], actor: GroupActor, payload: GroupMember) {
    return runtime.isMember(actor, payload.id, payload.username)
  },
  addMember(runtime: GroupRuntime["Service"], actor: GroupActor, payload: GroupMember) {
    return runtime.addMember(actor, payload.id, payload.username)
  },
  removeMember(runtime: GroupRuntime["Service"], actor: GroupActor, payload: GroupMember) {
    return runtime.removeMember(actor, payload.id, payload.username)
  },
  grantAccount(runtime: GroupRuntime["Service"], actor: GroupActor, payload: AccountPermission) {
    return runtime.grantAccount(actor, payload.username, payload.permission)
  },
  revokeAccount(runtime: GroupRuntime["Service"], actor: GroupActor, payload: AccountPermission) {
    return runtime.revokeAccount(actor, payload.username, payload.permission)
  },
  listAccount(runtime: GroupRuntime["Service"], actor: GroupActor, payload: Account) {
    return runtime.listAccount(actor, payload.username)
  },
  grantGroup(runtime: GroupRuntime["Service"], actor: GroupActor, payload: GroupPermission) {
    return runtime.grantGroup(actor, payload.id, payload.permission)
  },
  revokeGroup(runtime: GroupRuntime["Service"], actor: GroupActor, payload: GroupPermission) {
    return runtime.revokeGroup(actor, payload.id, payload.permission)
  },
  listGroup(runtime: GroupRuntime["Service"], actor: GroupActor, payload: GroupIdPayload) {
    return runtime.listGroup(actor, payload.id)
  },
  check(runtime: GroupRuntime["Service"], actor: GroupActor, payload: PermissionPayload) {
    return runtime.check(actor.username, actor.tenantId, payload.permission)
  },
}

const createGroup = withActor(groupOperations.insertGroup)
const updateGroup = withActor(groupOperations.update)
const deleteGroup = withActor(groupOperations.delete)
const listGroupMembers = withActor(groupOperations.listMembers)
const isGroupMember = withActor(groupOperations.evaluateMembership)
const addGroupMember = withActor(groupOperations.addMember)
const removeGroupMember = withActor(groupOperations.removeMember)
const grantAccountPermission = withActor(groupOperations.grantAccount)
const revokeAccountPermission = withActor(groupOperations.revokeAccount)
const listAccountPermissions = withActor(groupOperations.listAccount)
const grantGroupPermission = withActor(groupOperations.grantGroup)
const revokeGroupPermission = withActor(groupOperations.revokeGroup)
const listGroupPermissions = withActor(groupOperations.listGroup)
const checkPermission = withActor(groupOperations.check)

export const GroupHandlers = GroupRpcs.toLayer({
  "identity.group.create": createGroup,
  "identity.group.update": updateGroup,
  "identity.group.delete": deleteGroup,
  "identity.group.listMembers": listGroupMembers,
  "identity.group.isMember": isGroupMember,
  "identity.group.addMember": addGroupMember,
  "identity.group.removeMember": removeGroupMember,
  "identity.permission.grantAccount": grantAccountPermission,
  "identity.permission.revokeAccount": revokeAccountPermission,
  "identity.permission.listAccount": listAccountPermissions,
  "identity.permission.grantGroup": grantGroupPermission,
  "identity.permission.revokeGroup": revokeGroupPermission,
  "identity.permission.listGroup": listGroupPermissions,
  "identity.permission.check": checkPermission,
})
