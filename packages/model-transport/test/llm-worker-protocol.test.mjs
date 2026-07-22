import assert from "node:assert/strict";
import test from "node:test";
import {
  LLM_WORKER_PROTOCOL_VERSION,
  createLlmModelsAbort,
  createLlmModelsRequest,
  createLlmStreamEvent,
  createLlmStreamFinished,
  createLlmStreamStart,
  parseLlmWorkerCommand,
  parseLlmWorkerEvent,
} from "../src/index.ts";

const modelRequest = {
  session_id: "session-1",
  provider_id: "researchbox-mock",
  model_id: "researchbox-mock",
  system_prompt: "Help with the workspace.",
  messages: [{ role: "user", content: "inspect the workspace" }],
  tools: [],
};

test("round-trips versioned LLM worker messages", () => {
  const command = createLlmStreamStart("stream-1", modelRequest);
  const event = createLlmStreamEvent("stream-1", {
    type: "text_delta",
    text_delta: "hello",
  });
  const finished = createLlmStreamFinished("stream-1", "complete");
  const modelsRequest = createLlmModelsRequest("request-1", "local-openai");
  const modelsAbort = createLlmModelsAbort("request-1");

  assert.deepEqual(parseLlmWorkerCommand(command), command);
  assert.deepEqual(parseLlmWorkerEvent(event), event);
  assert.deepEqual(parseLlmWorkerEvent(finished), finished);
  assert.deepEqual(parseLlmWorkerCommand(modelsRequest), modelsRequest);
  assert.deepEqual(parseLlmWorkerCommand(modelsAbort), modelsAbort);
});

test("round-trips exact mutation arguments through the LLM worker protocol", () => {
  const writeCall = {
    tool_call_id: "write-1",
    tool_name: "write_file",
    arguments: {
      path: "/notes.md",
      content: "first line\n\n  indented line\n",
    },
  };
  const replaceCall = {
    tool_call_id: "replace-1",
    tool_name: "replace_text",
    arguments: {
      path: "/notes.md",
      old_text: "first line\n",
      new_text: "replacement\n\n",
    },
  };
  const command = createLlmStreamStart("stream-mutation", {
    ...modelRequest,
    messages: [
      { role: "user", content: "Update notes" },
      {
        role: "assistant",
        content: "",
        tool_calls: [writeCall, replaceCall],
      },
      {
        role: "tool",
        tool_call_id: "write-1",
        tool_name: "write_file",
        content: "File written",
        is_error: false,
      },
      {
        role: "tool",
        tool_call_id: "replace-1",
        tool_name: "replace_text",
        content: "Text replaced",
        is_error: false,
      },
    ],
  });
  const writeEvent = createLlmStreamEvent("stream-mutation", {
    type: "tool_call",
    ...writeCall,
  });

  assert.deepEqual(parseLlmWorkerCommand(command), command);
  assert.deepEqual(parseLlmWorkerEvent(writeEvent), writeEvent);
});

test("rejects malformed nested model events", () => {
  assert.throws(
    () =>
      parseLlmWorkerEvent({
        protocol_version: LLM_WORKER_PROTOCOL_VERSION,
        event_id: "event-1",
        stream_id: "stream-1",
        type: "stream_event",
        payload: {
          model_event: { type: "tool_call", arguments: { path: "/" } },
        },
      }),
    /tool_call_id must be a string/,
  );
});

test("keeps the LLM protocol version independent and validated", () => {
  assert.equal(LLM_WORKER_PROTOCOL_VERSION, 3);
  assert.throws(
    () =>
      parseLlmWorkerCommand({
        protocol_version: 99,
        stream_id: "stream-1",
        type: "stream_start",
        payload: { model_request: modelRequest },
      }),
    /Unsupported LLM worker protocol version/,
  );
});

test("requires error details only for errored streams", () => {
  assert.throws(
    () => createLlmStreamFinished("stream-1", "error"),
    /requires error_message/,
  );
  assert.throws(
    () => createLlmStreamFinished("stream-1", "complete", "unexpected"),
    /Only an errored LLM stream/,
  );
});
