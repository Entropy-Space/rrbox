import assert from "node:assert/strict";
import test from "node:test";
import {
  ARCHIVE_WORKER_PROTOCOL_VERSION,
  createDecodeWorkspaceArchiveRequest,
  createEncodeWorkspaceArchiveRequest,
} from "../browser/archive-worker-protocol.ts";
import {
  BrowserWorkspaceTransferAdapter,
  WorkspaceArchiveWorkerError,
  WORKSPACE_ARCHIVE_WORKER_TIMEOUT_MS,
  createWorkspaceArchiveFileName,
  deriveWorkspaceProjectName,
  pickWorkspaceArchiveFile,
  readFileAsArrayBuffer,
  runArchiveWorker,
  scheduleWorkspaceArchiveUrlRevocation,
  triggerWorkspaceArchiveDownload,
} from "../browser/workspace-transfer.ts";
import {
  BROWSER_WORKSPACE_ARCHIVE_LIMITS,
} from "@researchbox/app-runtime-browser/workspace-transfer-limits";

test("derives safe project and download names", () => {
  assert.equal(
    deriveWorkspaceProjectName("My project.researchbox.zip"),
    "My project",
  );
  assert.equal(deriveWorkspaceProjectName("Prototype.ZIP"), "Prototype");
  assert.equal(deriveWorkspaceProjectName("../CON.zip"), "_CON");
  assert.equal(
    deriveWorkspaceProjectName("unsafe\u0000/name?.zip"),
    "unsafe name",
  );
  assert.equal(
    deriveWorkspaceProjectName("..\\/.researchbox.zip"),
    "Imported workspace",
  );
  assert.equal(
    createWorkspaceArchiveFileName("Project.researchbox.zip"),
    "Project.researchbox.zip",
  );
  assert.equal(
    createWorkspaceArchiveFileName("A/B:*?"),
    "A B.researchbox.zip",
  );
  assert.equal(
    createWorkspaceArchiveFileName("..."),
    "workspace.researchbox.zip",
  );

  const unicodeName = deriveWorkspaceProjectName(`${"😀".repeat(50)}.zip`);
  assert.equal(unicodeName.length, 80);
  assert.doesNotMatch(unicodeName, /[\ud800-\udbff]$/u);
});

test("transfers decode bytes and terminates its one-shot worker", async () => {
  const worker = new FakeWorker();
  const controller = new AbortController();
  const archiveBytes = new ArrayBuffer(16);
  const request = createDecodeWorkspaceArchiveRequest(archiveBytes);
  const resultPromise = runArchiveWorker(
    () => worker,
    request,
    controller.signal,
  );

  assert.equal(worker.messages.length, 1);
  assert.equal(worker.messages[0].message, request);
  assert.deepEqual(worker.messages[0].transfer, [archiveBytes]);

  worker.respond({
    protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
    type: "workspace_archive_decoded",
    files: [{ path: "README.md", content: "# Imported" }],
  });

  assert.deepEqual(await resultPromise, {
    protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
    type: "workspace_archive_decoded",
    files: [{ path: "README.md", content: "# Imported" }],
  });
  assert.equal(worker.terminateCount, 1);
  assert.equal(worker.listenerCount("message"), 0);
});

test("accepts transferred encode output and surfaces worker failures", async () => {
  const successWorker = new FakeWorker();
  const successPromise = runArchiveWorker(
    () => successWorker,
    createEncodeWorkspaceArchiveRequest([
      { path: "README.md", content: "# Exported" },
    ]),
    new AbortController().signal,
  );
  const archiveBytes = new ArrayBuffer(24);
  successWorker.respond({
    protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
    type: "workspace_archive_encoded",
    archive_bytes: archiveBytes,
  });

  assert.equal((await successPromise).archive_bytes, archiveBytes);
  assert.deepEqual(successWorker.messages[0].transfer, []);
  assert.equal(successWorker.terminateCount, 1);

  const failureWorker = new FakeWorker();
  const failurePromise = runArchiveWorker(
    () => failureWorker,
    createDecodeWorkspaceArchiveRequest(new ArrayBuffer(1)),
    new AbortController().signal,
  );
  failureWorker.respond({
    protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
    type: "workspace_archive_error",
    error_code: "invalid_archive",
    error_message: "Bad workspace archive.",
  });

  await assert.rejects(
    failurePromise,
    (error) =>
      error instanceof WorkspaceArchiveWorkerError &&
      error.error_code === "invalid_archive" &&
      error.message === "Bad workspace archive.",
  );
  assert.equal(failureWorker.terminateCount, 1);
});

test("aborting an archive operation terminates the worker", async () => {
  const worker = new FakeWorker();
  const controller = new AbortController();
  const resultPromise = runArchiveWorker(
    () => worker,
    createDecodeWorkspaceArchiveRequest(new ArrayBuffer(1)),
    controller.signal,
  );

  controller.abort();

  await assert.rejects(resultPromise, { name: "AbortError" });
  assert.equal(worker.terminateCount, 1);
  assert.equal(worker.listenerCount("message"), 0);
});

test("archive worker operations have a bounded watchdog", async () => {
  assert.equal(WORKSPACE_ARCHIVE_WORKER_TIMEOUT_MS, 120_000);
  const worker = new FakeWorker();
  const resultPromise = runArchiveWorker(
    () => worker,
    createDecodeWorkspaceArchiveRequest(new ArrayBuffer(1)),
    new AbortController().signal,
    0,
  );

  await assert.rejects(
    resultPromise,
    (error) =>
      error instanceof WorkspaceArchiveWorkerError &&
      error.error_code === "archive_worker_failed" &&
      /timed out/.test(error.message),
  );
  assert.equal(worker.terminateCount, 1);
  assert.equal(worker.listenerCount("message"), 0);
});

test("file picker accepts ZIPs, handles cancellation, and removes its input", async () => {
  const browserDocument = new FakeDocument();
  const selectionPromise = pickWorkspaceArchiveFile(
    browserDocument,
    new AbortController().signal,
  );
  const input = browserDocument.inputs[0];

  assert.equal(input.accept, ".zip,application/zip");
  assert.equal(input.multiple, false);
  assert.equal(input.valueWhenClicked, "");
  input.dispatchEvent(new Event("cancel"));

  assert.equal(await selectionPromise, null);
  assert.equal(input.removed, true);
});

test("a delayed cloud-provider change is not mistaken for cancellation", async () => {
  const archive = new File(["zip"], "icloud.zip", {
    type: "application/zip",
  });
  const browserDocument = new FakeDocument();
  let settled = false;
  const selectionPromise = pickWorkspaceArchiveFile(
    browserDocument,
    new AbortController().signal,
  ).then((file) => {
    settled = true;
    return file;
  });
  const input = browserDocument.inputs[0];

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(settled, false);
  assert.equal(input.removed, false);

  input.files = fileList(archive);
  input.dispatchEvent(new Event("change"));

  assert.equal(await selectionPromise, archive);
  assert.equal(input.removed, true);
});

test("fresh file inputs allow selecting the same archive twice", async () => {
  const archive = new File(["zip"], "same.zip", {
    type: "application/zip",
  });
  const browserDocument = new FakeDocument((input) => {
    input.files = fileList(archive);
    input.dispatchEvent(new Event("change"));
  });
  const first = await pickWorkspaceArchiveFile(
    browserDocument,
    new AbortController().signal,
  );
  const second = await pickWorkspaceArchiveFile(
    browserDocument,
    new AbortController().signal,
  );

  assert.equal(first, archive);
  assert.equal(second, archive);
  assert.equal(browserDocument.inputs.length, 2);
  assert.ok(browserDocument.inputs.every((input) => input.valueWhenClicked === ""));
  assert.ok(browserDocument.inputs.every((input) => input.removed));
});

test("file picker and file reads stop promptly on abort", async () => {
  const browserDocument = new FakeDocument();
  const pickerController = new AbortController();
  const selectionPromise = pickWorkspaceArchiveFile(
    browserDocument,
    pickerController.signal,
  );

  pickerController.abort();

  await assert.rejects(selectionPromise, { name: "AbortError" });
  assert.equal(browserDocument.inputs[0].removed, true);

  const reader = new FakeFileReader();
  const readerController = new AbortController();
  const readPromise = readFileAsArrayBuffer(
    new File(["zip"], "workspace.zip"),
    readerController.signal,
    () => reader,
  );
  readerController.abort();

  await assert.rejects(readPromise, { name: "AbortError" });
  assert.equal(reader.abortCount, 1);
});

test("rejects oversized imports before reading or starting a worker", async () => {
  let readersCreated = 0;
  let workersCreated = 0;
  const oversizedFile = {
    name: "too-large.zip",
    size: BROWSER_WORKSPACE_ARCHIVE_LIMITS.max_archive_bytes + 1,
  };
  const browserDocument = new FakeDocument((input) => {
    input.files = fileList(oversizedFile);
    input.dispatchEvent(new Event("change"));
  });
  const adapter = new BrowserWorkspaceTransferAdapter({
    getDocument: () => browserDocument,
    getWindow: () => new FakeWindow(),
    createFileReader: () => {
      readersCreated += 1;
      return new FakeFileReader();
    },
    createArchiveWorker: () => {
      workersCreated += 1;
      return new FakeWorker();
    },
  });

  await assert.rejects(
    adapter.pickWorkspaceImport({
      signal: new AbortController().signal,
    }),
    /16 MiB import limit/,
  );
  assert.equal(readersCreated, 0);
  assert.equal(workersCreated, 0);
});

test("successful downloads revoke in a later task", () => {
  const browserDocument = new FakeDocument();
  const scheduled = [];
  const revoked = [];
  let createdBlob = null;

  triggerWorkspaceArchiveDownload({
    archive_bytes: new Uint8Array([1, 2, 3]).buffer,
    file_name: "Project.researchbox.zip",
    signal: new AbortController().signal,
    document: browserDocument,
    create_object_url(blob) {
      createdBlob = blob;
      return "blob:workspace";
    },
    revoke_object_url(url) {
      revoked.push(url);
    },
    schedule_object_url_revocation(callback) {
      scheduled.push(callback);
    },
  });

  assert.equal(createdBlob.type, "application/zip");
  assert.equal(createdBlob.size, 3);
  assert.equal(browserDocument.anchors[0].download, "Project.researchbox.zip");
  assert.equal(browserDocument.anchors[0].clickCount, 1);
  assert.equal(browserDocument.anchors[0].removed, true);
  assert.deepEqual(revoked, []);
  assert.equal(scheduled.length, 1);

  scheduled[0]();
  assert.deepEqual(revoked, ["blob:workspace"]);
});

test("default download cleanup gives WebKit time to consume the Blob URL", () => {
  let scheduledDelay = null;
  let scheduledCallback = null;
  const callback = () => {};

  scheduleWorkspaceArchiveUrlRevocation(
    {
      setTimeout(nextCallback, delay) {
        scheduledCallback = nextCallback;
        scheduledDelay = delay;
        return 1;
      },
    },
    callback,
  );

  assert.equal(scheduledCallback, callback);
  assert.equal(scheduledDelay, 60_000);
});

test("failed download setup or click revokes immediately", () => {
  for (const failure of ["setup", "click"]) {
    const browserDocument = new FakeDocument();
    const controller = new AbortController();
    const revoked = [];
    let scheduled = false;
    if (failure === "click") {
      browserDocument.anchorClickError = new Error("Download click failed.");
    }

    assert.throws(
      () =>
        triggerWorkspaceArchiveDownload({
          archive_bytes: new ArrayBuffer(1),
          file_name: "Project.researchbox.zip",
          signal: controller.signal,
          document: browserDocument,
          create_object_url() {
            if (failure === "setup") controller.abort();
            return "blob:workspace";
          },
          revoke_object_url(url) {
            revoked.push(url);
          },
          schedule_object_url_revocation() {
            scheduled = true;
          },
        }),
      failure === "setup" ? { name: "AbortError" } : /Download click failed/,
    );
    assert.deepEqual(revoked, ["blob:workspace"]);
    assert.equal(scheduled, false);
  }
});

class FakeWorker extends EventTarget {
  messages = [];
  terminateCount = 0;
  #listenerCounts = new Map();

  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    this.#listenerCounts.set(type, (this.#listenerCounts.get(type) ?? 0) + 1);
  }

  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    this.#listenerCounts.set(
      type,
      Math.max(0, (this.#listenerCounts.get(type) ?? 0) - 1),
    );
  }

  postMessage(message, transfer = []) {
    this.messages.push({ message, transfer });
  }

  terminate() {
    this.terminateCount += 1;
  }

  respond(data) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  listenerCount(type) {
    return this.#listenerCounts.get(type) ?? 0;
  }
}

class FakeInput extends EventTarget {
  accept = "";
  attributes = new Map();
  files = null;
  multiple = false;
  removed = false;
  style = {};
  tabIndex = 0;
  type = "";
  value = "previous-selection";
  valueWhenClicked = null;

  constructor(onClick) {
    super();
    this.onClick = onClick;
  }

  click() {
    this.valueWhenClicked = this.value;
    this.onClick?.(this);
  }

  remove() {
    this.removed = true;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

class FakeAnchor {
  clickCount = 0;
  download = "";
  hidden = false;
  href = "";
  removed = false;

  constructor(clickError) {
    this.clickError = clickError;
  }

  click() {
    this.clickCount += 1;
    if (this.clickError) throw this.clickError;
  }

  remove() {
    this.removed = true;
  }
}

class FakeDocument {
  anchors = [];
  inputs = [];
  anchorClickError = null;
  body = {
    append: () => {},
  };

  constructor(onInputClick) {
    this.onInputClick = onInputClick;
  }

  createElement(tagName) {
    if (tagName === "input") {
      const input = new FakeInput(this.onInputClick);
      this.inputs.push(input);
      return input;
    }
    if (tagName === "a") {
      const anchor = new FakeAnchor(this.anchorClickError);
      this.anchors.push(anchor);
      return anchor;
    }
    throw new Error(`Unexpected element: ${tagName}`);
  }
}

class FakeWindow extends EventTarget {
  clearTimeout(timer) {
    clearTimeout(timer);
  }

  setTimeout(callback, delay) {
    return setTimeout(callback, delay);
  }
}

class FakeFileReader extends EventTarget {
  abortCount = 0;
  error = null;
  result = null;

  abort() {
    this.abortCount += 1;
    this.dispatchEvent(new Event("abort"));
  }

  readAsArrayBuffer() {}
}

function fileList(file) {
  return {
    0: file,
    length: 1,
    item(index) {
      return index === 0 ? file : null;
    },
  };
}
