const DEFAULT_LOCAL_OPENAI_BASE_URL = "http://127.0.0.1:4141/v1";
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const PROVIDER_HEADER = "x-researchbox-provider";

export async function proxyLocalOpenAiRequest(
  request: Request,
  pathname: "/models" | "/chat/completions",
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    !isLoopbackHostname(requestUrl.hostname) ||
    request.headers.get(PROVIDER_HEADER) !== "local-openai" ||
    (origin !== null && !isSameOrigin(origin, requestUrl.origin)) ||
    (fetchSite !== null && fetchSite !== "same-origin")
  ) {
    return Response.json(
      { error_message: "Local provider access is restricted to rrbox." },
      { status: 403 },
    );
  }

  const baseUrl = (
    process.env.RESEARCHBOX_LOCAL_OPENAI_BASE_URL ??
    DEFAULT_LOCAL_OPENAI_BASE_URL
  ).replace(/\/$/, "");
  const headers = new Headers({ accept: request.headers.get("accept") ?? "*/*" });
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  let body: ArrayBuffer | undefined;
  if (request.method !== "GET") {
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return requestTooLargeResponse();
    }
    try {
      body = await request.arrayBuffer();
    } catch {
      return Response.json(
        { error_message: "The provider request body could not be read." },
        { status: 400 },
      );
    }
    if (body.byteLength > MAX_REQUEST_BYTES) return requestTooLargeResponse();
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(
          pathname === "/models" ? 15_000 : 10 * 60 * 1_000,
        ),
      ]),
    });
  } catch (error) {
    return Response.json(
      {
        error_message:
          error instanceof Error
            ? `Local OpenAI provider is unavailable: ${error.message}`
            : "Local OpenAI provider is unavailable.",
      },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  for (const name of ["content-type", "x-request-id"] as const) {
    const value = response.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function isSameOrigin(value: string, expectedOrigin: string): boolean {
  try {
    return new URL(value).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function requestTooLargeResponse(): Response {
  return Response.json(
    { error_message: "The provider request body is too large." },
    { status: 413 },
  );
}
