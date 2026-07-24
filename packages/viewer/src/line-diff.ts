export type LineEnding = "\n" | "\r\n" | "\r" | null;

export type LineDiffContentRow = {
  kind: "context" | "addition" | "deletion";
  text: string;
  line_ending: LineEnding;
  before_line_number: number | null;
  after_line_number: number | null;
};

export type LineDiffOmissionRow = {
  kind: "omission";
  before_line_count: number;
  after_line_count: number;
  addition_count: number;
  deletion_count: number;
};

export type LineDiffRow = LineDiffContentRow | LineDiffOmissionRow;

export type LineDiffModel = {
  rows: LineDiffRow[];
  additions: number;
  deletions: number;
  before_line_count: number;
  after_line_count: number;
  is_simplified: boolean;
  is_truncated: boolean;
};

export type LineDiffOptions = {
  /**
   * Maximum number of LCS matrix cells. Larger inputs use a deterministic,
   * linear-memory prefix/suffix fallback instead of allocating quadratically.
   */
  max_matrix_cells?: number;
  /** Number of unchanged lines retained on either side of a change. */
  context_lines?: number;
  /** Maximum number of presentation rows, including omission rows. */
  max_output_rows?: number;
};

type DiffLine = {
  text: string;
  line_ending: LineEnding;
};

const DEFAULT_MAX_MATRIX_CELLS = 250_000;
const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_OUTPUT_ROWS = 400;

export function createLineDiffModel(
  beforeContent: string,
  afterContent: string,
  options: LineDiffOptions = {},
): LineDiffModel {
  const maxMatrixCells = readNonNegativeInteger(
    options.max_matrix_cells,
    DEFAULT_MAX_MATRIX_CELLS,
    "max_matrix_cells",
  );
  const contextLines = readNonNegativeInteger(
    options.context_lines,
    DEFAULT_CONTEXT_LINES,
    "context_lines",
  );
  const maxOutputRows = readPositiveInteger(
    options.max_output_rows,
    DEFAULT_MAX_OUTPUT_ROWS,
    "max_output_rows",
  );
  const beforeLines = splitDiffLines(beforeContent);
  const afterLines = splitDiffLines(afterContent);
  const canUseLcs = matrixFits(
    beforeLines.length,
    afterLines.length,
    maxMatrixCells,
  );
  const completeRows = canUseLcs
    ? createLcsRows(beforeLines, afterLines)
    : createFallbackRows(beforeLines, afterLines);
  const additions = completeRows.reduce(
    (count, row) => count + (row.kind === "addition" ? 1 : 0),
    0,
  );
  const deletions = completeRows.reduce(
    (count, row) => count + (row.kind === "deletion" ? 1 : 0),
    0,
  );
  const contextualRows = collapseUnchangedRows(completeRows, contextLines);
  const boundedRows = boundOutputRows(contextualRows, maxOutputRows);

  return {
    rows: boundedRows.rows,
    additions,
    deletions,
    before_line_count: beforeLines.length,
    after_line_count: afterLines.length,
    is_simplified: !canUseLcs,
    is_truncated: boundedRows.is_truncated,
  };
}

export function splitDiffLines(content: string): DiffLine[] {
  if (content.length === 0) return [];

  const lines: DiffLine[] = [];
  const lineEndingPattern = /\r\n|\n|\r/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = lineEndingPattern.exec(content)) !== null) {
    lines.push({
      text: content.slice(start, match.index),
      line_ending: match[0] as Exclude<LineEnding, null>,
    });
    start = match.index + match[0].length;
  }
  if (start < content.length) {
    lines.push({
      text: content.slice(start),
      line_ending: null,
    });
  }
  return lines;
}

function createLcsRows(
  beforeLines: readonly DiffLine[],
  afterLines: readonly DiffLine[],
): LineDiffContentRow[] {
  const rowLength = afterLines.length + 1;
  const matrix = new Uint32Array((beforeLines.length + 1) * rowLength);

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      const cell = beforeIndex * rowLength + afterIndex;
      matrix[cell] = linesEqual(
        beforeLines[beforeIndex],
        afterLines[afterIndex],
      )
        ? matrix[(beforeIndex + 1) * rowLength + afterIndex + 1] + 1
        : Math.max(
            matrix[(beforeIndex + 1) * rowLength + afterIndex],
            matrix[beforeIndex * rowLength + afterIndex + 1],
          );
    }
  }

  const rows: LineDiffContentRow[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (
    beforeIndex < beforeLines.length ||
    afterIndex < afterLines.length
  ) {
    const beforeLine = beforeLines[beforeIndex];
    const afterLine = afterLines[afterIndex];
    if (
      beforeLine !== undefined &&
      afterLine !== undefined &&
      linesEqual(beforeLine, afterLine)
    ) {
      rows.push(
        contentRow(
          "context",
          beforeLine,
          beforeIndex + 1,
          afterIndex + 1,
        ),
      );
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    const deletionScore =
      beforeIndex < beforeLines.length
        ? matrix[(beforeIndex + 1) * rowLength + afterIndex]
        : -1;
    const additionScore =
      afterIndex < afterLines.length
        ? matrix[beforeIndex * rowLength + afterIndex + 1]
        : -1;
    if (beforeLine !== undefined && deletionScore >= additionScore) {
      rows.push(
        contentRow(
          "deletion",
          beforeLine,
          beforeIndex + 1,
          null,
        ),
      );
      beforeIndex += 1;
    } else if (afterLine !== undefined) {
      rows.push(
        contentRow(
          "addition",
          afterLine,
          null,
          afterIndex + 1,
        ),
      );
      afterIndex += 1;
    }
  }
  return rows;
}

function createFallbackRows(
  beforeLines: readonly DiffLine[],
  afterLines: readonly DiffLine[],
): LineDiffContentRow[] {
  let prefixLength = 0;
  const sharedLength = Math.min(beforeLines.length, afterLines.length);
  while (
    prefixLength < sharedLength &&
    linesEqual(beforeLines[prefixLength], afterLines[prefixLength])
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < sharedLength - prefixLength &&
    linesEqual(
      beforeLines[beforeLines.length - suffixLength - 1],
      afterLines[afterLines.length - suffixLength - 1],
    )
  ) {
    suffixLength += 1;
  }

  const rows: LineDiffContentRow[] = [];
  for (let index = 0; index < prefixLength; index += 1) {
    rows.push(
      contentRow("context", beforeLines[index], index + 1, index + 1),
    );
  }
  for (
    let index = prefixLength;
    index < beforeLines.length - suffixLength;
    index += 1
  ) {
    rows.push(contentRow("deletion", beforeLines[index], index + 1, null));
  }
  for (
    let index = prefixLength;
    index < afterLines.length - suffixLength;
    index += 1
  ) {
    rows.push(contentRow("addition", afterLines[index], null, index + 1));
  }
  for (let offset = suffixLength; offset > 0; offset -= 1) {
    const beforeIndex = beforeLines.length - offset;
    const afterIndex = afterLines.length - offset;
    rows.push(
      contentRow(
        "context",
        beforeLines[beforeIndex],
        beforeIndex + 1,
        afterIndex + 1,
      ),
    );
  }
  return rows;
}

function collapseUnchangedRows(
  rows: readonly LineDiffContentRow[],
  contextLines: number,
): LineDiffRow[] {
  const result: LineDiffRow[] = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index]?.kind !== "context") {
      result.push(rows[index]);
      index += 1;
      continue;
    }

    const runStart = index;
    while (index < rows.length && rows[index]?.kind === "context") {
      index += 1;
    }
    const run = rows.slice(runStart, index);
    const isLeading = runStart === 0;
    const isTrailing = index === rows.length;
    const leadingKeep = isLeading && !isTrailing ? 0 : contextLines;
    const trailingKeep = isTrailing && !isLeading ? 0 : contextLines;
    const maximumVisible = leadingKeep + trailingKeep;
    if (run.length <= maximumVisible) {
      result.push(...run);
      continue;
    }

    if (leadingKeep > 0) result.push(...run.slice(0, leadingKeep));
    result.push(omissionRow(run.slice(leadingKeep, run.length - trailingKeep)));
    if (trailingKeep > 0) {
      result.push(...run.slice(run.length - trailingKeep));
    }
  }
  return result;
}

function boundOutputRows(
  rows: readonly LineDiffRow[],
  maximum: number,
): { rows: LineDiffRow[]; is_truncated: boolean } {
  if (rows.length <= maximum) {
    return { rows: [...rows], is_truncated: false };
  }
  if (maximum === 1) {
    return {
      rows: [omissionRow(rows)],
      is_truncated: true,
    };
  }

  const headLength = Math.floor((maximum - 1) / 2);
  const tailLength = maximum - headLength - 1;
  return {
    rows: [
      ...rows.slice(0, headLength),
      omissionRow(rows.slice(headLength, rows.length - tailLength)),
      ...rows.slice(rows.length - tailLength),
    ],
    is_truncated: true,
  };
}

function omissionRow(
  rows: readonly LineDiffRow[],
): LineDiffOmissionRow {
  let beforeLineCount = 0;
  let afterLineCount = 0;
  let additionCount = 0;
  let deletionCount = 0;
  for (const row of rows) {
    if (row.kind === "omission") {
      beforeLineCount += row.before_line_count;
      afterLineCount += row.after_line_count;
      additionCount += row.addition_count;
      deletionCount += row.deletion_count;
      continue;
    }
    if (row.kind !== "addition") beforeLineCount += 1;
    if (row.kind !== "deletion") afterLineCount += 1;
    if (row.kind === "addition") additionCount += 1;
    if (row.kind === "deletion") deletionCount += 1;
  }
  return {
    kind: "omission",
    before_line_count: beforeLineCount,
    after_line_count: afterLineCount,
    addition_count: additionCount,
    deletion_count: deletionCount,
  };
}

function contentRow(
  kind: LineDiffContentRow["kind"],
  line: DiffLine,
  beforeLineNumber: number | null,
  afterLineNumber: number | null,
): LineDiffContentRow {
  return {
    kind,
    text: line.text,
    line_ending: line.line_ending,
    before_line_number: beforeLineNumber,
    after_line_number: afterLineNumber,
  };
}

function linesEqual(left: DiffLine, right: DiffLine): boolean {
  return left.text === right.text && left.line_ending === right.line_ending;
}

function matrixFits(
  beforeLength: number,
  afterLength: number,
  maximumCells: number,
): boolean {
  const columns = afterLength + 1;
  return (
    columns <= maximumCells &&
    beforeLength + 1 <= Math.floor(maximumCells / columns)
  );
}

function readNonNegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return resolved;
}

function readPositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}
