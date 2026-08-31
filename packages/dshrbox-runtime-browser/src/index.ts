import "./disposable-symbols.ts";
import {
  createDshrboxCore,
  type CreateDshrboxCoreOptions,
  type DshrboxCore,
} from "@dshrbox/core";
import { DSH_BROWSER_COMPATIBILITY } from "./browser-compatibility.ts";

export { DSH_BROWSER_COMPATIBILITY } from "./browser-compatibility.ts";
export type { DshBrowserCompatibility } from "./browser-compatibility.ts";

export type CreateDshrboxBrowserCoreOptions = Omit<
  CreateDshrboxCoreOptions,
  "max_parallel_tool_calls"
>;

/** Compose dshrbox with the constraints required by its browser async context. */
export function createDshrboxBrowserCore(
  options: CreateDshrboxBrowserCoreOptions,
): Promise<DshrboxCore> {
  return createDshrboxCore({
    ...options,
    max_parallel_tool_calls: DSH_BROWSER_COMPATIBILITY.max_parallel_tool_calls,
  });
}
