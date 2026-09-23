import { Effect, Function, HashMap, Option, Result, Schema } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"
import type { RpcGroup } from "effect/unstable/rpc"
import type { ApplicationIR } from "./application.ts"
import { type Invocation, requestHandlerFor } from "./application-ui-request.ts"

import {
  applicationUiDeclaredErrorResponse,
  applicationUiFailureResponse,
  applicationUiInternalResponse,
  applicationUiSuccessResponse,
} from "./application-ui-response.ts"

import { compileUnaryRpc, type RpcProcedure } from "./rpc-contract.ts"
import { inProcessClient, type UnaryRpc } from "./rpc-in-process.ts"

export class ApplicationUiDefinitionError extends Schema.TaggedError<ApplicationUiDefinitionError>()(
  "ApplicationUiDefinitionError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

const maximumUiOperations = 1_000


const internalResponse = Effect.succeed(applicationUiInternalResponse)
const recoverResponseEncodingFailure = Function.constant(internalResponse)


const compileOperationInvocations = Effect.fn("ApplicationUi.operationInvocations")(function* (
  application: ApplicationIR,
) {

  if (application.group.requests.size > maximumUiOperations) {
    return yield* ApplicationUiDefinitionError.make({
      reason: `Application UI supports at most ${maximumUiOperations} operations`,
    })
  }

  // SAFETY: The group is unary because Application compilation rejects streaming operations.
  const inProcess = yield* inProcessClient(application.group as RpcGroup.RpcGroup<UnaryRpc>)
  const { client, withHandlerContext } = inProcess

  const compileOperation = Effect.fn("ApplicationUi.compileOperation")(function* (procedure: RpcProcedure) {
    const compiled = compileUnaryRpc(procedure)

    const failUnavailableOperation = () => ApplicationUiDefinitionError.make({
      reason: `Application UI operations must be unary: ${procedure._tag}`,
    })

    const contract = yield* Effect.fromOption(compiled, failUnavailableOperation)
    const resultSchema = Schema.Struct({ result: contract.successSchema })
    const errorSchema = Schema.Struct({ error: contract.errorSchema })
    const decode = Schema.decodeUnknownEffect(contract.payloadSchema)
    const encodeResult = Schema.encodeUnknownEffect(resultSchema)
    const encodeError = Schema.encodeUnknownEffect(errorSchema)
    // SAFETY: The handler context is valid because `contract` was compiled from this procedure.
    const withCodecContext = withHandlerContext(procedure as UnaryRpc)

    const invoke = Effect.fn("ApplicationUi.invoke")(function* (
      input: unknown,
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const inputEffect = decode(input)
      const decodedInput = withCodecContext(inputEffect)
      const decoded = yield* Effect.result(decodedInput)

      if (Result.isFailure(decoded)) {
        const invalidInput = applicationUiFailureResponse(
          400,
          `Invalid input for ${contract._tag}: ${decoded.failure.message}`,
        )

        return yield* Effect.catchTag(
          invalidInput,
          "HttpBodyError",
          recoverResponseEncodingFailure,
        )
      }

      const call = client(contract._tag, decoded.success, { headers: request.headers })

      const respondToDeclaredFailure = Effect.fn("ApplicationUi.respondToDeclaredFailure")(function* (error: unknown) {
        const errorEffect = encodeError({ error })
        const encoded = yield* withCodecContext(errorEffect)

        return yield* applicationUiDeclaredErrorResponse(encoded)
      })

      const respondToDeclaredSuccess = Effect.fn("ApplicationUi.respondToDeclaredSuccess")(function* (result: unknown) {
        const resultEffect = encodeResult({ result })
        const encoded = yield* withCodecContext(resultEffect)

        return yield* applicationUiSuccessResponse(encoded)
      })

      const response = Effect.matchEffect(call, {
        onFailure: (error) => respondToDeclaredFailure(error),
        onSuccess: (result) => respondToDeclaredSuccess(result),
      })

      return yield* Effect.catchTags(response, {
        SchemaError: recoverResponseEncodingFailure,
        HttpBodyError: recoverResponseEncodingFailure,
      })
    })

    const execute = Effect.fn("ApplicationUi.execute")(function* (input, request) {
      const response = invoke(input, request)

      return yield* Effect.catchCause(response, recoverResponseEncodingFailure)
    }) as Invocation

    return [contract._tag, execute] as const
  })

  const procedures = application.group.requests.values()
  const entries = yield* Effect.forEach(procedures, compileOperation, { concurrency: 16 })

  return HashMap.fromIterable(entries)
})

export const compileApplicationCall = Effect.fn("ApplicationUi.applicationCall")(function* (
  application: ApplicationIR,
  allowedOrigins: Option.Option<ReadonlyArray<string>>,
) {
  const invocations = yield* compileOperationInvocations(application)

  return requestHandlerFor(invocations, allowedOrigins)
})
