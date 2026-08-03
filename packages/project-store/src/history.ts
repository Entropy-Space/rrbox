import type { TimelineEntry } from "@researchbox/protocol";
import { parseTimelineEntry } from "@researchbox/protocol";

export const SESSION_HISTORY_FORMAT_VERSION = 1 as const;

export type SessionHistoryNode = {
  node_id: string;
  parent_node_id: string | null;
  entry: TimelineEntry;
};

export type SessionHistory = {
  format_version: typeof SESSION_HISTORY_FORMAT_VERSION;
  active_leaf_id: string | null;
  nodes: SessionHistoryNode[];
};

export type SessionHistoryNavigation = {
  history: SessionHistory;
  timeline: TimelineEntry[];
};

export function createSessionHistory(
  timeline: readonly TimelineEntry[],
): SessionHistory {
  let parentNodeId: string | null = null;
  const nodes = timeline.map((entry) => {
    const node: SessionHistoryNode = {
      node_id: entry.entry_id,
      parent_node_id: parentNodeId,
      entry: structuredClone(entry),
    };
    parentNodeId = node.node_id;
    return node;
  });
  return {
    format_version: SESSION_HISTORY_FORMAT_VERSION,
    active_leaf_id: parentNodeId,
    nodes,
  };
}

export function cloneSessionHistory(
  history: SessionHistory,
): SessionHistory {
  return structuredClone(history);
}

export function parseSessionHistory(
  value: unknown,
  fallbackTimeline: readonly TimelineEntry[],
): { history: SessionHistory; was_migrated: boolean } {
  if (value === undefined) {
    return {
      history: createSessionHistory(fallbackTimeline),
      was_migrated: true,
    };
  }
  if (!isRecord(value)) {
    throw new Error("Session history must be an object.");
  }
  if (value.format_version !== SESSION_HISTORY_FORMAT_VERSION) {
    throw new Error("Unsupported session history format version.");
  }
  const activeLeafId = requireNullableString(value, "active_leaf_id");
  const rawNodes = requireArray(value, "nodes");
  const history: SessionHistory = {
    format_version: SESSION_HISTORY_FORMAT_VERSION,
    active_leaf_id: activeLeafId,
    nodes: rawNodes.map(parseSessionHistoryNode),
  };
  assertSessionHistoryInvariants(history);
  const projectedTimeline = sessionHistoryTimeline(history);
  if (!sameTimeline(projectedTimeline, fallbackTimeline)) {
    return {
      history: synchronizeSessionHistory(history, fallbackTimeline),
      was_migrated: true,
    };
  }
  return { history, was_migrated: false };
}

export function assertSessionHistoryInvariants(
  history: SessionHistory,
): void {
  if (history.format_version !== SESSION_HISTORY_FORMAT_VERSION) {
    throw new Error("Unsupported session history format version.");
  }
  const nodes = new Map<string, SessionHistoryNode>();
  for (const node of history.nodes) {
    if (node.node_id.length === 0) {
      throw new Error("Session history node_id must not be empty.");
    }
    if (node.node_id !== node.entry.entry_id) {
      throw new Error("Session history node_id must match its entry_id.");
    }
    if (nodes.has(node.node_id)) {
      throw new Error(`Duplicate session history node: ${node.node_id}`);
    }
    nodes.set(node.node_id, node);
  }

  if (
    history.active_leaf_id !== null &&
    !nodes.has(history.active_leaf_id)
  ) {
    throw new Error("Session history active leaf does not exist.");
  }

  for (const node of history.nodes) {
    if (node.parent_node_id === node.node_id) {
      throw new Error("Session history node cannot be its own parent.");
    }
    if (
      node.parent_node_id !== null &&
      !nodes.has(node.parent_node_id)
    ) {
      throw new Error(
        `Session history parent does not exist: ${node.parent_node_id}`,
      );
    }
    const visited = new Set<string>();
    let current: SessionHistoryNode | undefined = node;
    while (current) {
      if (visited.has(current.node_id)) {
        throw new Error("Session history contains a cycle.");
      }
      visited.add(current.node_id);
      current = current.parent_node_id === null
        ? undefined
        : nodes.get(current.parent_node_id);
    }
  }
}

export function sessionHistoryTimeline(
  history: SessionHistory,
  leafId = history.active_leaf_id,
): TimelineEntry[] {
  if (leafId === null) return [];
  const nodes = new Map(
    history.nodes.map((node) => [node.node_id, node]),
  );
  const path: TimelineEntry[] = [];
  const visited = new Set<string>();
  let currentId: string | null = leafId;
  while (currentId !== null) {
    if (visited.has(currentId)) {
      throw new Error("Session history contains a cycle.");
    }
    visited.add(currentId);
    const node = nodes.get(currentId);
    if (!node) {
      throw new Error(`Session history node does not exist: ${currentId}`);
    }
    path.push(structuredClone(node.entry));
    currentId = node.parent_node_id;
  }
  path.reverse();
  return path;
}

export function navigateSessionHistory(
  history: SessionHistory,
  targetNodeId: string | null,
): SessionHistoryNavigation {
  if (
    targetNodeId !== null &&
    !history.nodes.some((node) => node.node_id === targetNodeId)
  ) {
    throw new Error(`Session history node does not exist: ${targetNodeId}`);
  }
  const nextHistory = cloneSessionHistory(history);
  nextHistory.active_leaf_id = targetNodeId;
  return {
    history: nextHistory,
    timeline: sessionHistoryTimeline(nextHistory),
  };
}

export function synchronizeSessionHistory(
  history: SessionHistory,
  timeline: readonly TimelineEntry[],
): SessionHistory {
  const nextHistory = cloneSessionHistory(history);
  const nodesById = new Map(
    nextHistory.nodes.map((node) => [node.node_id, node]),
  );
  let parentNodeId: string | null = null;
  for (const entry of timeline) {
    const existing = nodesById.get(entry.entry_id);
    if (existing) {
      if (existing.parent_node_id !== parentNodeId) {
        throw new Error(
          `Session history entry has a different parent: ${entry.entry_id}`,
        );
      }
      existing.entry = structuredClone(entry);
    } else {
      const node: SessionHistoryNode = {
        node_id: entry.entry_id,
        parent_node_id: parentNodeId,
        entry: structuredClone(entry),
      };
      nextHistory.nodes.push(node);
      nodesById.set(node.node_id, node);
    }
    parentNodeId = entry.entry_id;
  }
  nextHistory.active_leaf_id = parentNodeId;
  assertSessionHistoryInvariants(nextHistory);
  return nextHistory;
}

function parseSessionHistoryNode(value: unknown): SessionHistoryNode {
  if (!isRecord(value)) {
    throw new Error("Session history node must be an object.");
  }
  return {
    node_id: requireString(value, "node_id"),
    parent_node_id: requireNullableString(value, "parent_node_id"),
    entry: parseTimelineEntry(value.entry),
  };
}

function sameTimeline(
  left: readonly TimelineEntry[],
  right: readonly TimelineEntry[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (entry, index) => JSON.stringify(entry) === JSON.stringify(right[index]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireArray(value: Record<string, unknown>, key: string): unknown[] {
  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    throw new Error(`Session history ${key} must be an array.`);
  }
  return candidate;
}

function requireString(
  value: Record<string, unknown>,
  key: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`Session history ${key} must be a non-empty string.`);
  }
  return candidate;
}

function requireNullableString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const candidate = value[key];
  if (candidate === null) return null;
  return requireString(value, key);
}
