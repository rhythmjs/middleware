import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { DeriveMiddleware, Middleware } from "@rhythmjs/rhythm/types";
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
  const out = new Map<string, string | string[]>();
  for (const [key, value] of new URL(url).searchParams) {
    const existing = out.get(key);
    if (existing === undefined) out.set(key, value);
    else if (Array.isArray(existing)) existing.push(value);
    else out.set(key, [existing, value]);
  }
  return Object.fromEntries(out);
}

type ExtractResult = { ok: true; value: unknown } | { ok: false; message: string };

async function extract(ctx: ValidationContext, target: ValidationTarget): Promise<ExtractResult> {
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
): DeriveMiddleware<ValidationContext, Validated<TTarget, TSchema>> {
  const middleware: Middleware<ValidationContext> = async (ctx, next) => {
    const fail = (issues: readonly ValidationIssue[]): void => {
      const failure: ValidationFailure = { success: false, target, issues };
      ctx.json(failure, 400);
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

    ctx.valid = { ...ctx.valid, [target]: result.value };
    await next();
  };
  return middleware as DeriveMiddleware<ValidationContext, Validated<TTarget, TSchema>>;
}
