import { describe, expect, test } from "vite-plus/test";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/adapters/bun";
import { z } from "zod";
import { validate, type Validated } from "../validate/validate";
import { intercept, type InterceptFailure } from "./intercept";

const failureBody = (res: Response) => res.json() as Promise<InterceptFailure>;

describe("intercept", () => {
  const User = z
    .object({ first_name: z.string(), last_name: z.string() })
    .transform((u) => ({ fullName: `${u.first_name} ${u.last_name}` }));

  test("intercepts the response and transforms it through the schema", async () => {
    const app = toFetchHandler(
      new RhythmRouter().get("/users/ada", intercept(User), (ctx) => {
        ctx.response.body = JSON.stringify({ first_name: "Ada", last_name: "Lovelace" });
      }),
    );

    const res = await app(new Request("http://localhost/users/ada"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ fullName: "Ada Lovelace" });
  });

  test("strips fields the schema does not declare", async () => {
    const Public = z.object({ id: z.number(), name: z.string() });
    const app = toFetchHandler(
      new RhythmRouter().get("/users/1", intercept(Public), (ctx) => {
        ctx.response.body = JSON.stringify({ id: 1, name: "Ada", password: "s3cret" });
      }),
    );

    const res = await app(new Request("http://localhost/users/1"));

    expect(await res.json()).toEqual({ id: 1, name: "Ada" });
  });

  test("applies to every route when registered with use()", async () => {
    const app = toFetchHandler(
      new RhythmRouter()
        .use(intercept(User))
        .get("/a", (ctx) => {
          ctx.response.body = JSON.stringify({ first_name: "Ada", last_name: "Lovelace" });
        })
        .get("/b", (ctx) => {
          ctx.response.body = JSON.stringify({ first_name: "Grace", last_name: "Hopper" });
        }),
    );

    expect(await (await app(new Request("http://localhost/a"))).json()).toEqual({ fullName: "Ada Lovelace" });
    expect(await (await app(new Request("http://localhost/b"))).json()).toEqual({ fullName: "Grace Hopper" });
  });

  test("responds 500 with issues when the response does not match the schema", async () => {
    const app = toFetchHandler(
      new RhythmRouter().get("/users/bad", intercept(User), (ctx) => {
        ctx.response.body = JSON.stringify({ first_name: "Ada" });
      }),
    );

    const res = await app(new Request("http://localhost/users/bad"));

    expect(res.status).toBe(500);
    const body = await failureBody(res);
    expect(body.success).toBe(false);
    expect(body.issues[0].path).toEqual(["last_name"]);
  });

  test("leaves non-2xx responses untouched", async () => {
    const app = toFetchHandler(
      new RhythmRouter().get("/missing", intercept(User), (ctx) => {
        ctx.response.status = 404;
        ctx.response.body = "not found";
      }),
    );

    const res = await app(new Request("http://localhost/missing"));

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  test("leaves non-string bodies untouched", async () => {
    const app = toFetchHandler(
      new RhythmRouter().get("/empty", intercept(User), (ctx) => {
        ctx.response.status = 204;
        ctx.response.body = null;
      }),
    );

    const res = await app(new Request("http://localhost/empty"));

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("passes non-JSON string bodies to the schema as raw strings", async () => {
    const Upper = z.string().transform((s) => s.toUpperCase());
    const app = toFetchHandler(
      new RhythmRouter().get("/greet", intercept(Upper), (ctx) => {
        ctx.response.body = "hello";
      }),
    );

    const res = await app(new Request("http://localhost/greet"));

    expect(await res.text()).toBe("HELLO");
  });

  test("accepts any Standard Schema v1 implementation, including async ones", async () => {
    const wrap: StandardSchemaV1<unknown, { data: unknown }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value) => ({ value: { data: value } }),
      },
    };

    const app = toFetchHandler(
      new RhythmRouter().get("/wrapped", intercept(wrap), (ctx) => {
        ctx.response.body = JSON.stringify([1, 2, 3]);
      }),
    );

    const res = await app(new Request("http://localhost/wrapped"));

    expect(await res.json()).toEqual({ data: [1, 2, 3] });
  });

  test("composes with validate: request validated in, response transformed out", async () => {
    const CreateUser = z.object({ first_name: z.string(), last_name: z.string() });
    const app = toFetchHandler(
      new RhythmRouter().post<Validated<"body", typeof CreateUser>>(
        "/users",
        intercept(User),
        validate("body", CreateUser),
        (ctx) => {
          ctx.response.body = JSON.stringify(ctx.valid.body);
        },
      ),
    );

    const ok = await app(
      new Request("http://localhost/users", {
        method: "POST",
        body: JSON.stringify({ first_name: "Ada", last_name: "Lovelace" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ fullName: "Ada Lovelace" });

    const bad = await app(
      new Request("http://localhost/users", {
        method: "POST",
        body: JSON.stringify({ first_name: "Ada" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { target: string }).target).toBe("body");
  });
});
