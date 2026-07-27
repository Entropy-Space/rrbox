export type NativeShellStatus = {
  is_native_host: boolean;
  phase: "bridge_pending";
  platform_targets: readonly ["macOS", "iOS", "Android"];
};
