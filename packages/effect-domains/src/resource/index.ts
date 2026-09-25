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
} from "./model.ts"

import { define } from "./definition.ts"
import { reference, repository, table, valueFromSpec } from "./runtime.ts"

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
