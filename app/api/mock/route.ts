import type {
  ModelRequest,
  ModelStreamEvent,
  ModelToolResult,
} from "@/lib/core/model-transport";

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return errorResponse("Expected an application/json request.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Request body must be valid JSON.");
  }

  const modelRequest = parseModelRequest(body);
  if (!modelRequest) {
    return errorResponse("session_id, prompt, and tool_results are required.");
  }

  const encoder = new TextEncoder();
  const chunks = createMockResponse(modelRequest);
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const chunk of chunks) {
          if (canceled || request.signal.aborted) return;
          await delay(chunk.type === "text_delta" ? 38 : 180);
          if (canceled || request.signal.aborted) return;
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
        }
        if (!canceled && !request.signal.aborted) controller.close();
      } catch (error) {
        if (!canceled && !request.signal.aborted) controller.error(error);
      }
    },
    cancel() {
      canceled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  });
}

function createMockResponse(request: ModelRequest): ModelStreamEvent[] {
  const normalizedPrompt = request.prompt.toLowerCase();
  const shouldInspectFiles = ["file", "workspace", "readme", "project"].some(
    (term) => normalizedPrompt.includes(term),
  );

  if (shouldInspectFiles && request.tool_results.length === 0) {
    return [
      {
        type: "tool_call",
        tool_call_id: crypto.randomUUID(),
        tool_name: normalizedPrompt.includes("readme")
          ? "read_file"
          : "list_files",
        arguments: {
          path: normalizedPrompt.includes("readme") ? "/README.md" : "/",
        },
      },
      { type: "done" },
    ];
  }

  const response = shouldInspectFiles
    ? responseFromToolResult(request.tool_results[0])
    : "This prototype is running through a versioned JSON boundary. The viewer only renders events; the agent core owns the conversation and tools inside a Web Worker. That gives us a clean path from today’s mock model to Pi without coupling the interface to either one.";

  return [
    ...splitForStreaming(response).map(
      (textDelta): ModelStreamEvent => ({
        type: "text_delta",
        text_delta: textDelta,
      }),
    ),
    { type: "done" },
  ];
}

function responseFromToolResult(result: ModelToolResult | undefined): string {
  if (!result) {
    return "The workspace tool returned no result, so I could not inspect it.";
  }
  if (result.is_error) {
    return `I tried to inspect the workspace, but the tool reported: ${result.content}`;
  }
  if (result.tool_name === "read_file") {
    return "I read the project README. It confirms the intended architecture: a versioned viewer protocol, a worker-hosted agent core, and storage behind a virtual filesystem interface. The next useful step is an OPFS adapter so this workspace persists across browser sessions without changing the agent tools.";
  }
  return "I inspected the browser workspace and found the README, notes, and source directories. The separation between the viewer, worker-hosted core, and virtual filesystem is already visible. The next useful step is an OPFS adapter so the same files survive refreshes without changing any agent tools.";
}

function parseModelRequest(value: unknown): ModelRequest | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.session_id !== "string" ||
    !value.session_id ||
    typeof value.prompt !== "string" ||
    !value.prompt.trim() ||
    !Array.isArray(value.tool_results)
  ) {
    return null;
  }

  const toolResults: ModelToolResult[] = [];
  for (const result of value.tool_results) {
    if (!isRecord(result)) return null;
    if (
      typeof result.tool_call_id !== "string" ||
      (result.tool_name !== "list_files" && result.tool_name !== "read_file") ||
      typeof result.content !== "string" ||
      typeof result.is_error !== "boolean"
    ) {
      return null;
    }
    toolResults.push({
      tool_call_id: result.tool_call_id,
      tool_name: result.tool_name,
      content: result.content,
      is_error: result.is_error,
    });
  }

  return {
    session_id: value.session_id,
    prompt: value.prompt.trim(),
    tool_results: toolResults,
  };
}

function errorResponse(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function splitForStreaming(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
