import {
  parseModelRequest,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelConversationMessage,
  type ModelToolCall,
} from "@researchbox/model-transport";

const createNoteIntroduction = [
  "I’ll create a **short workspace note** now.",
  "",
  "- It will live in the project workspace.",
  "- You can inspect it from the file browser.",
].join("\n");

const createNoteIntroductionDeltas = [
  "I’ll create a *",
  "*short workspace note",
  "*",
  "* now.\n\n",
  "- It will live in the project workspace.\n",
  "- You can inspect it from the file browser.",
];

const createNoteResult = [
  "**Created:** `/notes/agent-note.md`",
  "",
  "```md",
  "# Agent note",
  "- Worker-hosted agent core",
  "- Portable virtual filesystem",
  "- Versioned JSON boundary",
  "```",
  "",
  "The note is ready in the file browser, and the change card records its path and line statistics.",
].join("\n");

const createNoteResultDeltas = [
  "*",
  "*Created:",
  "*",
  "* `/notes/agent-note.md`\n\n",
  "`",
  "``md\n",
  "# Agent note\n",
  "- Worker-hosted agent core\n",
  "- Portable virtual filesystem\n",
  "- Versioned JSON boundary\n",
  "`",
  "``\n\n",
  "The note is ready in the file browser, and the change card records its path and line statistics.",
];

type MockTextResponse = {
  text: string;
  deltas?: string[];
};

type MockSearchMatch = {
  path: string;
  line_number: number;
  column_number: number;
  preview: string;
};

type MockSearchResult = {
  workspace_revision: number;
  path: string;
  query: string;
  matches: MockSearchMatch[];
  files_scanned: number;
  truncated: boolean;
};

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
  const searchQuery = workspaceSearchQuery(prompt);
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
      ...textEvents(
        createNoteIntroduction,
        1,
        createNoteIntroductionDeltas,
      ),
      ...toolCallEvents(toolCall, 2),
      { type: "done", stop_reason: "tool_use" },
    ];
  }

  if (searchQuery !== null && toolResults.length === 0) {
    const toolCall: ModelToolCall = {
      tool_call_id: crypto.randomUUID(),
      tool_name: "search_files",
      arguments: {
        path: "/",
        query: searchQuery,
      },
    };
    return [
      ...reasoningEvents(
        "A literal workspace search will locate the requested text before I summarize it.",
        0,
      ),
      ...textEvents(
        `I’ll search the workspace for ${JSON.stringify(searchQuery)}.`,
        1,
      ),
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

  const response: MockTextResponse =
    shouldCreateNote || searchQuery !== null || shouldInspectFiles
      ? responseFromToolResult(toolResults[0])
      : {
          text: "This prototype is running through a versioned JSON boundary. The viewer only renders events; the agent core owns the conversation and tools inside a Web Worker. That gives us a clean path from today’s mock model to Pi without coupling the interface to either one.",
        };

  return [
    ...reasoningEvents(
      toolResults.length > 0
        ? "The workspace result is available, so I can summarize the outcome."
        : "I can answer this directly from the current prototype context.",
      0,
    ),
    ...textEvents(response.text, 1, response.deltas),
    { type: "done" },
  ];
}

function textEvents(
  text: string,
  contentIndex: number,
  deltas = splitForStreaming(text),
): ModelStreamEvent[] {
  if (deltas.join("") !== text) {
    throw new Error("Mock text deltas must reconstruct their source text.");
  }

  return [
    { type: "text_start", content_index: contentIndex },
    ...deltas.map(
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
): MockTextResponse {
  if (!result) {
    return {
      text: "The workspace tool returned no result, so I could not inspect it.",
    };
  }
  if (result.is_error) {
    return {
      text: `I tried to use the workspace, but the tool reported: ${result.content}`,
    };
  }
  if (result.tool_name === "write_file") {
    return {
      text: createNoteResult,
      deltas: createNoteResultDeltas,
    };
  }
  if (result.tool_name === "replace_text") {
    return {
      text: "I updated the requested text in the workspace. The exact-match edit and its durable change record both completed successfully.",
    };
  }
  if (result.tool_name === "read_file") {
    return {
      text: "I read the project README. It confirms the intended architecture: a versioned viewer protocol, a worker-hosted agent core, and storage behind a virtual filesystem interface. The next useful step is an OPFS adapter so this workspace persists across browser sessions without changing the agent tools.",
    };
  }
  if (result.tool_name === "search_files") {
    const searchResult = parseSearchResult(result.content);
    if (!searchResult) {
      return {
        text: "The search tool completed, but its result was not valid search-result JSON, so I can’t safely summarize any matches.",
      };
    }
    return {
      text: summarizeSearchResult(searchResult),
    };
  }
  return {
    text: "I inspected the browser workspace and found the README, notes, and source directories. The separation between the viewer, worker-hosted core, and virtual filesystem is already visible. The next useful step is an OPFS adapter so the same files survive refreshes without changing any agent tools.",
  };
}

function workspaceSearchQuery(prompt: string): string | null {
  const requestsSearch = /\b(?:find|search)\b/i.test(prompt);
  const namesWorkspace = /\b(?:files?|project|workspace)\b/i.test(prompt);
  if (!requestsSearch || !namesWorkspace) return null;

  const quotedQuery = prompt.match(/["“]([^"\n”]+)["”]/u)?.[1];
  return quotedQuery?.trim() ? quotedQuery : null;
}

function parseSearchResult(content: string): MockSearchResult | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (
    !isNonNegativeSafeInteger(value.workspace_revision) ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    typeof value.query !== "string" ||
    value.query.length === 0 ||
    /[\r\n\u2028\u2029]/u.test(value.query) ||
    !Array.isArray(value.matches) ||
    !isNonNegativeSafeInteger(value.files_scanned) ||
    typeof value.truncated !== "boolean"
  ) {
    return null;
  }

  const matches: MockSearchMatch[] = [];
  for (const match of value.matches) {
    if (
      !isRecord(match) ||
      typeof match.path !== "string" ||
      match.path.length === 0 ||
      !isPositiveSafeInteger(match.line_number) ||
      !isPositiveSafeInteger(match.column_number) ||
      typeof match.preview !== "string"
    ) {
      return null;
    }
    matches.push({
      path: match.path,
      line_number: match.line_number,
      column_number: match.column_number,
      preview: match.preview,
    });
  }

  return {
    workspace_revision: value.workspace_revision,
    path: value.path,
    query: value.query,
    matches,
    files_scanned: value.files_scanned,
    truncated: value.truncated,
  };
}

function summarizeSearchResult(result: MockSearchResult): string {
  const matchCount = result.matches.length;
  const summary = [
    `The search returned ${matchCount} matching ${
      matchCount === 1 ? "line" : "lines"
    } for ${JSON.stringify(result.query)} under ${JSON.stringify(
      result.path,
    )} across ${result.files_scanned} scanned ${
      result.files_scanned === 1 ? "file" : "files"
    } at workspace revision ${result.workspace_revision}.`,
  ];
  const displayedMatches = result.matches.slice(0, 5);
  if (displayedMatches.length > 0) {
    summary.push(
      "",
      ...displayedMatches.map(
        (match) =>
          `- ${JSON.stringify(
            `${match.path}:${match.line_number}:${match.column_number}`,
          )} — ${JSON.stringify(match.preview)}`,
      ),
    );
  }
  if (result.matches.length > displayedMatches.length) {
    summary.push(
      "",
      `${result.matches.length - displayedMatches.length} additional returned ${
        result.matches.length - displayedMatches.length === 1
          ? "match is"
          : "matches are"
      } omitted from this summary.`,
    );
  }
  if (result.truncated) {
    summary.push(
      "",
      "The bounded result was truncated, so more matching lines may exist.",
    );
  }
  return summary.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
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
