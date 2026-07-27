import type { NativeShellStatus } from "./types.ts";

export function readNativeShellStatus(): NativeShellStatus {
  return {
    is_native_host: "__TAURI_INTERNALS__" in globalThis,
    phase: "bridge_pending",
    platform_targets: ["macOS", "iOS", "Android"],
  };
}
