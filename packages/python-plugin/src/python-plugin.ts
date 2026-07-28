import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AgentPlugin } from "@researchbox/agent-core";
import {
  MAX_PYTHON_CODE_BYTES,
  type PythonExecutionResult,
} from "./protocol.ts";

export type PythonExecutor = {
  execute(code: string, signal?: AbortSignal): Promise<PythonExecutionResult>;
  close(): void | Promise<void>;
};

type PythonToolDetails = {
  summary: string;
};

export function createPythonAgentPlugin(
  executor: PythonExecutor,
): AgentPlugin {
  return {
    id: "python",
    createTools() {
      const parameters = Type.Object({
        code: Type.String({
          maxLength: MAX_PYTHON_CODE_BYTES,
          description:
            "Self-contained Python source code. Each call starts with a fresh interpreter.",
        }),
      });
      const runPython: AgentTool<
        typeof parameters,
        PythonToolDetails
      > = {
        name: "run_python",
        label: "Run Python",
        description:
          "Run self-contained Python in an isolated, stateless RustPython interpreter. Network requests and workspace access are unavailable.",
        parameters,
        execute: async (_toolCallId, params, signal) => {
          const result = await executor.execute(params.code, signal);
          const output = formatPythonExecution(result);
          if (result.error !== null) {
            throw new Error(output);
          }
          return {
            content: [{ type: "text", text: output }],
            details: {
              summary: result.output_truncated
                ? "Python completed (output truncated)"
                : "Python completed",
            },
          };
        },
      };
      return [runPython];
    },
  };
}

export function formatPythonExecution(
  result: PythonExecutionResult,
): string {
  const sections: string[] = [];
  if (result.stdout.length > 0) {
    sections.push(`stdout:\n${result.stdout}`);
  }
  if (result.stderr.length > 0) {
    sections.push(`stderr:\n${result.stderr}`);
  }
  if (result.error !== null) {
    sections.push(`error:\n${result.error}`);
  }
  if (result.output_truncated) {
    sections.push("[output truncated]");
  }
  return sections.length > 0
    ? sections.join("\n")
    : "Python completed without output.";
}
