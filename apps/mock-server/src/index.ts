import {
  parseModelRequest,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelConversationMessage,
} from "@researchbox/model-transport";

export async function handleMockModelRequest(
  request: Request,
): Promise<Response> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return errorResponse("Expected an application/json request.");
  }

  let modelRequest: ModelRequest;
  try {
    modelRequest = parseModelRequest(await request.json());
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "Request body must be valid JSON.",
    );
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
  const lastUserIndex = request.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const prompt =
    lastUserIndex < 0 ? "" : request.messages[lastUserIndex]?.content ?? "";
  const toolResults = request.messages
    .slice(lastUserIndex + 1)
    .filter(
      (message): message is Extract<
        ModelConversationMessage,
        { role: "tool" }
      > => message.role === "tool",
    );
  const normalizedPrompt = prompt.toLowerCase();
  const shouldInspectFiles = ["file", "workspace", "readme", "project"].some(
    (term) => normalizedPrompt.includes(term),
  );

  if (shouldInspectFiles && toolResults.length === 0) {
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
    ? responseFromToolResult(toolResults[0])
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

function responseFromToolResult(
  result:
    | Extract<ModelConversationMessage, { role: "tool" }>
    | undefined,
): string {
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

function errorResponse(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function splitForStreaming(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
