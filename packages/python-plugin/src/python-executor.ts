import type { PythonExecutionResult } from "./protocol.ts";

export type PythonExecutor = {
  execute(code: string, signal?: AbortSignal): Promise<PythonExecutionResult>;
  close(): void | Promise<void>;
};

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
