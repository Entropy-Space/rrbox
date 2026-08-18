import { fileURLToPath } from "node:url";

export type DshBrowserAlias = {
  find: string;
  replacement: string;
};

const shim = (filename: string): string =>
  fileURLToPath(new URL(`./browser-shims/${filename}`, import.meta.url));

/** Node built-ins imported by the published DSH core packages. */
export function dshBrowserCompatibilityAliases(): DshBrowserAlias[] {
  return [
    { find: "node:async_hooks", replacement: shim("node-async-hooks.ts") },
    { find: "node:crypto", replacement: shim("node-crypto.ts") },
    { find: "node:module", replacement: shim("node-module.ts") },
    { find: "node:path", replacement: shim("node-path.ts") },
    { find: "node:util/types", replacement: shim("node-util-types.ts") },
  ];
}
