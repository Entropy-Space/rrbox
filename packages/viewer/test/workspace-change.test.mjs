import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION } from "@researchbox/protocol";

import {
  WorkspaceChangeRequestError,
  WorkspaceChangeRequests,
} from "../src/workspace-change.ts";

test("resolves a change read from its correlated snapshot", async () => {
  const requests = new WorkspaceChangeRequests();
  const completion = requests.beginRead("read-1", "project-1", "change-1");
  const payload = snapshotPayload();

  assert.equal(
    requests.accept(coreEvent("workspace_change_snapshot", payload, "read-1")),
    true,
  );
  assert.deepEqual(await completion, payload);
  assert.equal(requests.size, 0);
});

test("resolves a revert while leaving its event available to the reducer", async () => {
  const requests = new WorkspaceChangeRequests();
  const completion = requests.beginRevert(
    "revert-1",
    "project-1",
    "change-1",
  );
  const payload = {
    project_id: "project-1",
    change_id: "change-1",
    tool_name: "write_file",
    path: "/notes/example.md",
    change_kind: "updated",
    workspace_revision: 8,
    reverted_at_workspace_revision: 8,
    revert_outcome: "applied",
  };

  assert.equal(
    requests.accept(
      coreEvent("workspace_change_reverted", payload, "revert-1"),
    ),
    true,
  );
  assert.deepEqual(await completion, payload);
  assert.equal(requests.size, 0);
});

test("rejects one correlated request without disturbing another", async () => {
  const requests = new WorkspaceChangeRequests();
  const first = requests.beginRead("read-1", "project-1", "change-1");
  const second = requests.beginRead("read-2", "project-1", "change-1");

  assert.equal(
    requests.accept(
      coreEvent(
        "error",
        {
          code: "workspace_change_not_found",
          message: "The change was not found.",
          project_id: "project-1",
        },
        "read-1",
      ),
    ),
    true,
  );
  await assert.rejects(
    first,
    (error) =>
      error instanceof WorkspaceChangeRequestError &&
      error.code === "workspace_change_not_found" &&
      error.project_id === "project-1",
  );
  assert.equal(requests.size, 1);

  const payload = snapshotPayload();
  requests.accept(coreEvent("workspace_change_snapshot", payload, "read-2"));
  assert.deepEqual(await second, payload);
});

test("rejects a mismatched terminal response instead of hanging", async () => {
  const requests = new WorkspaceChangeRequests();
  const completion = requests.beginRead(
    "request-1",
    "project-1",
    "change-1",
  );

  assert.equal(
    requests.accept(
      coreEvent(
        "workspace_change_reverted",
        {
          project_id: "project-1",
          change_id: "change-1",
          tool_name: "write_file",
          path: "/notes/example.md",
          change_kind: "updated",
          workspace_revision: 8,
          reverted_at_workspace_revision: 8,
          revert_outcome: "applied",
        },
        "request-1",
      ),
    ),
    true,
  );
  await assert.rejects(completion, /unexpected workspace_change_reverted/);
  assert.equal(requests.size, 0);
});

test("rejects a correlated read for the wrong project or change", async () => {
  for (const payload of [
    { ...snapshotPayload(), project_id: "project-2" },
    {
      ...snapshotPayload(),
      change: {
        ...snapshotPayload().change,
        change_id: "change-2",
      },
    },
  ]) {
    const requests = new WorkspaceChangeRequests();
    const completion = requests.beginRead(
      "request-1",
      "project-1",
      "change-1",
    );

    assert.equal(
      requests.accept(
        coreEvent("workspace_change_snapshot", payload, "request-1"),
      ),
      true,
    );
    await assert.rejects(completion, /wrong scope/);
    assert.equal(requests.size, 0);
  }
});

test("rejects a correlated revert for the wrong project or change", async () => {
  for (const payload of [
    {
      project_id: "project-2",
      change_id: "change-1",
      tool_name: "write_file",
      path: "/notes/example.md",
      change_kind: "updated",
      workspace_revision: 8,
      reverted_at_workspace_revision: 8,
      revert_outcome: "applied",
    },
    {
      project_id: "project-1",
      change_id: "change-2",
      tool_name: "write_file",
      path: "/notes/example.md",
      change_kind: "updated",
      workspace_revision: 8,
      reverted_at_workspace_revision: 8,
      revert_outcome: "applied",
    },
  ]) {
    const requests = new WorkspaceChangeRequests();
    const completion = requests.beginRevert(
      "request-1",
      "project-1",
      "change-1",
    );

    assert.equal(
      requests.accept(
        coreEvent("workspace_change_reverted", payload, "request-1"),
      ),
      true,
    );
    await assert.rejects(completion, /wrong scope/);
    assert.equal(requests.size, 0);
  }
});

test("ignores unrelated events and rejects duplicate request ids", async () => {
  const requests = new WorkspaceChangeRequests();
  const first = requests.beginRead(
    "request-1",
    "project-1",
    "change-1",
  );
  const duplicate = requests.beginRevert(
    "request-1",
    "project-1",
    "change-1",
  );

  await assert.rejects(duplicate, /Duplicate workspace change request/);
  assert.equal(
    requests.accept(
      coreEvent(
        "files_snapshot",
        {
          project_id: "project-1",
          path: "/",
          workspace_revision: 0,
          files: [],
        },
        "request-1",
      ),
    ),
    false,
  );

  requests.reject("request-1", new Error("closed"));
  await assert.rejects(first, /closed/);
});

test("rejects all pending requests when the worker closes", async () => {
  const requests = new WorkspaceChangeRequests();
  const read = requests.beginRead("read-1", "project-1", "change-1");
  const revert = requests.beginRevert(
    "revert-1",
    "project-1",
    "change-1",
  );

  requests.rejectAll(new Error("The browser core closed."));

  await assert.rejects(read, /browser core closed/);
  await assert.rejects(revert, /browser core closed/);
  assert.equal(requests.size, 0);
});

function snapshotPayload() {
  return {
    project_id: "project-1",
    workspace_revision: 7,
    change: {
      change_id: "change-1",
      tool_call_id: "call-1",
      tool_name: "write_file",
      path: "/notes/example.md",
      change_kind: "updated",
      additions: 2,
      deletions: 1,
      byte_size: 14,
      before_content: "before\n",
      after_content: "after\n",
      current_content: "after\n",
      reverted_at_workspace_revision: null,
      revert_status: "available",
    },
  };
}

function coreEvent(type, payload, requestId) {
  return {
    protocol_version: PROTOCOL_VERSION,
    event_id: crypto.randomUUID(),
    request_id: requestId,
    type,
    payload,
  };
}
