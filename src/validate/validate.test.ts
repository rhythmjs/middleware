import { describe, expect, test } from "vite-plus/test";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Rhythm } from "@rhythmjs/rhythm";
import { compose } from "@rhythmjs/rhythm/compose";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/adapters/bun";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import { z } from "zod";
import { validate, type ValidationFailure } from "./validate";

const serve = (router: RhythmRouter) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

const jsonRequest = (url: string, body: unknown) =>
  new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

const failureBody = (res: Response) => res.json() as Promise<ValidationFailure>;

describe('validate("body", schema)', () => {
  const createUser = z.object({ name: z.string().min(1), age: z.coerce.number().int() });

  const app = () =>
    serve(
      new RhythmRouter().post("/users", validate("body", createUser), (ctx) => {
        ctx.response.headers.set("content-type", "application/json");
        ctx.response.body = JSON.stringify(ctx.valid.body);
      }),
    );

  test("passes a valid body through and exposes the schema output on ctx.valid.body", async () => {
    const res = await app()(jsonRequest("http://localhost/users", { name: "Ada", age: "36" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Ada", age: 36 });
  });

  test("rejects an invalid body with 400 and serialized issues, without running the handler", async () => {
    const res = await app()(jsonRequest("http://localhost/users", { name: "", age: "not-a-number" }));

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await failureBody(res);
    expect(body.success).toBe(false);
    expect(body.target).toBe("body");
    expect(body.issues.map((issue) => issue.path)).toEqual([["name"], ["age"]]);
  });

  test("rejects malformed JSON with 400", async () => {
    const res = await app()(
      new Request("http://localhost/users", {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(400);
    const body = await failureBody(res);
    expect(body.issues).toEqual([{ message: "Malformed JSON in request body" }]);
  });

  test("leaves the request body readable for later handlers", async () => {
    const echo = serve(
      new RhythmRouter().post("/users", validate("body", createUser), async (ctx) => {
        ctx.response.body = JSON.stringify(await ctx.request.clone().json());
      }),
    );

    const res = await echo(jsonRequest("http://localhost/users", { name: "Ada", age: 36 }));
    expect(await res.json()).toEqual({ name: "Ada", age: 36 });
  });

  test("issue paths serialize nested and PathSegment-style keys", async () => {
    const nested = z.object({ author: z.object({ name: z.string() }) });
    const app = serve(
      new RhythmRouter().post("/books", validate("body", nested), (ctx) => {
        ctx.response.body = "ok";
      }),
    );

    const res = await app(jsonRequest("http://localhost/books", { author: { name: 5 } }));

    expect(res.status).toBe(400);
    expect((await failureBody(res)).issues[0].path).toEqual(["author", "name"]);
  });
});

describe('validate("query", schema)', () => {
  const listQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    tag: z.union([z.string(), z.array(z.string())]).optional(),
  });

  const app = () =>
    serve(
      new RhythmRouter().get("/posts", validate("query", listQuery), (ctx) => {
        ctx.response.body = JSON.stringify(ctx.valid.query);
      }),
    );

  test("coerces and defaults query values", async () => {
    const res = await app()(new Request("http://localhost/posts?page=3"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ page: 3 });
  });

  test("collects repeated query keys into an array", async () => {
    const res = await app()(new Request("http://localhost/posts?tag=a&tag=b"));

    expect(await res.json()).toEqual({ page: 1, tag: ["a", "b"] });
  });

  test("rejects an invalid query with 400", async () => {
    const res = await app()(new Request("http://localhost/posts?page=0"));

    expect(res.status).toBe(400);
    expect((await failureBody(res)).target).toBe("query");
  });
});

describe('validate("param", schema)', () => {
  const userParams = z.object({ id: z.coerce.number().int().positive() });

  const app = () =>
    serve(
      new RhythmRouter().get("/users/:id", validate("param", userParams), (ctx) => {
        ctx.response.body = JSON.stringify({ id: ctx.valid.param.id, type: typeof ctx.valid.param.id });
      }),
    );

  test("validates and coerces route params matched by the router", async () => {
    const res = await app()(new Request("http://localhost/users/42"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 42, type: "number" });
  });

  test("rejects params that fail the schema with 400", async () => {
    const res = await app()(new Request("http://localhost/users/abc"));

    expect(res.status).toBe(400);
    expect((await failureBody(res)).target).toBe("param");
  });
});

describe("validate (composition)", () => {
  test("chained validators merge their results under ctx.valid", async () => {
    const bodySchema = z.object({ title: z.string() });
    const querySchema = z.object({ draft: z.coerce.boolean().default(false) });

    const app = serve(
      new RhythmRouter().post(
        "/articles",
        compose([validate("body", bodySchema), validate("query", querySchema)]),
        (ctx) => {
          ctx.response.body = JSON.stringify({ ...ctx.valid.body, ...ctx.valid.query });
        },
      ),
    );

    const res = await app(jsonRequest("http://localhost/articles?draft=true", { title: "Hello" }));

    expect(await res.json()).toEqual({ title: "Hello", draft: true });
  });

  test("accepts any Standard Schema v1 implementation, including async ones", async () => {
    const uppercase: StandardSchemaV1<string, string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value) =>
          typeof value === "string" ? { value: value.toUpperCase() } : { issues: [{ message: "expected a string" }] },
      },
    };

    const app = serve(
      new RhythmRouter().post("/shout", validate("body", uppercase), (ctx) => {
        ctx.response.body = ctx.valid.body;
      }),
    );

    const ok = await app(jsonRequest("http://localhost/shout", "hello"));
    expect(await ok.text()).toBe("HELLO");

    const bad = await app(jsonRequest("http://localhost/shout", 7));
    expect(bad.status).toBe(400);
    expect((await failureBody(bad)).issues).toEqual([{ message: "expected a string" }]);
  });
});
