import { Application } from "effect-domains/application"
import { BookResource } from "./resources.ts"

export const McpServerApplication = Application.make({ name: "mcp-server", parts: [BookResource] })
