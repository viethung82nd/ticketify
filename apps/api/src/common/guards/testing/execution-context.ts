import type { ExecutionContext } from '@nestjs/common';

/** Minimal HTTP `ExecutionContext` for guard unit tests. */
export function httpContext(
  request: object,
  controller: abstract new (...args: never[]) => unknown,
  handlerName: string,
): ExecutionContext {
  const handler = (controller.prototype as Record<string, unknown>)[handlerName];
  if (typeof handler !== 'function') throw new Error(`No handler ${handlerName}`);
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}
