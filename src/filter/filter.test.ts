import { describe, expect, test } from "bun:test";
import { Rhythm } from "@rhythmjs/rhythm";
import { compose } from "@rhythmjs/rhythm/compose";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import { z } from "zod";
import { intercept } from "../intercept/intercept";
import { validate } from "../validate/validate";
import { filter, HttpError, type FilterFailure } from "./filter";

const serve = (router: RhythmRouter) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

const failureBody = (res: Response) => res.json() as Promise<FilterFailure>;

describe("filter", () => {
  test("maps a thrown HttpError to its status and JSON body", async () => {
    const app = serve(
      new RhythmRouter().use(filter()).get("/users/:id", () => {
        throw new HttpError(404, "user not found");
      }),
    );

    const res = await app(new Request("http://localhost/users/7"));

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ success: false, status: 404, message: "user not found" });
  });

  test("includes details when the HttpError carries them", async () => {
    const app = serve(
      new RhythmRouter().use(filter()).post("/orders", () => {
        throw new HttpError(422, "cannot process order", { reason: "out of stock" });
      }),
    );

    const res = await app(new Request("http://localhost/orders", { method: "POST" }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      success: false,
      status: 422,
      message: "cannot process order",
      details: { reason: "out of stock" },
    });
  });

  test("maps an unknown Error to a generic 500 without leaking its message", async () => {
    const app = serve(
      new RhythmRouter().use(filter()).get("/boom", () => {
        throw new Error("db password is hunter2");
      }),
    );

    const res = await app(new Request("http://localhost/boom"));

    expect(res.status).toBe(500);
    const body = await failureBody(res);
    expect(body).toEqual({ success: false, status: 500, message: "Internal Server Error" });
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  test("maps a thrown non-Error value to a generic 500", async () => {
    const app = serve(new RhythmRouter().use(filter()).get("/boom", () => Promise.reject("boom")));

    const res = await app(new Request("http://localhost/boom"));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, status: 500, message: "Internal Server Error" });
  });

  test("catches errors thrown in downstream middleware, not just handlers", async () => {
    const app = serve(
      new RhythmRouter().use(filter()).get(
        "/guarded",
        () => {
          throw new HttpError(401, "unauthorized");
        },
        (ctx) => {
          ctx.response.body = "unreachable";
        },
      ),
    );

    const res = await app(new Request("http://localhost/guarded"));

    expect(res.status).toBe(401);
    expect((await failureBody(res)).message).toBe("unauthorized");
  });

  test("onError replaces the default mapping entirely", async () => {
    const app = serve(
      new RhythmRouter()
        .use(
          filter((error, ctx) => {
            ctx.response.status = 409;
            ctx.response.body = error instanceof Error ? `conflict: ${error.message}` : "conflict";
          }),
        )
        .get("/conflict", () => {
          throw new HttpError(404, "would be 404 by default");
        }),
    );

    const res = await app(new Request("http://localhost/conflict"));

    expect(res.status).toBe(409);
    expect(await res.text()).toBe("conflict: would be 404 by default");
  });

  test("leaves successful responses untouched across multiple routes", async () => {
    const app = serve(
      new RhythmRouter()
        .use(filter())
        .get("/a", (ctx) => {
          ctx.response.body = "a";
        })
        .get("/b", (ctx) => {
          ctx.response.status = 201;
          ctx.response.body = "b";
        }),
    );

    const a = await app(new Request("http://localhost/a"));
    expect(a.status).toBe(200);
    expect(await a.text()).toBe("a");

    const b = await app(new Request("http://localhost/b"));
    expect(b.status).toBe(201);
    expect(await b.text()).toBe("b");
  });

  test("composes with intercept and validate", async () => {
    const CreateUser = z.object({ first_name: z.string(), last_name: z.string() });
    const User = z
      .object({ first_name: z.string(), last_name: z.string() })
      .transform((u) => ({ fullName: `${u.first_name} ${u.last_name}` }));

    const app = serve(
      new RhythmRouter()
        .use(filter())
        .post("/users", compose([intercept(User), validate("body", CreateUser)]), (ctx) => {
          if (ctx.valid.body.first_name === "Grace") throw new HttpError(409, "user already exists");
          ctx.response.body = JSON.stringify(ctx.valid.body);
        }),
    );

    const jsonRequest = (body: unknown) =>
      new Request("http://localhost/users", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });

    const ok = await app(jsonRequest({ first_name: "Ada", last_name: "Lovelace" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ fullName: "Ada Lovelace" });

    const invalid = await app(jsonRequest({ first_name: "Ada" }));
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { target: string }).target).toBe("body");

    const thrown = await app(jsonRequest({ first_name: "Grace", last_name: "Hopper" }));
    expect(thrown.status).toBe(409);
    expect(await thrown.json()).toEqual({ success: false, status: 409, message: "user already exists" });
  });
});
