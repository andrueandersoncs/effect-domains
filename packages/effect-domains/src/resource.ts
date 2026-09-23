import type { Resource as ResourceDefinition } from "./resource-model.ts"

export type Resource = ResourceDefinition

export type { ResourceSpec } from "./resource-definition.ts"
export type { ResourceRuntime, ResourceTable } from "./resource-runtime.ts"

import {
  capabilities,
  capabilityCreate,
  capabilityGet,
  capabilityList,
  capabilityPatch,
  capabilityRemove,
  capabilityTransition,
  capabilityUpdate,
  creationDefault,
  creationGenerated,
  creationInput,
  creationSubject,
  crud,
} from "./resource-model.ts"

import { define } from "./resource-definition.ts"
import { reference, repository, table, valueFromSpec } from "./resource-runtime.ts"

export const Resource = {
  define,
  compile: valueFromSpec,
  repository,
  table,
  capabilities,
  crud,
  get: capabilityGet,
  list: capabilityList,
  create: capabilityCreate,
  update: capabilityUpdate,
  remove: capabilityRemove,
  patch: capabilityPatch,
  transition: capabilityTransition,
  reference,
  input: creationInput,
  default: creationDefault,
  generated: creationGenerated,
  fromSubject: creationSubject,
}
