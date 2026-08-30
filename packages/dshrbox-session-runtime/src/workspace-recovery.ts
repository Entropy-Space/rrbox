import {
  MessageId,
  freezeMessage,
} from "@deepseek-ai/dsh-llm";
import {
  TOOL_OUTCOME_UNKNOWN,
  interruptedTurnClosers,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from "@deepseek-ai/dsh-session";
import type {
  PersistenceBackend,
  StoredPrefix,
} from "@deepseek-ai/dsh-session-persistence";
import { dshrboxToolCallBlockId } from "@dshrbox/core/identity";
import {
  dshrboxWorkspaceChangeOutput,
  dshrboxWorkspaceMutationPresentationMeta,
  renderDshrboxWorkspaceMutationOutput,
} from "@dshrbox/workspace";
import type {
  Workspace,
  WorkspaceChangeRecord,
} from "@researchbox/vfs";

type RecoveryBackendOptions = {
  session_id: string;
  workspace: Workspace;
};

type StagedRecovery = {
  session_id: string;
  events: SessionEvent[];
};

/**
 * Decorate one DSH persistence backend so a committed VFS receipt can replace
 * an unknown-outcome crash closer before the resumed session is published.
 */
export function createDshrboxWorkspaceRecoveryBackend(
  backend: PersistenceBackend,
  options: RecoveryBackendOptions,
): PersistenceBackend {
  let staged: StagedRecovery | undefined;

  const loadStored = async (
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<StoredPrefix | undefined> => {
    const stored = await backend.loadStored(id, signal);
    if (stored === undefined || String(id) !== options.session_id) {
      return stored;
    }
    signal?.throwIfAborted();
    const journal = await options.workspace.listChanges();
    signal?.throwIfAborted();
    const recovered = recoverWorkspaceMutationEvents(
      options.session_id,
      stored.events,
      journal.changes,
    );
    staged = recovered.length === 0
      ? undefined
      : { session_id: options.session_id, events: recovered };
    return {
      ...stored,
      events: [...stored.events, ...recovered],
    };
  };

  return {
    name: backend.name,
    loadStored,
    readStoredRevision: (id, signal) =>
      backend.readStoredRevision(id, signal),
    ...(backend.loadStoredFrom === undefined
      ? {}
      : {
          loadStoredFrom: (id: SessionId, fromSeq: number, signal?: AbortSignal) =>
            backend.loadStoredFrom!(id, fromSeq, signal),
        }),
    appendBatch: (meta, events, isMaterialized) =>
      backend.appendBatch(meta, events, isMaterialized),
    async commitRepair(meta, tornMarker, closers) {
      const recovery = staged?.session_id === String(meta.id)
        ? staged.events
        : [];
      assertRepairBatch(recovery, closers);
      await backend.commitRepair(
        meta,
        tornMarker,
        [...recovery, ...closers],
      );
      if (recovery.length > 0) staged = undefined;
    },
    list: (signal) => backend.list(signal),
    ...(backend.locate === undefined
      ? {}
      : {
          locate: (meta: SessionHeader) => backend.locate!(meta),
        }),
  };
}

function recoverWorkspaceMutationEvents(
  sessionId: string,
  events: readonly SessionEvent[],
  changes: readonly WorkspaceChangeRecord[],
): SessionEvent[] {
  const callsBySeq = new Map(
    events.flatMap((event) =>
      event.type === "tool/call" ? [[event.seq, event] as const] : []
    ),
  );
  const recovered: SessionEvent[] = [];
  for (const closer of interruptedTurnClosers(events)) {
    if (
      closer.type !== "tool/result" ||
      closer.data.error?.code !== TOOL_OUTCOME_UNKNOWN
    ) {
      continue;
    }
    const callSeq = closer.sourceEventSeqs?.[0];
    const call = callSeq === undefined ? undefined : callsBySeq.get(callSeq);
    if (call?.type !== "tool/call" || !isMutationTool(call.data.name)) {
      continue;
    }
    const record = findWorkspaceChange(changes, sessionId, call);
    if (record === undefined) continue;
    recovered.push(recoveredToolResult(
      events.length + recovered.length,
      closer.time,
      call,
      record,
    ));
  }
  return recovered;
}

function findWorkspaceChange(
  changes: readonly WorkspaceChangeRecord[],
  sessionId: string,
  call: Extract<SessionEvent, { type: "tool/call" }>,
): WorkspaceChangeRecord | undefined {
  const callId = String(call.data.callId);
  const blockId = dshrboxToolCallBlockId(
    sessionId,
    call.data.turn,
    call.data.step,
    callId,
  );
  const matches = changes.filter(
    (change) =>
      change.session_id === sessionId &&
      change.tool_call_block_id === blockId &&
      change.tool_call_id === callId &&
      change.tool_name === call.data.name &&
      change.applied_workspace_revision !== null,
  );
  if (matches.length > 1) {
    throw new Error(
      `Multiple workspace receipts match DSH tool call ${callId}.`,
    );
  }
  return matches[0];
}

function recoveredToolResult(
  seq: number,
  time: number,
  call: Extract<SessionEvent, { type: "tool/call" }>,
  record: WorkspaceChangeRecord,
): SessionEvent {
  const output = dshrboxWorkspaceChangeOutput(record);
  const content = renderDshrboxWorkspaceMutationOutput(undefined, output);
  const meta = dshrboxWorkspaceMutationPresentationMeta(undefined, output);
  return {
    type: "tool/result",
    seq,
    time,
    data: {
      turn: call.data.turn,
      step: call.data.step,
      message: freezeMessage({
        id: MessageId(
          `dshrbox-recovered-tool-result-${call.seq}-${seq}`,
        ),
        role: "user",
        source: { kind: "tool", callId: call.data.callId },
        content: [{
          type: "tool-result",
          toolCallId: call.data.callId,
          isError: false,
          content,
        }],
      }),
      meta,
    },
    surfaceOp: "append",
    sourceEventSeqs: [call.seq],
  };
}

function assertRepairBatch(
  recovery: readonly SessionEvent[],
  closers: readonly SessionEvent[],
): void {
  if (recovery.length === 0) return;
  const expectedSeq = recovery.at(-1)!.seq + 1;
  if (closers[0]?.seq !== expectedSeq) {
    throw new Error(
      "DSH workspace recovery is not contiguous with its session closers.",
    );
  }
}

function isMutationTool(
  name: string,
): name is WorkspaceChangeRecord["tool_name"] {
  return name === "write_file" ||
    name === "replace_text" ||
    name === "remove_file";
}
