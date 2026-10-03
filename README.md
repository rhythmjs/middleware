# @rhythmjs/middleware

Request validation, response interception, and exception filtering for
[Rhythm](https://github.com/rhythmjs/rhythm), the Bun-native backend framework: the middleware that
turns a router into a typed, schema-checked API. Each module is exported by its own subpath; there
is no root barrel export.

## Install

```sh
bun add @rhythmjs/middleware @rhythmjs/rhythm @rhythmjs/router
```

## `@rhythmjs/middleware/validate`

A single `validate(target, schema)` middleware that validates a request part against any
[Standard Schema v1](https://standardschema.dev) schema: zod, valibot, arktype, or your own.

```ts
import { RhythmRouter } from "@rhythmjs/router";
import { validate, type Validated } from "@rhythmjs/middleware/validate";
import { z } from "zod";

const createUser = z.object({ name: z.string().min(1), age: z.coerce.number().int() });
const userParams = z.object({ id: z.coerce.number().int().positive() });

const router = new RhythmRouter()
  .post<Validated<"body", typeof createUser>>("/users", validate("body", createUser), (ctx) => {
    // ctx.valid.body is fully typed as the schema *output* ({ name: string; age: number })
    ctx.json(ctx.valid.body);
  })
  .get<Validated<"param", typeof userParams>>("/users/:id", validate("param", userParams), (ctx) => {
    ctx.text(`user #${ctx.valid.param.id}`);
  });
```

### `validate(target, schema)`

- `target`: `"body"` (JSON request body), `"query"` (URL search params; repeated keys become arrays), or
  `"param"` (route params matched by the router, e.g. `/users/:id`).
- `schema`: any Standard Schema v1 schema; sync or async.

On success the schema's **output** is merged into the context as `ctx.valid[target]`, so chained
validators compose:

```ts
router.post<Validated<"body", typeof bodySchema> & Validated<"query", typeof querySchema>>(
  "/articles",
  validate("body", bodySchema),
  validate("query", querySchema),
  (ctx) => {
    ctx.valid.body; // body output
    ctx.valid.query; // query output
  },
);
```

On failure the chain is short-circuited with a `400` JSON response of type `ValidationFailure`:

```json
{ "success": false, "target": "body", "issues": [{ "message": "...", "path": ["name"] }] }
```

### Exported types

- `Validated<Target, Schema>`: context-extension type for route handlers' `TExtra` parameter.
- `ValidationTarget`: `"body" | "query" | "param"`.
- `ValidationContext`: the context shape `validate` runs against.
- `ValidationIssue` / `ValidationFailure`: the serialized issue and 400 response body shapes.

## `@rhythmjs/middleware/intercept`

An `intercept(schema)` middleware that intercepts the outgoing response and transforms it through a schema:
the response-side counterpart of `validate`. It takes a single argument: any Standard Schema v1 schema, so a
zod `.transform()` works directly.

```ts
import { RhythmRouter } from "@rhythmjs/router";
import { intercept } from "@rhythmjs/middleware/intercept";
import { z } from "zod";

const User = z
  .object({ first_name: z.string(), last_name: z.string() })
  .transform((u) => ({ fullName: `${u.first_name} ${u.last_name}` }));

const router = new RhythmRouter().get("/users/ada", intercept(User), (ctx) => {
  ctx.json({ first_name: "Ada", last_name: "Lovelace" });
});
// GET /users/ada => 200 {"fullName":"Ada Lovelace"}
```

Register it with `.use(intercept(schema))` to apply it to every route, or per route ahead of the handlers.
It runs after `next()` (onion order): the JSON response body is parsed, passed through the schema, and the
schema's **output** is written back as the response. This also strips any fields the schema does not
declare, so it doubles as a serialization guard (e.g. never leaking `password`).

- Only successful (2xx) string bodies are intercepted; error responses and non-string bodies pass through
  untouched.
- A non-JSON string body is passed to the schema as a raw string; a string output is written back as-is.
- If the response does not match the schema, the request fails with `500` and an
  `InterceptFailure` JSON body: `{ "success": false, "issues": [...] }`.

Exported types: `InterceptIssue`, `InterceptFailure`.

## `@rhythmjs/middleware/filter`

An exception filter: a `filter(onError?)` middleware that catches anything thrown deeper in the chain and
turns it into an HTTP response, paired with an `HttpError` class.

```ts
import { RhythmRouter } from "@rhythmjs/router";
import { filter, HttpError } from "@rhythmjs/middleware/filter";

const router = new RhythmRouter().use(filter()).get("/users/:id", (ctx) => {
  throw new HttpError(404, "user not found");
});
// GET /users/1 => 404 {"success":false,"status":404,"message":"user not found"}
```

Register it **first** (`.use(filter())` before any routes) so it forms the outermost onion layer and sees
every error thrown by later middleware and handlers.

- `throw new HttpError(status, message, details?)` anywhere downstream maps to that status with a JSON body
  of type `FilterFailure`: `{ "success": false, "status": 404, "message": "...", "details": ... }`.
- Any other thrown value maps to a generic `500 { "success": false, "status": 500, "message": "Internal Server Error" }`;
  the original error message is never leaked to the client.
- `filter(onError)` replaces the default mapping entirely: `onError(error, ctx)` can log, map domain errors
  to statuses, or rethrow.
- Successful responses pass through untouched, and error responses are non-2xx so `intercept` skips them;
  `filter`, `intercept`, and `validate` compose freely on one router.

Exported types: `HttpError`, `FilterFailure`.

## Development

```sh
bun install
bun test # bun test runner
bun run typecheck # tsc --noEmit
bun run build # bun build + tsc declarations
```
