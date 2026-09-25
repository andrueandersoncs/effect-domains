import { Effect, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { Authorization } from "effect-domains/authorization"
import { Forbidden } from "effect-domains/authorization-model"
import { Command } from "effect-domains/command"
import { GroupRuntime } from "effect-domains/identity-groups"
import { TasksResource } from "./resources.ts"

class TaskReviewUnavailable extends Schema.TaggedError<TaskReviewUnavailable>()("TaskReviewUnavailable", {}) {}

const TaskReviewSchema = Schema.Struct({ total: Schema.Int, completed: Schema.Int })
const subjectPolicy = Authorization.subject(ExampleSubjectSchema)
const review = Command.family("todos.", TaskReviewUnavailable)
  .authorized(subjectPolicy.policy(subjectPolicy.all()))
  .define({ name: "review", success: TaskReviewSchema, dependencies: [TasksResource] })

const reviewTasks = Command.implement(review, Effect.fn("TeamTasks.review")(function* (_, subject) {
  const groups = yield* GroupRuntime
  const allowed = yield* groups.check(subject.userId, subject.tenantId, "todos.review")

  if (!allowed) return yield* Forbidden.make({})

  const sql = yield* SqlClient.SqlClient
  const taskCounts = SqlSchema.findOne({
    Request: Schema.String,
    Result: TaskReviewSchema,
    execute: (tenantId) => sql`
      SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END), 0) AS completed
      FROM todos WHERE tenantId = ${tenantId}
    `,
  })

  return yield* taskCounts(subject.tenantId)
}))

export const TaskReview = Command.bundle(reviewTasks)
