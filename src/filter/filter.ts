import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/context";

export interface FilterFailure {
  success: false;
  status: number;
  message: string;
  details?: unknown;
}

export class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export function filter(
  onError?: (error: unknown, ctx: Parameters<Middleware<RhythmHttpContext>>[0]) => void | Promise<void>,
): Middleware<RhythmHttpContext> {
  return async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      if (onError) {
        await onError(error, ctx);
        return;
      }
      const failure: FilterFailure =
        error instanceof HttpError
          ? {
              success: false,
              status: error.status,
              message: error.message,
              ...(error.details === undefined ? {} : { details: error.details }),
            }
          : { success: false, status: 500, message: "Internal Server Error" };
      ctx.json(failure, failure.status);
    }
  };
}
