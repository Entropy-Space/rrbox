import type { Context } from "@deepseek-ai/cordis";
import {
  defineTool,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { dshrboxToolCallBlockId } from "@dshrbox/core/identity";
import type { WorkspaceChangeSummary } from "@researchbox/protocol";
import type {
  Workspace,
  WorkspaceChangeMetadata,
  WorkspaceChangeRecord,
  WorkspaceRemoveResult,
  WorkspaceWriteResult,
} from "@researchbox/vfs";
import { searchWorkspaceText } from "@researchbox/workspace-search";

export type DshrboxWorkspaceConfig = {
  workspace: Workspace;
};

type MutationToolName = WorkspaceChangeMetadata["tool_name"];

type WorkspaceMutationOutput = {
  workspace_revision: number;
  path: string;
  change_kind: WorkspaceChangeSummary["change_kind"] | "unchanged";
  change: WorkspaceChangeSummary | null;
};

const entrySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", required: true },
    path: { type: "string", required: true },
    kind: {
      type: "string",
      enum: ["file", "directory"],
      required: true,
    },
    size: { type: "integer", required: true },
  },
} as const;

const searchMatchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    line_number: { type: "integer", required: true },
    column_number: { type: "integer", required: true },
    preview: { type: "string", required: true },
  },
} as const;

const workspaceChangeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    change_id: { type: "string", required: true },
    tool_call_id: { type: "string", required: true },
    tool_name: {
      type: "string",
      enum: ["write_file", "replace_text", "remove_file"],
      required: true,
    },
    path: { type: "string", required: true },
    change_kind: {
      type: "string",
      enum: ["created", "updated", "deleted"],
      required: true,
    },
    additions: { type: "integer", required: true },
    deletions: { type: "integer", required: true },
    byte_size: { type: "integer", required: true },
  },
} as const;

const mutationOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    workspace_revision: { type: "integer", required: true },
    path: { type: "string", required: true },
    change_kind: {
      type: "string",
      enum: ["created", "updated", "deleted", "unchanged"],
      required: true,
    },
    change: {
      oneOf: [workspaceChangeSchema, { type: "null" }],
      required: true,
    },
  },
} as const;

const mutationOutput = {
  schema: mutationOutputSchema,
  render: (_args: unknown, value: WorkspaceMutationOutput) => [{
    type: "text" as const,
    text: JSON.stringify(value.change ?? {
      path: value.path,
      change_kind: "unchanged",
    }),
  }],
  presentationMeta: (_args: unknown, value: WorkspaceMutationOutput) => ({
    summary: mutationSummary(value),
    ...(value.change === null
      ? {}
      : {
          file_change: value.change,
          workspace_revision: value.workspace_revision,
        }),
  }),
};

/**
 * Creates the native DSH tool surface over an existing workspace. The VFS
 * remains the owner of paths, compare-and-swap, journaling, and revisions.
 */
export function createDshrboxWorkspaceTools(
  workspace: Workspace,
): readonly ToolDefinition[] {
  assertWorkspace(workspace);

  const listFiles = defineTool({
    name: "list_files",
    description: "List files and directories at a workspace path.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Absolute path inside the workspace",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspace_revision: { type: "integer", required: true },
          entries: {
            type: "array",
            items: entrySchema,
            required: true,
          },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: JSON.stringify(value.entries),
      }],
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      const result = await workspace.list(args.path);
      throwIfAborted(exec.signal);
      return result;
    },
  });

  const readFile = defineTool({
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Absolute path inside the workspace",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspace_revision: { type: "integer", required: true },
          path_revision: { type: "integer", required: true },
          content: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.content,
      }],
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      const result = await workspace.read(args.path);
      throwIfAborted(exec.signal);
      return result;
    },
  });

  const searchFiles = defineTool({
    name: "search_files",
    description:
      "Search workspace text files for a literal query, returning bounded line matches.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Absolute file or directory path",
      },
      query: {
        type: "string",
        required: true,
        description: "Case-sensitive, single-line literal text to find",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspace_revision: { type: "integer", required: true },
          path: { type: "string", required: true },
          query: { type: "string", required: true },
          matches: {
            type: "array",
            items: searchMatchSchema,
            required: true,
          },
          files_scanned: { type: "integer", required: true },
          truncated: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: JSON.stringify(value),
      }],
    },
    execute: (args, exec) => searchWorkspaceText(
      workspace,
      args,
      exec.signal,
    ),
  });

  const writeFile = defineTool({
    name: "write_file",
    description: "Create or replace a UTF-8 text file in the workspace.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Absolute path inside the workspace",
      },
      content: {
        type: "string",
        required: true,
        description: "Complete UTF-8 file content",
      },
    },
    output: mutationOutput,
    async execute(args, exec): Promise<WorkspaceMutationOutput> {
      throwIfAborted(exec.signal);
      const result = await workspace.write(args.path, args.content, {
        change: createChangeMetadata(exec, "write_file"),
      });
      return mutationResult(result);
    },
  });

  const replaceText = defineTool({
    name: "replace_text",
    description:
      "Replace one unique literal text fragment in an existing workspace file.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Absolute path inside the workspace",
      },
      old_text: {
        type: "string",
        required: true,
        description: "Exact literal text that must occur once",
      },
      new_text: {
        type: "string",
        required: true,
        description: "Replacement text",
      },
    },
    output: mutationOutput,
    async execute(args, exec): Promise<WorkspaceMutationOutput> {
      if (args.old_text.length === 0) {
        throw new Error("old_text must not be empty.");
      }
      if (args.old_text === args.new_text) {
        throw new Error("old_text and new_text must be different.");
      }
      throwIfAborted(exec.signal);
      const { content } = await workspace.read(args.path);
      throwIfAborted(exec.signal);
      const matches = countOverlappingOccurrences(content, args.old_text);
      if (matches === 0) {
        throw new Error(
          "old_text was not found. Read the file again and use exact text.",
        );
      }
      if (matches !== 1) {
        throw new Error(
          "old_text occurs more than once. Include more surrounding text so the match is unique.",
        );
      }
      const index = content.indexOf(args.old_text);
      const nextContent = content.slice(0, index) +
        args.new_text +
        content.slice(index + args.old_text.length);
      const result = await workspace.write(args.path, nextContent, {
        expected_content: content,
        change: createChangeMetadata(exec, "replace_text"),
      });
      return mutationResult(result);
    },
  });

  const removeFile = defineTool({
    name: "remove_file",
    description: "Delete one existing UTF-8 text file from the workspace.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Absolute path inside the workspace",
      },
    },
    output: mutationOutput,
    async execute(args, exec): Promise<WorkspaceMutationOutput> {
      throwIfAborted(exec.signal);
      const { content } = await workspace.read(args.path);
      throwIfAborted(exec.signal);
      const result = await workspace.remove(args.path, {
        expected_content: content,
        change: createChangeMetadata(exec, "remove_file"),
      });
      return mutationResult(result);
    },
  });

  return [
    listFiles,
    searchFiles,
    readFile,
    writeFile,
    replaceText,
    removeFile,
  ];
}

/** Register workspace operations as ordinary global DSH tools. */
export function DshrboxWorkspace(
  ctx: Context,
  config: DshrboxWorkspaceConfig,
): void {
  if (config === null || typeof config !== "object") {
    throw new TypeError("dshrbox workspace config must be an object");
  }
  for (const tool of createDshrboxWorkspaceTools(config.workspace)) {
    ctx.tools.register(tool);
  }
}

DshrboxWorkspace.inject = ["tools"];

export default DshrboxWorkspace;

function createChangeMetadata(
  exec: ToolRunContext,
  toolName: MutationToolName,
): WorkspaceChangeMetadata {
  const agent = exec.agent;
  if (agent === undefined) {
    throw new Error("Workspace mutations require an active DSH agent.");
  }
  const callId = String(exec.callId);
  const call = agent.session.events.findLast(
    (event) =>
      event.type === "tool/call" &&
      String(event.data.callId) === callId &&
      event.data.name === toolName,
  );
  if (call?.type !== "tool/call") {
    throw new Error(
      `Workspace mutation ${callId} is missing its DSH tool-call event.`,
    );
  }
  const assistantMessageIndex = agent.session.deriveMessages().findLastIndex(
    (message) =>
      message.role === "assistant" &&
      message.content.some(
        (block) =>
          block.type === "tool-call" &&
          String(block.id) === callId &&
          block.name === toolName,
      ),
  );
  if (assistantMessageIndex === -1) {
    throw new Error(
      `Workspace mutation ${callId} is missing its DSH assistant message.`,
    );
  }
  const sessionId = String(agent.id);
  return {
    change_id: crypto.randomUUID(),
    session_id: sessionId,
    tool_call_block_id: dshrboxToolCallBlockId(
      sessionId,
      call.data.turn,
      call.data.step,
      callId,
    ),
    assistant_message_index: assistantMessageIndex,
    tool_call_id: callId,
    tool_name: toolName,
    created_at: new Date(call.time).toISOString(),
  };
}

function mutationResult(
  mutation: WorkspaceWriteResult | WorkspaceRemoveResult,
): WorkspaceMutationOutput {
  const result = mutation.result;
  if (result === undefined) {
    throw new Error(
      "The workspace mutation did not return its journaled result.",
    );
  }
  if (result.change_kind === "unchanged") {
    return {
      workspace_revision: mutation.workspace_revision,
      path: result.path,
      change_kind: "unchanged",
      change: null,
    };
  }
  if (result.change === null) {
    throw new Error("The workspace mutation did not produce a change record.");
  }
  return {
    workspace_revision: mutation.workspace_revision,
    path: result.path,
    change_kind: result.change_kind,
    change: workspaceChangeSummary(result.change),
  };
}

function workspaceChangeSummary(
  record: WorkspaceChangeRecord,
): WorkspaceChangeSummary {
  return {
    change_id: record.change_id,
    tool_call_id: record.tool_call_id,
    tool_name: record.tool_name,
    path: record.path,
    change_kind: record.change_kind,
    additions: record.additions,
    deletions: record.deletions,
    byte_size: record.byte_size,
  };
}

function mutationSummary(value: WorkspaceMutationOutput): string {
  const change = value.change;
  if (change === null) return "No changes needed";
  const verb = change.change_kind === "created"
    ? "Created"
    : change.change_kind === "updated"
    ? "Updated"
    : "Deleted";
  return `${verb} · +${change.additions} −${change.deletions}`;
}

function countOverlappingOccurrences(value: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= value.length - search.length) {
    const index = value.indexOf(search, offset);
    if (index === -1) break;
    count += 1;
    offset = index + 1;
  }
  return count;
}

function assertWorkspace(
  workspace: Workspace,
): asserts workspace is Workspace {
  if (
    workspace === null ||
    typeof workspace !== "object" ||
    typeof workspace.list !== "function" ||
    typeof workspace.read !== "function" ||
    typeof workspace.getPathState !== "function" ||
    typeof workspace.write !== "function" ||
    typeof workspace.remove !== "function" ||
    typeof workspace.listChanges !== "function" ||
    typeof workspace.getChange !== "function" ||
    typeof workspace.revertChange !== "function"
  ) {
    throw new TypeError(
      "dshrbox workspace requires a mutable Workspace",
    );
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ??
    new DOMException("The workspace tool call was aborted.", "AbortError");
}
