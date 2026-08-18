type AsyncFrame<T> = {
  parent: AsyncFrame<T> | undefined;
  store: T;
};

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) && typeof (value as PromiseLike<unknown>).then === "function";
}

/**
 * Browser-worker compatibility for DSH's process-local initiator tracking.
 *
 * This deliberately supports one foreground async chain at a time. It keeps
 * the active frame until the returned promise settles, which is sufficient for
 * dshrbox's serialized loop but cannot isolate detached or concurrent chains.
 * The public runtime refuses overlapping turns and configures serial tools.
 */
export class AsyncLocalStorage<T> {
  private frame: AsyncFrame<T> | undefined;
  private generation = 0;

  disable(): void {
    this.frame = undefined;
    this.generation += 1;
  }

  getStore(): T | undefined {
    return this.frame?.store;
  }

  run<R, A extends unknown[]>(
    store: T,
    callback: (...args: A) => R,
    ...args: A
  ): R {
    const parent = this.frame;
    const frame = { parent, store };
    const generation = this.generation;
    this.frame = frame;

    let result: R;
    try {
      result = callback(...args);
    } catch (error) {
      this.restore(frame, parent, generation);
      throw error;
    }

    if (isThenable(result)) {
      void result.then(
        () => this.restore(frame, parent, generation),
        () => this.restore(frame, parent, generation),
      );
    } else {
      this.restore(frame, parent, generation);
    }
    return result;
  }

  private restore(
    frame: AsyncFrame<T>,
    parent: AsyncFrame<T> | undefined,
    generation: number,
  ): void {
    if (this.generation === generation && this.frame === frame) {
      this.frame = parent;
    }
  }
}
