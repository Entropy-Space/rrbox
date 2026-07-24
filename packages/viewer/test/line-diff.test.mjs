import assert from "node:assert/strict";
import test from "node:test";
import { createLineDiffModel } from "../src/line-diff.ts";

const completeDiffOptions = {
  context_lines: 100,
  max_output_rows: 1_000,
};

test("empty content produces an empty exact diff", () => {
  const model = createLineDiffModel("", "", completeDiffOptions);

  assert.deepEqual(model, {
    rows: [],
    additions: 0,
    deletions: 0,
    before_line_count: 0,
    after_line_count: 0,
    is_simplified: false,
    is_truncated: false,
  });
});

test("created content is represented entirely as additions", () => {
  const after = "alpha\nbeta\n";
  const model = createLineDiffModel("", after, completeDiffOptions);

  assert.equal(model.additions, 2);
  assert.equal(model.deletions, 0);
  assert.deepEqual(
    model.rows.map((row) => row.kind),
    ["addition", "addition"],
  );
  assert.equal(rebuildContent(model.rows, "before"), "");
  assert.equal(rebuildContent(model.rows, "after"), after);
});

test("deleted content is represented entirely as deletions", () => {
  const before = "alpha\nbeta\n";
  const model = createLineDiffModel(before, "", completeDiffOptions);

  assert.equal(model.additions, 0);
  assert.equal(model.deletions, 2);
  assert.deepEqual(
    model.rows.map((row) => row.kind),
    ["deletion", "deletion"],
  );
  assert.equal(rebuildContent(model.rows, "before"), before);
  assert.equal(rebuildContent(model.rows, "after"), "");
});

test("updated content keeps context around a minimal replacement", () => {
  const before = "one\ntwo\nthree\n";
  const after = "one\nTWO\nthree\n";
  const model = createLineDiffModel(before, after, completeDiffOptions);

  assert.equal(model.additions, 1);
  assert.equal(model.deletions, 1);
  assert.deepEqual(
    model.rows.map((row) => [row.kind, "text" in row ? row.text : null]),
    [
      ["context", "one"],
      ["deletion", "two"],
      ["addition", "TWO"],
      ["context", "three"],
    ],
  );
  assert.equal(rebuildContent(model.rows, "before"), before);
  assert.equal(rebuildContent(model.rows, "after"), after);
});

test("a trailing newline is preserved as a real text change", () => {
  const model = createLineDiffModel("alpha", "alpha\n", completeDiffOptions);

  assert.equal(model.additions, 1);
  assert.equal(model.deletions, 1);
  assert.deepEqual(
    model.rows.map((row) => [
      row.kind,
      "line_ending" in row ? row.line_ending : undefined,
    ]),
    [
      ["deletion", null],
      ["addition", "\n"],
    ],
  );
  assert.equal(rebuildContent(model.rows, "before"), "alpha");
  assert.equal(rebuildContent(model.rows, "after"), "alpha\n");
});

test("repeated lines use a stable deletion-first LCS tie break", () => {
  const before = "A\nB\nA\n";
  const after = "A\nA\nB\n";
  const first = createLineDiffModel(before, after, completeDiffOptions);
  const second = createLineDiffModel(before, after, completeDiffOptions);

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.rows.map((row) => [row.kind, "text" in row ? row.text : null]),
    [
      ["context", "A"],
      ["deletion", "B"],
      ["context", "A"],
      ["addition", "B"],
    ],
  );
  assert.equal(rebuildContent(first.rows, "before"), before);
  assert.equal(rebuildContent(first.rows, "after"), after);
});

test("bounded LCS diffs are minimal and reconstruct every small repeated input", () => {
  const sequences = binaryLineSequences(4);
  for (const beforeLines of sequences) {
    for (const afterLines of sequences) {
      const before = serializeLines(beforeLines);
      const after = serializeLines(afterLines);
      const model = createLineDiffModel(before, after, completeDiffOptions);
      const shared = lcsLength(beforeLines, afterLines);

      assert.equal(model.deletions, beforeLines.length - shared);
      assert.equal(model.additions, afterLines.length - shared);
      assert.equal(rebuildContent(model.rows, "before"), before);
      assert.equal(rebuildContent(model.rows, "after"), after);
    }
  }
});

test("large changes use a bounded deterministic fallback", () => {
  const before = [
    "shared start",
    ...Array.from({ length: 1_000 }, (_, index) => `before ${index}`),
    "shared end",
    "",
  ].join("\n");
  const after = [
    "shared start",
    ...Array.from({ length: 1_000 }, (_, index) => `after ${index}`),
    "shared end",
    "",
  ].join("\n");
  const model = createLineDiffModel(before, after, {
    max_matrix_cells: 100,
    context_lines: 2,
    max_output_rows: 25,
  });

  assert.equal(model.is_simplified, true);
  assert.equal(model.is_truncated, true);
  assert.equal(model.additions, 1_000);
  assert.equal(model.deletions, 1_000);
  assert.ok(model.rows.length <= 25);
  assert.equal(model.rows[0].kind, "context");
  assert.equal(model.rows[0].text, "shared start");
  assert.equal(model.rows.at(-1).kind, "context");
  assert.equal(model.rows.at(-1).text, "shared end");
  assert.ok(
    model.rows.some(
      (row) =>
        row.kind === "omission" &&
        row.addition_count > 0 &&
        row.deletion_count > 0,
    ),
  );
});

function rebuildContent(rows, side) {
  return rows
    .filter(
      (row) =>
        row.kind !== "omission" &&
        (side === "before"
          ? row.kind !== "addition"
          : row.kind !== "deletion"),
    )
    .map((row) => row.text + (row.line_ending ?? ""))
    .join("");
}

function binaryLineSequences(maximumLength) {
  const sequences = [[]];
  for (let length = 1; length <= maximumLength; length += 1) {
    for (let mask = 0; mask < 2 ** length; mask += 1) {
      sequences.push(
        Array.from(
          { length },
          (_, index) => (mask & (1 << index) ? "A" : "B"),
        ),
      );
    }
  }
  return sequences;
}

function serializeLines(lines) {
  return lines.map((line) => `${line}\n`).join("");
}

function lcsLength(left, right) {
  const matrix = Array.from(
    { length: left.length + 1 },
    () => Array(right.length + 1).fill(0),
  );
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (
      let rightIndex = right.length - 1;
      rightIndex >= 0;
      rightIndex -= 1
    ) {
      matrix[leftIndex][rightIndex] =
        left[leftIndex] === right[rightIndex]
          ? matrix[leftIndex + 1][rightIndex + 1] + 1
          : Math.max(
              matrix[leftIndex + 1][rightIndex],
              matrix[leftIndex][rightIndex + 1],
            );
    }
  }
  return matrix[0][0];
}
