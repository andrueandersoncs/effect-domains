---
description: Run a reading-list application and use its generated Application UI beside the CLI.
---

# Run your first application

Run a reading list with SQLite persistence, a command-line client, and a generated Application UI at `/`. You’ll add a book, mark it finished, and see the same record through both interfaces.

## Before you start

You need a checkout of this repository, **Bun** (the workspace pins 1.4.0), and two terminals. Run all commands from the repository root. The code uses **Effect 4.0.0-rc.112**; Effect 3 examples are not interchangeable with these APIs.

This is a workspace walkthrough, not an installation guide for a published package. You don’t need to know the framework to run it; the [next guide](/guides/define-a-resource) assumes TypeScript and basic Effect Schema knowledge.

::: warning Local demonstration only
The reading list deliberately allows public access. Keep it on loopback; it has no user accounts or private records. The Bun runner binds to `127.0.0.1`.
:::

## 1. Install and start the server

In the first terminal:

```bash
bun install
bun run build
bun run reading-list:server
```

`build` compiles the shared Application UI assets. Leave the server running, then open [http://127.0.0.1:3000/](http://127.0.0.1:3000/) for generated resource lists and operation forms.

The server creates `data/reading-list.sqlite` and applies the example’s checked-in migrations. Restarting preserves your books.

::: tip Port 3000 already in use?
Start with `PORT=3001 bun run reading-list:server`, open port 3001 in the browser, and run `export READING_LIST_URL=http://127.0.0.1:3001/rpc/v1` in the second terminal before the commands below. The client does not read the server’s `PORT` variable.
:::

## 2. Add a book

In the second terminal:

```bash
bun run reading-list books.create --input-json '{"title":"A Wizard of Earthsea","author":"Ursula K. Le Guin","status":"planned","format":"paperback"}'
```

The command prints a JSON record like this. Your generated `id` will differ:

```json
{
  "title": "A Wizard of Earthsea",
  "author": "Ursula K. Le Guin",
  "status": "planned",
  "format": "paperback",
  "rating": null,
  "notes": null,
  "id": "01a0908b-7f60-7365-b26a-215ad811179b"
}
```

You supplied four fields. The resource supplied an identifier; nullable `rating` and `notes` default to `null` when omitted.

## 3. Find your backlog

```bash
bun run reading-list books.list --input-json '{"filter":{"status":"planned"}}'
```

The result is an object with `items` and `nextCursor`. Your book appears in `items`; with no more than 25 matching books, `nextCursor` is `null`.

The example allows equality filters for `status` and `format`. Lists are bounded and ordered by identifier, not by title or rating. See [list requests](/reference/resources#list) when you need another page.

## 4. Mark the book finished

Copy the `id` from the create result into this shell variable, replacing the sample value:

```bash
BOOK_ID='01a0908b-7f60-7365-b26a-215ad811179b'
```

Then update the book:

```bash
bun run reading-list books.update --input-json "{\"id\":\"$BOOK_ID\",\"title\":\"A Wizard of Earthsea\",\"author\":\"Ursula K. Le Guin\",\"status\":\"finished\",\"format\":\"paperback\",\"rating\":5,\"notes\":\"Revisit the balance of names and power\"}"
bun run reading-list books.get --input-json "{\"id\":\"$BOOK_ID\"}"
```

Both commands return the book with `status: "finished"` and `rating: 5`.

**Update takes the complete row**, including `rating` and `notes`. Nullable create defaults do not make fields optional on update. Partial changes require publishing the separate `patch` operation; this example does not publish it.

## 5. See the same record in the browser

Return to `/` and select the Books resource. Your finished book should be visible. Operation forms let you create, retrieve, update, and remove books through the same contracts as the CLI.

There is no second UI database or permission bypass. Both clients call the same compiled operations.

## 6. Try an invalid rating

```bash
bun run reading-list books.create --input-json '{"title":"Example","author":"Author","status":"finished","format":"ebook","rating":6}'
```

This command exits with an error and does not create a book. Ratings must be whole numbers from 1 to 5, or `null`. The CLI validates the input against the operation schema before sending it.

## 7. Inspect the contract

```bash
bun run reading-list inspect books.create
```

Inspection prints JSON containing the operation’s input, success, and error schemas along with resource metadata. Find the input schema’s `required` fields: `rating` and `notes` are not required on create.

Inspection runs locally; you can stop the server with **Ctrl+C** and run it again. Creating and retrieving books require the server.

## What you just ran

The application has no hand-written CRUD handlers. These files provide the declarations:

| File under `examples/reading-list/` | Responsibility |
| --- | --- |
| `domain.ts` | Book fields and validation rules |
| `resources.ts` | Public access, published operations, nullable create defaults, and list filters |
| `application.ts` | Registers the resource in an application |
| `migrations.ts` and `migrations/` | Imports the frozen SQLite history |
| `main.ts` | Runs the server and CLI, and supplies Application UI presentation |

The [reading-list source](../examples/reading-list/) is small enough to read end to end.

## Next: define your own resource

[Define a resource](/guides/define-a-resource) takes you from your own schema to a running application. For the underlying model, read [how the pieces fit](/concepts). To compare business rules, authorization, or durable work, [choose another example](/examples).

### If something goes wrong

| Symptom | Check |
| --- | --- |
| CLI connection fails | Keep the server running. Match `READING_LIST_URL` to its port, including `/rpc/v1`. |
| Startup reports missing admin assets | Run `bun run build` from the repository root, then restart. |
| `ResourceNotFound` after copying a command | Use the identifier returned by your own create command. |
| Startup reports migration or schema drift | Don’t delete an existing database to silence the error. Use `READING_LIST_DB=data/reading-list-tutorial.sqlite bun run reading-list:server` for a separate tutorial database; use the [migration guide](/guides/migrations) for data you need to retain. |
