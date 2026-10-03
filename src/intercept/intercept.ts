import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

export interface InterceptIssue {
  message: string;
  path?: readonly (string | number)[];
}

export interface InterceptFailure {
  success: false;
  issues: readonly InterceptIssue[];
}

function serializeIssues(issues: readonly StandardSchemaV1.Issue[]): InterceptIssue[] {
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

export function intercept(schema: StandardSchemaV1): Middleware<RhythmHttpContext> {
  return async (ctx, next) => {
    await next();

    const { response } = ctx;
    if (response.status < 200 || response.status >= 300) return;
    if (typeof response.body !== "string") return;

    let value: unknown;
    try {
      value = JSON.parse(response.body);
    } catch {
      value = response.body;
    }

    const result = await schema["~standard"].validate(value);
    if (result.issues) {
      const failure: InterceptFailure = { success: false, issues: serializeIssues(result.issues) };
      ctx.json(failure, 500);
      return;
    }

    if (typeof result.value === "string") {
      response.body = result.value;
      return;
    }
    ctx.json(result.value);
  };
}
