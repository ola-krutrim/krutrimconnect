import { AsyncLocalStorage } from "node:async_hooks";

type MutationObserver = (target: string, afterSha256: string | null) => Promise<void>;
const observer = new AsyncLocalStorage<MutationObserver>();

/** Scope a write-ahead guard to this async operation, never other callers. */
export async function withFileMutationObserver<T>(
  guard: MutationObserver,
  operation: () => Promise<T>,
): Promise<T> {
  return await observer.run(guard, operation);
}

export async function beforeFileMutation(target: string, afterSha256: string | null): Promise<void> {
  await observer.getStore()?.(target, afterSha256);
}
