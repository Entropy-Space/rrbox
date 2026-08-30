import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { parseCoreEvent } from "@researchbox/protocol";
import DshrboxSummaryReview from "../src/index.ts";

test("opens, updates, and resolves one live summary review", async () => {
  const { context, events } = await createContext();
  try {
    context.dshrboxSummaryReview.beginRequest("prompt-request");
    const interaction = context.dshrboxSummaryReview.open(reviewInput());
    const requested = events.at(-1);
    assert.equal(requested.type, "summary_review_requested");
    assert.equal(requested.request_id, "prompt-request");
    assert.equal(requested.payload.project_id, "project-1");
    assert.equal(requested.payload.session_id, "session-1");
    assert.deepEqual(parseCoreEvent(requested), requested);

    let activityCount = 0;
    let visible = true;
    const unsubscribeActivity = interaction.subscribeActivity(() => {
      activityCount += 1;
    });
    const unsubscribeVisibility = interaction.subscribeVisibility((value) => {
      visible = value;
    });
    assert.equal(interaction.isVisible(), true);
    assert.equal(
      context.dshrboxSummaryReview.touch(requested.payload.interaction_id),
      true,
    );
    assert.equal(activityCount, 1);
    assert.equal(
      context.dshrboxSummaryReview.setVisibility(
        requested.payload.interaction_id,
        false,
      ),
      true,
    );
    assert.equal(visible, false);
    assert.equal(interaction.isVisible(), false);

    interaction.update(reviewInput({ title: "Updated review" }));
    const updated = events.at(-1);
    assert.equal(updated.type, "summary_review_updated");
    assert.equal(updated.payload.interaction_id, requested.payload.interaction_id);
    assert.equal(updated.payload.title, "Updated review");
    assert.deepEqual(parseCoreEvent(updated), updated);

    const submitted = resolution();
    context.dshrboxSummaryReview.resolve(
      requested.payload.interaction_id,
      submitted,
    );
    assert.deepEqual(await interaction.resolution, submitted);
    assert.notEqual(await interaction.resolution, submitted);
    assert.equal(interaction.isVisible(), false);
    assert.equal(
      context.dshrboxSummaryReview.touch(requested.payload.interaction_id),
      false,
    );
    assert.equal(events.length, 2);
    unsubscribeActivity();
    unsubscribeVisibility();
    context.dshrboxSummaryReview.endRequest();
  } finally {
    await context.fiber.dispose();
  }
});

test("keeps a loading review pending after an invalid resolution", async () => {
  const { context, events } = await createContext();
  try {
    context.dshrboxSummaryReview.beginRequest("prompt-request");
    const interaction = context.dshrboxSummaryReview.open(reviewInput({
      is_loading: true,
      loading_phase: "search",
      sections: [],
      selected_section_ids: [],
    }));
    const interactionId = events.at(-1).payload.interaction_id;
    assert.throws(
      () => context.dshrboxSummaryReview.resolve(
        interactionId,
        resolution({ decision: "approve" }),
      ),
      /cannot be submitted while it is loading/u,
    );

    const changedProvider = resolution({
      decision: "change-provider",
      search_provider: "exa",
      selected_section_ids: [],
    });
    context.dshrboxSummaryReview.resolve(interactionId, changedProvider);
    assert.deepEqual(await interaction.resolution, changedProvider);
    context.dshrboxSummaryReview.endRequest();
  } finally {
    await context.fiber.dispose();
  }
});

test("cancels a pending review with a dismiss viewer event", async () => {
  const { context, events } = await createContext();
  try {
    context.dshrboxSummaryReview.beginRequest("prompt-request");
    const controller = new AbortController();
    const interaction = context.dshrboxSummaryReview.open(
      reviewInput(),
      controller.signal,
    );
    const interactionId = events.at(-1).payload.interaction_id;
    controller.abort();

    await assert.rejects(
      interaction.resolution,
      (error) => error instanceof DOMException && error.name === "AbortError",
    );
    const resolved = events.at(-1);
    assert.equal(resolved.type, "summary_review_resolved");
    assert.equal(resolved.request_id, "prompt-request");
    assert.deepEqual(resolved.payload, {
      project_id: "project-1",
      session_id: "session-1",
      interaction_id: interactionId,
      decision: "dismiss",
    });
    assert.deepEqual(parseCoreEvent(resolved), resolved);
    context.dshrboxSummaryReview.endRequest();
  } finally {
    await context.fiber.dispose();
  }
});

test("disposal settles a pending interaction", async () => {
  const { context, events } = await createContext();
  const service = context.dshrboxSummaryReview;
  service.beginRequest("prompt-request");
  const interaction = service.open(reviewInput());
  await context.fiber.dispose();
  await assert.rejects(interaction.resolution, /disposed/u);
  assert.equal(events.at(-1).type, "summary_review_resolved");
  assert.throws(
    () => service.beginRequest("another-request"),
    /disposed/u,
  );
});

async function createContext() {
  const events = [];
  const context = new Context();
  await context.plugin(DshrboxSummaryReview, {
    project_id: "project-1",
    session_id: "session-1",
    event_sink: (event) => events.push(event),
  });
  return { context, events };
}

function reviewInput(overrides = {}) {
  return {
    stage: "select-evidence",
    is_loading: false,
    loading_phase: null,
    auto_submit_at: null,
    title: "Review evidence",
    draft_text: "",
    summary_model: null,
    draft_metadata: null,
    query_draft: "",
    query_notice: null,
    search_providers: [{ provider_id: "exa", display_name: "Exa" }],
    search_provider: "exa",
    sections: [{
      section_id: "result-1",
      title: "Result one",
      body: "Evidence",
      is_selectable: true,
      sources: [{ title: "Source", url: "https://example.com" }],
    }],
    selected_section_ids: ["result-1"],
    ...overrides,
  };
}

function resolution(overrides = {}) {
  return {
    decision: "summarize",
    approved_text: "",
    selected_section_ids: ["result-1"],
    feedback_text: "",
    summary_model: null,
    search_provider: "exa",
    query_text: "",
    ...overrides,
  };
}
