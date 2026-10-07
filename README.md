# @rhythmjs/middleware

Validation, response shaping, and error handling for HTTP routes in
[Rhythm](https://github.com/rhythmjs/rhythm), the Bun-native backend framework. Three small
middleware live on a `RhythmRouter`, between the request and your handler:

- `validate` checks the request body, query, or route params against a
  [Standard Schema v1](https://standardschema.dev) schema (zod, valibot, arktype, or your own) and exposes the
  typed result on `ctx.valid`.
- `intercept` runs the outgoing response through a schema, so you can reshape it and strip fields.
- `filter` turns thrown errors into JSON HTTP responses.

Each one is exported from its own subpath; there is no root barrel export.

## Install

```sh
bun add @rhythmjs/middleware @rhythmjs/rhythm @rhythmjs/router
```

`@rhythmjs/rhythm` and `@rhythmjs/router` are peer dependencies (0.0.18 or newer; the examples below
are written against 0.0.20), and Bun 1.2 or newer is required. The package depends on
`@standard-schema/spec` for types only. It does not ship a schema library: install whichever
Standard Schema library you prefer, for example `bun add zod` (the examples use zod 4).

## Use it with Rhythm

A `RhythmRouter` is a pipeline. You build routes and middleware on the router, mount it into a `Rhythm`
app with `mount`, and serve the app with `toFetchHandler`.

```ts
import { Rhythm, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import { filter, HttpError } from "@rhythmjs/middleware/filter";
import { intercept } from "@rhythmjs/middleware/intercept";
import { validate } from "@rhythmjs/middleware/validate";
import { z } from "zod";

const createUser = z.object({ name: z.string().min(1), age: z.coerce.number().int() });
const userParams = z.object({ id: z.coerce.number().int().positive() });

// What clients see: strip internal fields such as the password hash.
const publicUser = z
  .object({ id: z.number(), name: z.string(), age: z.number(), passwordHash: z.string() })
  .transform(({ passwordHash, ...user }) => user);

const usersRouter = new RhythmRouter()
  .use(filter()) // outermost: catches everything thrown below it
  .use(intercept(publicUser)) // shapes every successful response of this router
  .post("/users", validate("body", createUser), (ctx) => {
    // ctx.valid.body is typed as the schema output: { name: string; age: number }
    ctx.json({ id: 1, ...ctx.valid.body, passwordHash: "secret" }, 201);
  })
  .get("/users/:id", validate("param", userParams), (ctx) => {
    if (ctx.valid.param.id !== 1) throw new HttpError(404, "user not found");
    ctx.json({ id: 1, name: "Ada", age: 36, passwordHash: "secret" });
  });

const app = new Rhythm().use(mount(usersRouter));

Bun.serve({ fetch: toFetchHandler(app) });
```

What happens on each request:

1. `filter` wraps the rest of the router's chain in a `try`/`catch`.
2. `validate` parses the request, runs the schema, and either responds `400` or stores the result on
   `ctx.valid` and continues.
3. Your handler runs and writes the response with `ctx.json(...)`, `ctx.text(...)`, and so on.
4. On the way back out, `intercept` parses the JSON response, passes it through its schema, and writes
   the schema output back. `POST /users` answers `201 {"id":1,"name":"Ada","age":36}`.
5. Anything thrown in steps 2 to 4 reaches `filter`, which answers with a JSON error.

`toFetchHandler` returns a handler of `(request, server)`, which is exactly Bun's `fetch` signature, so it
can be passed straight to `Bun.serve`. `ctx.server` inside a handler is Bun's `Server`.

### What ends up on `ctx`

`validate` adds `ctx.valid`, keyed by the targets you validated. Each entry is the schema **output**
(after coercion and transforms), not the raw input:

| Call                        | Type on the context                 |
| --------------------------- | ----------------------------------- |
| `validate("body", schema)`  | `ctx.valid.body`: `InferOutput<…>`  |
| `validate("query", schema)` | `ctx.valid.query`: `InferOutput<…>` |
| `validate("param", schema)` | `ctx.valid.param`: `InferOutput<…>` |

`intercept` and `filter` add nothing to `ctx`; they only act on the response and on thrown errors.

### Middleware on routers vs on the app

- `router.use(filter())` and `router.use(intercept(schema))` apply to every route of that router,
  wherever the call appears in the chain.
- `validate(...)` is passed per route, before the handler: `router.post(path, validate(...), handler)`.
  It is typed like `derive()` (see [`validate`](#validate)), so it must be the first handler of the route.
- Put `filter` and `intercept` on the **router**, not the app. `mount` wraps anything thrown inside a
  mounted router in a new error (`mounted … failed`) with the original as its `cause`, so an app-level
  `filter()` never sees your `HttpError` and answers a generic `500`. The middleware are also typed for the
  HTTP context, which a plain `new Rhythm()` does not declare, so `new Rhythm().use(filter())` does not
  type-check.

### Recommended order

```ts
new RhythmRouter()
  .use(filter()) // 1. error handling first, so it is the outermost layer
  .use(intercept(schema)) // 2. response shaping, inside filter so failures it raises are still caught
  .post("/path", validate("body", schema), handler); // 3. per-route validation, then the handler
```

Because `filter` is outermost and its error responses are non-2xx, `intercept` leaves them alone and
`validate`'s `400` responses pass through unchanged.

## `@rhythmjs/middleware/validate`

### `validate(target, schema)`

Returns a route middleware that validates one part of the request.

- `target`: `"body"` (the JSON request body), `"query"` (URL search params; repeated keys become
  arrays), or `"param"` (the route params matched by the router, such as `:id` in `/users/:id`).
- `schema`: any Standard Schema v1 schema, sync or async.

On success the schema's output is merged into `ctx.valid[target]`, and the chain continues. The body is
read from a clone of the request, so later handlers can still read `ctx.request` themselves.

On failure the chain is short-circuited with a `400` JSON response of type `ValidationFailure`, and your
handler does not run:

```json
{ "success": false, "target": "body", "issues": [{ "message": "...", "path": ["name"] }] }
```

A body that is not valid JSON is reported as a single issue, `{ "message": "Malformed JSON in request body" }`,
with the same `400` shape.

`validate` is typed as a derive-style extension: it widens the context for the handlers after it, and a
router route accepts only one such extension handler, which must come first. To combine several validators on a
route, `compose` them and declare the combined type yourself, because `compose` drops extension types:

```ts
import { compose } from "@rhythmjs/rhythm/compose";
import type { ExtensionMiddleware } from "@rhythmjs/rhythm/types";
import { validate, type Validated, type ValidationContext } from "@rhythmjs/middleware/validate";

const bodySchema = z.object({ title: z.string() });
const querySchema = z.object({ draft: z.enum(["true", "false"]).transform((v) => v === "true") });

const both = compose([validate("body", bodySchema), validate("query", querySchema)]) as ExtensionMiddleware<
  ValidationContext,
  Validated<"body", typeof bodySchema> & Validated<"query", typeof querySchema>
>;

const articlesRouter = new RhythmRouter().post("/articles", both, (ctx) => {
  ctx.valid.body; // { title: string }
  ctx.valid.query; // { draft: boolean }
});
```

### Exported types

- `ValidationTarget`: `"body" | "query" | "param"`.
- `Validated<Target, Schema>`: the extension `validate` adds, `{ valid: { [target]: output } }`.
- `ValidationContext`: the context `validate` runs against (the HTTP context plus optional `params` and `valid`).
- `ValidationIssue` and `ValidationFailure`: the serialized issue (`{ message, path? }`) and the `400` body.

Issue paths are flattened to strings and numbers; symbol path segments are dropped.

## `@rhythmjs/middleware/intercept`

### `intercept(schema)`

Returns a middleware that transforms the outgoing response through a schema, the response-side counterpart of
`validate`. It takes one argument, a Standard Schema v1 schema, so a zod `.transform()` works directly.
Register it with `router.use(intercept(schema))`.

```ts
const User = z
  .object({ first_name: z.string(), last_name: z.string() })
  .transform((u) => ({ fullName: `${u.first_name} ${u.last_name}` }));

const router = new RhythmRouter().use(intercept(User)).get("/users/ada", (ctx) => {
  ctx.json({ first_name: "Ada", last_name: "Lovelace" });
});
// GET /users/ada => 200 {"fullName":"Ada Lovelace"}
```

It runs after `next()` (onion order): the JSON response body is parsed, validated, and the schema's **output** is
written back with `ctx.json`. Fields the schema does not declare are stripped (when the schema strips unknown
keys, as zod objects do), so it doubles as a serialization guard.

- Only successful (2xx) responses with a string body are intercepted. Error responses and non-string bodies
  (streams, binary, an untouched empty response) pass through unchanged.
- A body that is not JSON is passed to the schema as a raw string; a string output is written back as is.
- If the response does not match the schema, the request fails with `500` and an `InterceptFailure` body:
  `{ "success": false, "issues": [...] }`.

Exported types: `InterceptIssue` and `InterceptFailure`.

## `@rhythmjs/middleware/filter`

### `filter(onError?)`

Returns an exception filter: a middleware that catches anything thrown deeper in the chain and turns it into an
HTTP response. Register it first on a router so it is the outermost layer.

```ts
const router = new RhythmRouter().use(filter()).get("/users/:id", () => {
  throw new HttpError(404, "user not found");
});
// GET /users/1 => 404 {"success":false,"status":404,"message":"user not found"}
```

- `throw new HttpError(status, message, details?)` maps to that status with a `FilterFailure` JSON body:
  `{ "success": false, "status": 404, "message": "...", "details": ... }`. `details` is omitted when it
  is not given.
- Any other thrown value (an `Error`, a string, a rejected promise) maps to
  `500 { "success": false, "status": 500, "message": "Internal Server Error" }`. The original message is never
  sent to the client, and the default mapping does not log it.
- `filter(onError)` replaces the default mapping entirely. `onError(error, ctx)` may be async and is
  responsible for writing the response (`ctx.json(...)`, `ctx.text(...)`) and for any logging; if it does
  not respond, nothing has been written and `toFetchHandler` answers `404`. It can also rethrow.

```ts
const router = new RhythmRouter()
  .use(
    filter((error, ctx) => {
      if (error instanceof HttpError) {
        ctx.json({ error: error.message }, error.status);
        return;
      }
      console.error(error);
      ctx.json({ error: "Internal Server Error" }, 500);
    }),
  )
  .get("/boom", () => {
    throw new Error("boom");
  });
```

`HttpError` extends `Error` and has `status`, `message`, and `details`.

Exported: `filter`, `HttpError`, and the type `FilterFailure`.

## Testing

Use [`@rhythmjs/testing`](https://github.com/rhythmjs/testing) to drive a router in memory, with no
sockets or ports:

```ts
import { createTestClient } from "@rhythmjs/testing/router";

const client = createTestClient(usersRouter);

const bad = await client.post("/users", { json: { name: "" } });
expect(bad.status).toBe(400);

const ok = await client.post("/users", { json: { name: "Ada", age: "36" } });
expect(ok.status).toBe(201);
expect(await ok.json()).toEqual({ id: 1, name: "Ada", age: 36 });
```
