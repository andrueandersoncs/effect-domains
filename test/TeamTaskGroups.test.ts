import { expect, it } from "@effect/vitest"
import { Effect, pipe } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { Application } from "effect-domains/application"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { SchemaStore } from "effect-domains/migrations"
import { TeamTasksApplication } from "../examples/team-tasks/application.ts"
import { TeamTasksMigrations } from "../examples/team-tasks/migrations.ts"
import { TestIdentity, sessionFor } from "./identity-fixture.ts"

const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: TeamTasksMigrations })

it.effect("tenant-scoped account and group grants control an authored task report immediately", () => pipe(
  Effect.gen(function* () {
    yield* Application.prepare(TeamTasksApplication, yield* SchemaStore)
    const client = yield* RpcTest.makeClient(TeamTasksApplication.group)
    const admin = yield* sessionFor("admin")
    const bob = yield* sessionFor("bob")
    const outsider = yield* sessionFor("outsider")
    yield* client["todos.create"]({ project: "north", title: "repair", detail: null, priority: "normal", dueDate: null }, { headers: bob })

    const denied = yield* pipe(client["todos.review"](undefined, { headers: bob }), Effect.result)
    expect(denied).toMatchObject({ _tag: "Failure", failure: { _tag: "Forbidden" } })

    yield* client["identity.permission.grantAccount"]({ username: "bob", permission: "todos.review" }, { headers: admin })
    expect(yield* client["identity.permission.listAccount"]({ username: "bob" }, { headers: bob })).toContain("todos.review")
    expect(yield* client["todos.review"](undefined, { headers: bob })).toMatchObject({ total: 1, completed: 0 })
    yield* client["identity.permission.revokeAccount"]({ username: "bob", permission: "todos.review" }, { headers: admin })
    expect(yield* client["identity.permission.check"]({ permission: "todos.review" }, { headers: bob })).toBe(false)

    const group = yield* client["identity.group.create"]({ name: "reviewers" }, { headers: admin })
    yield* client["identity.group.update"]({ id: group.id, name: "review team" }, { headers: admin })
    yield* client["identity.group.addMember"]({ id: group.id, username: "bob" }, { headers: admin })
    expect(yield* client["identity.group.listMembers"]({ id: group.id }, { headers: admin })).toEqual(["bob"])
    expect(yield* client["identity.group.isMember"]({ id: group.id, username: "bob" }, { headers: bob })).toBe(true)

    yield* client["identity.permission.grantGroup"]({ id: group.id, permission: "todos.review" }, { headers: admin })
    expect(yield* client["identity.permission.listGroup"]({ id: group.id }, { headers: admin })).toContain("todos.review")
    expect(yield* client["identity.permission.check"]({ permission: "todos.review" }, { headers: bob })).toBe(true)
    expect(yield* client["todos.review"](undefined, { headers: bob })).toMatchObject({ total: 1 })

    const crossTenant = yield* pipe(client["identity.group.addMember"]({ id: group.id, username: "outsider" }, { headers: admin }), Effect.result)
    expect(crossTenant).toMatchObject({ _tag: "Failure", failure: { _tag: "AccountNotFound" } })
    const nonAdmin = yield* pipe(client["identity.permission.grantGroup"]({ id: group.id, permission: "other" }, { headers: bob }), Effect.result)
    expect(nonAdmin).toMatchObject({ _tag: "Failure", failure: { _tag: "Forbidden" } })
    const outside = yield* pipe(client["identity.group.listMembers"]({ id: group.id }, { headers: outsider }), Effect.result)
    expect(outside).toMatchObject({ _tag: "Failure", failure: { _tag: "Forbidden" } })

    yield* client["identity.group.removeMember"]({ id: group.id, username: "bob" }, { headers: admin })
    expect(yield* client["identity.group.isMember"]({ id: group.id, username: "bob" }, { headers: bob })).toBe(false)
    expect(yield* pipe(client["todos.review"](undefined, { headers: bob }), Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "Forbidden" } })

    yield* client["identity.group.addMember"]({ id: group.id, username: "bob" }, { headers: admin })
    yield* client["identity.permission.revokeGroup"]({ id: group.id, permission: "todos.review" }, { headers: admin })
    expect(yield* client["identity.permission.check"]({ permission: "todos.review" }, { headers: bob })).toBe(false)
    yield* client["identity.permission.grantGroup"]({ id: group.id, permission: "todos.review" }, { headers: admin })
    yield* client["identity.group.delete"]({ id: group.id }, { headers: admin })
    expect(yield* client["identity.permission.check"]({ permission: "todos.review" }, { headers: bob })).toBe(false)
  }),
  Effect.scoped,
  Effect.provide(TeamTasksApplication.handlers),
  Effect.provide(AuthorizationRpc.layer),
  Effect.provide(TestIdentity),
  Effect.provide(sqlite),
))
