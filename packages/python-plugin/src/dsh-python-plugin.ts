import type { Context } from "@deepseek-ai/cordis";
import {
  defineTool,
  type ToolDefinition,
} from "@deepseek-ai/dsh-tools";
import {
  formatPythonExecution,
  type PythonExecutor,
} from "./python-executor.ts";
import { MAX_PYTHON_CODE_BYTES } from "./protocol.ts";

export type DshrboxPythonConfig = Readonly<{
  executor: PythonExecutor;
}>;

type PythonToolOutput = {
  stdout: string;
  stderr: string;
  output_truncated: boolean;
};

const pythonOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    stdout: { type: "string", required: true },
    stderr: { type: "string", required: true },
    output_truncated: { type: "boolean", required: true },
  },
} as const;

/** Build the native DSH tool surface over an application-owned executor. */
export function createDshrboxPythonTools(
  executor: PythonExecutor,
): readonly ToolDefinition[] {
  assertPythonExecutor(executor);

  const runPython = defineTool({
    name: "run_python",
    description:
      "Run self-contained Python in an isolated, stateless RustPython interpreter. Network requests and workspace access are unavailable.",
    parameters: {
      code: {
        type: "string",
        required: true,
        description:
          `Self-contained Python source code, limited to ${MAX_PYTHON_CODE_BYTES} UTF-8 bytes. Each call starts with a fresh interpreter.`,
      },
    },
    output: {
      schema: pythonOutputSchema,
      render: (_args, value) => [{
        type: "text",
        text: formatPythonOutput(value),
      }],
      presentationMeta: (_args, value) => ({
        summary: value.output_truncated
          ? "Python completed (output truncated)"
          : "Python completed",
      }),
    },
    async execute(args, exec): Promise<PythonToolOutput> {
      assertCodeSize(args.code);
      const result = await executor.execute(args.code, exec.signal);
      if (result.error !== null) {
        throw new Error(formatPythonExecution(result));
      }
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        output_truncated: result.output_truncated,
      };
    },
  });

  return [runPython];
}

/** Register Python as an ordinary native DSH plugin. */
export function DshrboxPython(
  ctx: Context,
  config: DshrboxPythonConfig,
): void {
  if (config === null || typeof config !== "object") {
    throw new TypeError("dshrbox Python config must be an object");
  }
  for (const tool of createDshrboxPythonTools(config.executor)) {
    ctx.tools.register(tool);
  }
}

DshrboxPython.inject = ["tools"];

export default DshrboxPython;

function formatPythonOutput(output: PythonToolOutput): string {
  return formatPythonExecution({
    ...output,
    error: null,
  });
}

function assertPythonExecutor(
  executor: PythonExecutor,
): asserts executor is PythonExecutor {
  if (
    executor === null ||
    typeof executor !== "object" ||
    typeof executor.execute !== "function" ||
    typeof executor.close !== "function"
  ) {
    throw new TypeError(
      "dshrbox Python requires an application-owned PythonExecutor",
    );
  }
}

function assertCodeSize(code: string): void {
  const byteLength = new TextEncoder().encode(code).byteLength;
  if (byteLength > MAX_PYTHON_CODE_BYTES) {
    throw new Error(
      `Python code exceeds ${MAX_PYTHON_CODE_BYTES} UTF-8 bytes.`,
    );
  }
}
