import {
  resolveWorkspaceArchiveLimits,
} from "./limits.ts";
import {
  validatePortableWorkspaceSnapshot,
} from "./paths.ts";
import type {
  PortableWorkspaceSnapshot,
  WorkspaceArchiveOptions,
} from "./types.ts";

export { capturePortableWorkspace } from "./capture.ts";
export type { WorkspaceArchiveOptions } from "./types.ts";

/**
 * Validates, sorts, and clones a JSON-shaped portable workspace snapshot.
 *
 * This entry point deliberately has no ZIP dependency, so callers such as the
 * agent core can validate transfer payloads without loading archive encoding
 * or decoding code.
 */
export function normalizePortableWorkspaceSnapshot(
  snapshot: PortableWorkspaceSnapshot,
  options?: WorkspaceArchiveOptions,
): PortableWorkspaceSnapshot {
  const limits = resolveWorkspaceArchiveLimits(options);
  const validated = validatePortableWorkspaceSnapshot(snapshot, limits);
  return {
    files: validated.files.map(({ path, content }) => ({
      path,
      content,
    })),
  };
}
