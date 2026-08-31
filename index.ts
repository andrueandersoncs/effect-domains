/** Use the package root when importing Domain because it defines canonical domain annotations. */
export { Domain } from "./src/Domain.ts"

/** Use the package root when importing table definitions because they form the persistence metadata API. */
export {
  DefaultTableIdentifierSchema,
  Table,
  type TableDefinition,
  TableDefinitionError,
  TableError,
} from "./src/Table.ts"

/** Use the package root when importing query definitions because they form the authored operation API. */
export {
  Query,
  type QueryConfig,
  type QueryDefinition,
} from "./src/Query.ts"
