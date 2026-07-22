export const RESEARCHBOX_WRITER_LOCK = "researchbox:core-writer:v1";

export type WriterLockManager = {
  request<T>(
    name: string,
    options:
      | {
          mode: "exclusive";
          ifAvailable: true;
          signal?: never;
        }
      | {
          mode: "exclusive";
          ifAvailable?: false;
          signal?: AbortSignal;
        },
    operation: (lock: Lock | null) => Promise<T> | T,
  ): Promise<T>;
};

export async function withExclusiveWriterLease<T>(
  lockManager: WriterLockManager,
  operation: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    onWaiting?: () => void;
  } = {},
): Promise<T> {
  options.signal?.throwIfAborted();

  let acquiredImmediately = false;
  const immediateResult = await lockManager.request(
    RESEARCHBOX_WRITER_LOCK,
    {
      mode: "exclusive",
      ifAvailable: true,
    },
    async (lock) => {
      if (!lock) return undefined as T;
      options.signal?.throwIfAborted();
      acquiredImmediately = true;
      return operation();
    },
  );
  if (acquiredImmediately) return immediateResult;

  options.signal?.throwIfAborted();
  options.onWaiting?.();
  return await lockManager.request(
    RESEARCHBOX_WRITER_LOCK,
    {
      mode: "exclusive",
      ...(options.signal ? { signal: options.signal } : {}),
    },
    async (lock) => {
      if (!lock) throw new Error("The workspace writer lock was not granted.");
      return operation();
    },
  );
}
