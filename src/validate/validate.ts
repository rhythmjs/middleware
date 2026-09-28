import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Middleware } from "@rhythmjs/rhythm";
import type { RhythmRouterContext } from "@rhythmjs/router";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

export type ValidationTarget = "body" | "query" | "param";

export type ValidationContext = RhythmHttpContext &
  Partial<RhythmRouterContext> & { valid?: Partial<Record<ValidationTarget, unknown>> };

export type Validated<TTarget extends ValidationTarget, TSchema extends StandardSchemaV1> = {
  valid: { [K in TTarget]: StandardSchemaV1.InferOutput<TSchema> };
};

export interface ValidationIssue {
  message: string;
  path?: readonly (string | number)[];
}

export interface ValidationFailure {
  success: false;
  target: ValidationTarget;
  issues: readonly ValidationIssue[];
}

function serializeIssues(issues: readonly StandardSchemaV1.Issue[]): ValidationIssue[] {
  return issues.map((issue) => {
    const path = issue.path?.map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment,
    );
    return {
      message: issue.message,
      ...(path ? { path: path.filter((key): key is string | number => typeof key !== "symbol") } : {}),
    };
  });
}

function collectQuery(url: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(url).searchParams) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

type ExtractResult = { ok: true; value: unknown } | { ok: false; message: string };

async function extract(
  ctx: Parameters<Middleware<ValidationContext>>[0],
  target: ValidationTarget,
): Promise<ExtractResult> {
  switch (target) {
    case "body":
      try {
        return { ok: true, value: await ctx.request.clone().json() };
      } catch {
        return { ok: false, message: "Malformed JSON in request body" };
      }
    case "query":
      return { ok: true, value: collectQuery(ctx.request.url) };
    case "param":
      return { ok: true, value: ctx.params ?? {} };
  }
}

export function validate<TTarget extends ValidationTarget, TSchema extends StandardSchemaV1>(
  target: TTarget,
  schema: TSchema,
): Middleware<ValidationContext> {
  return async (ctx, next) => {
    const fail = (issues: readonly ValidationIssue[]): void => {
      const failure: ValidationFailure = { success: false, target, issues };
      ctx.response.status = 400;
      ctx.response.headers.set("content-type", "application/json");
      ctx.response.body = JSON.stringify(failure);
    };

    const extracted = await extract(ctx, target);
    if (!extracted.ok) {
      fail([{ message: extracted.message }]);
      return;
    }

    const result = await schema["~standard"].validate(extracted.value);
    if (result.issues) {
      fail(serializeIssues(result.issues));
      return;
    }

    const valid = { ...ctx.valid, [target]: result.value };
    await next({ valid } as Validated<TTarget, TSchema>);
  };
}
