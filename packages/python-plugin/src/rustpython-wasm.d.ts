declare module "*researchbox_python_plugin.js" {
  type Execution = {
    stdout: string;
    stderr: string;
    error: string | null;
    output_truncated: boolean;
  };

  export function execute_python_wasm(
    code: string,
    max_output_bytes: number,
  ): Execution;

  export default function initializeRustPython(): Promise<unknown>;
}
