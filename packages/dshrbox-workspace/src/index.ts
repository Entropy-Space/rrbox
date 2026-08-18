import type { Context } from "@deepseek-ai/cordis";
import {
  defineTool,
  type ToolDefinition,
} from "@deepseek-ai/dsh-tools";
import type { WorkspaceReader } from "@researchbox/vfs";
import { searchWorkspaceText } from "@researchbox/workspace-search";

export type DshrboxWorkspaceConfig = {
  workspace: WorkspaceReader;
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

/**
 * Creates the read-only DSH tool surface over an existing workspace. The VFS
 * remains the owner of path and snapshot semantics.
 */
export function createDshrboxWorkspaceTools(
  workspace: WorkspaceReader,
): readonly ToolDefinition[] {
  assertWorkspaceReader(workspace);

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

  return [listFiles, searchFiles, readFile];
}

/** Register workspace reads as ordinary global DSH tools. */
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

function assertWorkspaceReader(
  workspace: WorkspaceReader,
): asserts workspace is WorkspaceReader {
  if (
    workspace === null ||
    typeof workspace !== "object" ||
    typeof workspace.list !== "function" ||
    typeof workspace.read !== "function" ||
    typeof workspace.getPathState !== "function"
  ) {
    throw new TypeError(
      "dshrbox workspace requires a WorkspaceReader",
    );
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ??
    new DOMException("The workspace tool call was aborted.", "AbortError");
}
