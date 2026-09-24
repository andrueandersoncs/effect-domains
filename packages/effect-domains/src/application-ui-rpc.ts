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

// SAFETY: The group can be narrowed because Application compilation rejects every streaming operation.
const asUnaryGroup = (group: ApplicationIR["group"]) => group as RpcGroup.RpcGroup<UnaryRpc>

// SAFETY: The procedure can be narrowed because callers invoke this only after compileUnaryRpc returns a unary contract.
const asUnaryProcedure = (procedure: RpcProcedure) => procedure as UnaryRpc


const compileOperationInvocations = Effect.fn("ApplicationUi.operationInvocations")(function* (
  application: ApplicationIR,
) {

  if (application.group.requests.size > maximumUiOperations) {
    return yield* ApplicationUiDefinitionError.make({
      reason: `Application UI supports at most ${maximumUiOperations} operations`,
    })
  }

  const unaryGroup = asUnaryGroup(application.group)
  const inProcess = yield* inProcessClient(unaryGroup)
  const { client, withHandlerContext } = inProcess

  const compileOperation = Effect.fn("ApplicationUi.compileOperation")(function* (procedure: RpcProcedure) {
    const compiled = compileUnaryRpc(procedure)

    const failUnavailableOperation = () => ApplicationUiDefinitionError.make({
      reason: `Application UI operations must be unary: ${procedure._tag}`,
    })

    const contract = yield* Effect.fromOption(compiled, failUnavailableOperation)
    const OperationResultSchema = Schema.Struct({ result: contract.successSchema })

    interface OperationResult extends Schema.Schema.Type<typeof OperationResultSchema> {}

    const OperationErrorEnvelopeSchema = Schema.Struct({ error: contract.errorSchema })

    interface OperationErrorEnvelope extends Schema.Schema.Type<typeof OperationErrorEnvelopeSchema> {}

    const decode = Schema.decodeUnknownEffect(contract.payloadSchema)
    const encodeResult = Schema.encodeUnknownEffect(OperationResultSchema)
    const encodeError = Schema.encodeUnknownEffect(OperationErrorEnvelopeSchema)
    const unaryProcedure = asUnaryProcedure(procedure)
    const withCodecContext = withHandlerContext(unaryProcedure)

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
        onFailure: respondToDeclaredFailure,
        onSuccess: respondToDeclaredSuccess,
      })

      return yield* Effect.catchTags(response, {
        SchemaError: recoverResponseEncodingFailure,
        HttpBodyError: recoverResponseEncodingFailure,
      })
    })

    const execute: Invocation = Effect.fn("ApplicationUi.execute")(function* (input, request) {
      const response = invoke(input, request)

      return yield* Effect.catchCause(response, recoverResponseEncodingFailure)
    })

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
