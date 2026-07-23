import {
  parseModelRequest,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelConversationMessage,
  type ModelToolCall,
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
          await delay(
            chunk.type === "text_delta" ||
              chunk.type === "reasoning_delta" ||
              chunk.type === "tool_call_delta"
              ? 38
              : 90,
          );
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
  const lastUser =
    lastUserIndex < 0 ? undefined : request.messages[lastUserIndex];
  const prompt = lastUser?.role === "user" ? lastUser.content : "";
  const toolResults = request.messages
    .slice(lastUserIndex + 1)
    .filter(
      (message): message is Extract<
        ModelConversationMessage,
        { role: "tool" }
      > => message.role === "tool",
    );
  const normalizedPrompt = prompt.toLowerCase();
  const shouldCreateNote =
    normalizedPrompt.includes("create") &&
    normalizedPrompt.includes("note");
  const shouldInspectFiles = ["file", "workspace", "readme", "project"].some(
    (term) => normalizedPrompt.includes(term),
  );

  if (shouldCreateNote && toolResults.length === 0) {
    const toolCall: ModelToolCall = {
      tool_call_id: crypto.randomUUID(),
      tool_name: "write_file",
      arguments: {
        path: "/notes/agent-note.md",
        content: [
          "# Agent note",
          "",
          "Created by the ResearchBox mock agent.",
          "",
          "- The agent core runs in a Web Worker.",
          "- Files live behind a portable virtual filesystem.",
          "- Viewer and core communicate through versioned JSON.",
          "",
        ].join("\n"),
      },
    };
    return [
      ...reasoningEvents(
        "A concise workspace note will make the prototype state easy to inspect.",
        0,
      ),
      ...textEvents("I’ll create a short workspace note now.", 1),
      ...toolCallEvents(toolCall, 2),
      { type: "done", stop_reason: "tool_use" },
    ];
  }

  if (shouldInspectFiles && toolResults.length === 0) {
    const toolCall: ModelToolCall = normalizedPrompt.includes("readme")
      ? {
          tool_call_id: crypto.randomUUID(),
          tool_name: "read_file",
          arguments: { path: "/README.md" },
        }
      : {
          tool_call_id: crypto.randomUUID(),
          tool_name: "list_files",
          arguments: { path: "/" },
        };
    return [
      ...reasoningEvents(
        "I should inspect the requested workspace context before answering.",
        0,
      ),
      ...textEvents("I’ll inspect the workspace first.", 1),
      ...toolCallEvents(toolCall, 2),
      { type: "done", stop_reason: "tool_use" },
    ];
  }

  const response = shouldCreateNote || shouldInspectFiles
    ? responseFromToolResult(toolResults[0])
    : "This prototype is running through a versioned JSON boundary. The viewer only renders events; the agent core owns the conversation and tools inside a Web Worker. That gives us a clean path from today’s mock model to Pi without coupling the interface to either one.";

  return [
    ...reasoningEvents(
      toolResults.length > 0
        ? "The workspace result is available, so I can summarize the outcome."
        : "I can answer this directly from the current prototype context.",
      0,
    ),
    ...textEvents(response, 1),
    { type: "done" },
  ];
}

function textEvents(text: string, contentIndex: number): ModelStreamEvent[] {
  return [
    { type: "text_start", content_index: contentIndex },
    ...splitForStreaming(text).map(
      (textDelta): ModelStreamEvent => ({
        type: "text_delta",
        content_index: contentIndex,
        text_delta: textDelta,
      }),
    ),
    { type: "text_end", content_index: contentIndex },
  ];
}

function reasoningEvents(
  reasoning: string,
  contentIndex: number,
): ModelStreamEvent[] {
  return [
    { type: "reasoning_start", content_index: contentIndex },
    ...splitForStreaming(reasoning).map(
      (reasoningDelta): ModelStreamEvent => ({
        type: "reasoning_delta",
        content_index: contentIndex,
        reasoning_delta: reasoningDelta,
      }),
    ),
    { type: "reasoning_end", content_index: contentIndex },
  ];
}

function toolCallEvents(
  toolCall: ModelToolCall,
  contentIndex: number,
): ModelStreamEvent[] {
  return [
    { type: "tool_call_start", content_index: contentIndex },
    {
      type: "tool_call_delta",
      content_index: contentIndex,
      tool_call_id_delta: toolCall.tool_call_id,
      tool_name_delta: toolCall.tool_name,
      arguments_delta: JSON.stringify(toolCall.arguments),
    },
    {
      type: "tool_call_end",
      content_index: contentIndex,
      tool_call: toolCall,
    },
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
    return `I tried to use the workspace, but the tool reported: ${result.content}`;
  }
  if (result.tool_name === "write_file") {
    return "I created `/notes/agent-note.md` in the project workspace. It is already visible in the file browser, and the change card records the path and line statistics.";
  }
  if (result.tool_name === "replace_text") {
    return "I updated the requested text in the workspace. The exact-match edit and its durable change record both completed successfully.";
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
