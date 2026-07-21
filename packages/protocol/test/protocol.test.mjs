import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION,
  createCommand,
  parseCoreEvent,
  parseViewerCommand,
} from "../src/index.ts";

test("round-trips a versioned viewer command", () => {
  const command = createCommand("prompt", {
    session_id: "session-1",
    text: "hello",
  });

  assert.equal(command.protocol_version, PROTOCOL_VERSION);
  assert.deepEqual(parseViewerCommand(command), command);
});

test("validates core events before the viewer consumes them", () => {
  const event = parseCoreEvent({
    protocol_version: PROTOCOL_VERSION,
    event_id: "event-1",
    type: "ready",
    payload: {
      session_id: "session-1",
      messages: [],
      files: [
        {
          name: "README.md",
          path: "/README.md",
          kind: "file",
          size: 12,
        },
      ],
    },
  });

  assert.equal(event.type, "ready");
  assert.equal(event.payload.files[0]?.path, "/README.md");
});

test("rejects malformed core events", () => {
  assert.throws(
    () =>
      parseCoreEvent({
        protocol_version: PROTOCOL_VERSION,
        event_id: "event-1",
        type: "run_state",
        payload: { is_running: "yes" },
      }),
    /is_running must be a boolean/,
  );
});
