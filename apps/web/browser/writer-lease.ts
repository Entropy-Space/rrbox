export const RESEARCHBOX_WRITER_LOCK = "researchbox:core-writer:v1";

type LockManagerLike = Pick<LockManager, "request">;

type MessageHost = {
  onmessage: ((message: MessageEvent<unknown>) => void) | null;
};

export async function withExclusiveWriterLease<T>(
  lockManager: LockManagerLike,
  operation: () => Promise<T>,
): Promise<T> {
  return await lockManager.request(
    RESEARCHBOX_WRITER_LOCK,
    { mode: "exclusive" },
    async () => await operation(),
  );
}

export function queueMessagesUntilStarted(host: MessageHost): () => void {
  const queuedMessages: MessageEvent<unknown>[] = [];
  host.onmessage = (message) => queuedMessages.push(message);
  return () => {
    const activeHandler = host.onmessage;
    if (!activeHandler) throw new Error("Worker host was not attached.");
    for (const message of queuedMessages) activeHandler(message);
    queuedMessages.length = 0;
  };
}
