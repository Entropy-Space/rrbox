import { handleMockModelRequest } from "@researchbox/mock-provider";
import {
  researchBoxMockModelDescriptor,
} from "@researchbox/app-runtime-browser/mock-model";
import {
  HttpNdjsonModelTransport,
  type ModelDescriptor,
} from "@researchbox/model-transport";
import {
  attachLlmWorkerHost,
  type LlmWorkerHost,
} from "@researchbox/runtime-browser";

export const IN_PROCESS_MOCK_MODEL_ENDPOINT =
  "https://mock.researchbox.invalid/v1/model";

export const nativeMockModel: ModelDescriptor =
  researchBoxMockModelDescriptor;

type InProcessRequestHandler = (request: Request) => Promise<Response>;

export function attachNativeMockLlmWorker(
  host: LlmWorkerHost,
  requestHandler: InProcessRequestHandler = handleMockModelRequest,
): { close(): void } {
  const transport = new HttpNdjsonModelTransport(
    IN_PROCESS_MOCK_MODEL_ENDPOINT,
    createInProcessFetch(requestHandler),
  );

  return attachLlmWorkerHost(host, transport, {
    async listModels(
      providerId: string,
      signal: AbortSignal,
    ): Promise<ModelDescriptor[]> {
      throwIfAborted(signal);
      if (providerId !== nativeMockModel.provider_id) {
        throw new Error(`Unknown model provider: ${providerId}`);
      }
      return [nativeMockModel];
    },
  });
}

export function createInProcessFetch(
  requestHandler: InProcessRequestHandler = handleMockModelRequest,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    throwIfAborted(request.signal);
    const response = await waitForResponse(
      requestHandler(request),
      request.signal,
    );
    throwIfAborted(request.signal);
    return withAbortableBody(response, request.signal);
  };
}

function waitForResponse(
  response: Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(createAbortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    response.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function withAbortableBody(
  response: Response,
  signal: AbortSignal,
): Response {
  if (!response.body) return response;

  const source = response.body.getReader();
  let isFinished = false;
  let isAborted = false;
  let removeAbortListener = () => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => {
        if (isFinished) return;
        isAborted = true;
        isFinished = true;
        removeAbortListener();
        controller.error(createAbortError(signal));
        void source.cancel(signal.reason).catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", abort);
    },
    async pull(controller) {
      try {
        const { done, value } = await source.read();
        if (isAborted) return;
        if (done) {
          isFinished = true;
          removeAbortListener();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        if (isFinished) return;
        isFinished = true;
        removeAbortListener();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (isFinished) return;
      isFinished = true;
      removeAbortListener();
      await source.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError(signal);
}

function createAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}
