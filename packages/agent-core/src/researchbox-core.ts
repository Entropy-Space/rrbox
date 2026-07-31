import type { Model } from "@earendil-works/pi-ai";
import type { ModelTransport } from "@researchbox/model-transport";
import {
  PROJECT_STORE_SCHEMA_VERSION,
  ProjectStoreConflictError,
  SESSION_DOCUMENT_FORMAT_VERSION,
  type ProjectRecord,
  type ProjectStoreChange,
  type ProjectStore,
  type ProjectStoreState,
  type SessionDocument,
  type SessionRecord,
} from "@researchbox/project-store";
import {
  PROTOCOL_VERSION,
  type CoreEvent,
  type CoreStateSnapshot,
  type FileEntry,
  type ModelSelection,
  type ReasoningEffort,
  type ToolCallBlock,
  type ToolResultEntry,
  type ViewerCommand,
  type WorkspaceChangeDetails,
  type WorkspaceChangeSummary,
  type WorkspaceTransferFile,
} from "@researchbox/protocol";
import {
  assertValidWorkspaceChangeRecord,
  isWorkspaceOrphanReconciler,
  VfsError,
  WorkspaceCorruptionError,
  type VfsSeedFile,
  type VfsEntry,
  type WorkspaceBackend,
  type WorkspaceChangeRecord,
  type WorkspaceChangeRevertResult,
} from "@researchbox/vfs";
import {
  capturePortableWorkspace,
  normalizePortableWorkspaceSnapshot,
  type WorkspaceArchiveOptions,
} from "@researchbox/workspace-archive/snapshot";
import {
  SessionRuntime,
  stagePrompt,
  type CoreEventSink,
} from "./session-runtime.ts";
import {
  snapshotAgentPlugins,
  type AgentPlugin,
} from "./agent-plugin.ts";
import { emptyAssistantUsage } from "./session-codec.ts";
import {
  ProviderCatalogService,
  type ModelProviderDefinition,
  type ProviderModelCatalog,
} from "./provider-catalog-service.ts";
import { WorkspaceController } from "./workspace-controller.ts";

type WorkspaceBackendOption =
  | {
      workspaceBackend: WorkspaceBackend;
      /** @deprecated Use `workspaceBackend`. */
      workspaceProvider?: never;
    }
  | {
      workspaceBackend?: never;
      /** @deprecated Use `workspaceBackend`. */
      workspaceProvider: WorkspaceBackend;
    };

export type ResearchBoxCoreOptions = {
  projectStore: ProjectStore;
  modelTransport: ModelTransport;
  providerCatalog?: ProviderCatalogService;
  modelCatalog?: ProviderModelCatalog;
  model: Model<string>;
  providers?: ModelProviderDefinition[];
  systemPrompt: string;
  plugins?: readonly AgentPlugin[];
  eventSink: CoreEventSink;
  workspaceTransferOptions?: WorkspaceArchiveOptions;
} & WorkspaceBackendOption;

export type AgentCoreOptions = ResearchBoxCoreOptions;

type WorkspaceChangeQuarantineSummary = {
  quarantined_receipt_count: number;
  pending_receipt_count: number;
  affected_project_count: number;
};

type WorkspaceChangeReconciliation = WorkspaceChangeQuarantineSummary & {
  state_changed: boolean;
};

const STARTUP_REPAIR_SAVE_ATTEMPTS = 5;

export class ResearchBoxCore {
  private readonly projectStore: ProjectStore;
  private readonly workspaceBackend: WorkspaceBackend;
  private readonly modelTransport: ModelTransport;
  private readonly providerCatalog: ProviderCatalogService;
  private readonly defaultModelSelection: ModelSelection;
  private readonly systemPrompt: string;
  private readonly plugins: readonly AgentPlugin[];
  private readonly eventSink: CoreEventSink;
  private readonly workspaceTransferOptions: WorkspaceArchiveOptions | undefined;
  private readonly workspaces = new Map<string, WorkspaceController>();
  private readonly selectedSessionByProject = new Map<
    string,
    string | null
  >();
  private state: ProjectStoreState | null = null;
  private workspace: WorkspaceController | null = null;
  private runtime: SessionRuntime | null = null;
  private initialization: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly workspaceExportControllers = new Map<
    string,
    AbortController
  >();
  private workspaceChangeQuarantine:
    | WorkspaceChangeQuarantineSummary
    | null = null;
  private hasEmittedWorkspaceChangeQuarantineStatus = false;
  private emittedWorkspaceChangeQuarantineSignature: string | null = null;
  private providerRefreshObserverStarted = false;
  private readonly unsubscribeProjectStore: () => void;
  private pendingProjectStoreRevision = 0;
  private projectStoreRefreshScheduled = false;
  private selectionActivationPending = false;
  private hasBootstrapped = false;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private submittedDraft:
    | {
        project_id: string;
        session_id: string;
        input_draft: string;
      }
    | null = null;

  constructor(options: ResearchBoxCoreOptions) {
    this.projectStore = options.projectStore;
    this.workspaceBackend =
      options.workspaceBackend ?? options.workspaceProvider;
    this.modelTransport = options.modelTransport;
    this.defaultModelSelection = {
      provider_id: options.model.provider,
      model_id: options.model.id,
    };
    this.providerCatalog =
      options.providerCatalog ??
      new ProviderCatalogService({
        model: options.model,
        providers: options.providers,
        modelCatalog: options.modelCatalog,
      });
    this.systemPrompt = options.systemPrompt;
    this.plugins = snapshotAgentPlugins(options.plugins);
    this.eventSink = options.eventSink;
    this.workspaceTransferOptions = snapshotWorkspaceTransferOptions(
      options.workspaceTransferOptions,
    );
    this.unsubscribeProjectStore = this.projectStore.subscribe((change) =>
      this.handleProjectStoreChange(change),
    );
  }

  async handle(command: ViewerCommand): Promise<void> {
    if (this.disposed) {
      throw new Error("The rrbox core is closed.");
    }
    if (command.type === "workspace_export_cancel") {
      this.cancelWorkspaceExport(command);
      return;
    }
    if (command.type === "workspace_export") {
      // The active request owns the only terminal event for this correlation id.
      if (this.workspaceExportControllers.has(command.request_id)) return;
      const captureController = new AbortController();
      this.workspaceExportControllers.set(
        command.request_id,
        captureController,
      );
      try {
        await this.ensureInitialized();
        if (captureController.signal.aborted) {
          this.emitWorkspaceExportCanceled(command);
          return;
        }
        await this.enqueueMutation(async () => {
          await this.refreshPersistedState();
          await this.exportWorkspace(command, captureController);
        });
      } finally {
        if (
          this.workspaceExportControllers.get(command.request_id) ===
          captureController
        ) {
          this.workspaceExportControllers.delete(command.request_id);
        }
      }
      return;
    }
    await this.ensureInitialized();
    if (this.disposed) {
      throw new Error("The rrbox core is closed.");
    }
    switch (command.type) {
      case "bootstrap":
        await this.enqueueMutation(async () => {
          await this.refreshPersistedState();
          if (this.disposed) return;
          await this.restoreBootstrapSelection(command.payload);
          if (this.disposed) return;
          const state = await this.createCoreState();
          if (this.disposed) return;
          this.hasBootstrapped = true;
          this.emit("ready", { state }, command.request_id);
          this.emitWorkspaceChangeQuarantineStatus();
          this.startProviderRefreshes();
        });
        return;
      case "provider_refresh":
        await this.mutationTail;
        await this.refreshProvider(
          command.payload.provider_id,
          command.request_id,
        );
        return;
      case "abort":
        await this.abort(command);
        return;
      case "summary_review_resolve":
        this.resolveSummaryReview(command);
        return;
      case "summary_review_touch":
        this.touchSummaryReview(command);
        return;
      case "summary_review_visibility":
        this.setSummaryReviewVisibility(command);
        return;
      case "prompt":
        await this.prompt(command);
        return;
      case "fs_list":
        await this.enqueueMutation(async () => {
          await this.refreshPersistedState();
          await this.listFiles(command);
        });
        return;
      case "fs_read":
        await this.enqueueMutation(async () => {
          await this.refreshPersistedState();
          await this.readFile(command);
        });
        return;
      default:
        await this.enqueueMutation(async () => {
          if (command.type !== "input_draft_update") {
            await this.refreshPersistedState();
          }
          await this.handleMutation(command);
        });
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.unsubscribeProjectStore();
    for (const controller of this.workspaceExportControllers.values()) {
      controller.abort();
    }
    this.workspaceExportControllers.clear();
    this.runtime?.abort();
    this.disposal = this.drainForDisposal();
    return this.disposal;
  }

  reportHostError(
    code: "invalid_command" | "command_failed",
    message: string,
    requestId?: string,
  ): void {
    this.emit("error", { code, message }, requestId);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initialize().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    await this.initialization;
  }

  private handleProjectStoreChange(change: ProjectStoreChange): void {
    if (this.disposed) return;
    this.pendingProjectStoreRevision = Math.max(
      this.pendingProjectStoreRevision,
      change.state_revision,
    );
    this.scheduleProjectStoreRefresh();
  }

  private scheduleProjectStoreRefresh(): void {
    if (
      this.disposed ||
      this.projectStoreRefreshScheduled ||
      !this.state ||
      this.pendingProjectStoreRevision <= this.state.state_revision
    ) {
      return;
    }

    this.projectStoreRefreshScheduled = true;
    const requestedRevision = this.pendingProjectStoreRevision;
    void this.enqueueMutation(async () => {
      if (
        this.disposed ||
        this.pendingProjectStoreRevision <=
          this.requireState().state_revision
      ) {
        return;
      }
      try {
        const changed = await this.refreshPersistedState();
        if (
          this.pendingProjectStoreRevision === requestedRevision &&
          this.requireState().state_revision < requestedRevision
        ) {
          // Ignore malformed or prematurely published revision hints instead
          // of repeatedly loading a revision that does not exist.
          this.pendingProjectStoreRevision =
            this.requireState().state_revision;
        }
        if (
          changed &&
          this.hasBootstrapped &&
          !this.selectionActivationPending
        ) {
          await this.emitStateSnapshot();
        }
      } catch (error) {
        if (this.pendingProjectStoreRevision === requestedRevision) {
          this.pendingProjectStoreRevision =
            this.requireState().state_revision;
        }
        this.emitError(
          "persistence_refresh_failed",
          toErrorMessage(
            error,
            "Changes from another browser tab could not be loaded.",
          ),
        );
      }
    }).then(() => {
      this.projectStoreRefreshScheduled = false;
      this.scheduleProjectStoreRefresh();
    });
  }

  private async drainForDisposal(): Promise<void> {
    await this.initialization?.catch(() => undefined);
    while (true) {
      const admittedMutations = this.mutationTail;
      await admittedMutations;
      if (this.mutationTail !== admittedMutations) continue;

      const runtime = this.runtime;
      if (runtime) await runtime.stopAndWait();

      const finalMutations = this.mutationTail;
      await finalMutations;
      if (
        this.mutationTail !== finalMutations ||
        this.runtime !== runtime
      ) {
        continue;
      }
      if (runtime && !runtime.is_running) {
        runtime.dispose();
        if (this.runtime === runtime) this.runtime = null;
      }
      return;
    }
  }

  private async refreshPersistedState(): Promise<boolean> {
    const current = this.requireState();
    const loaded = await this.projectStore.load();
    if (!loaded) {
      throw new Error("The initialized project store is missing.");
    }
    if (loaded.state_revision <= current.state_revision) return false;

    const requestedSelection = {
      project_id: current.active_project_id,
      session_id: current.active_session_id,
    };
    const previousModel = this.getActiveModelSelection();
    const previousReasoningEffort = this.getActiveReasoningEffort();
    this.installCommittedState(loaded, requestedSelection);

    const refreshed = this.requireState();
    const nextModel = this.getActiveModelSelection();
    const activationRequired =
      refreshed.active_project_id !== requestedSelection.project_id ||
      refreshed.active_session_id !== requestedSelection.session_id ||
      nextModel.provider_id !== previousModel.provider_id ||
      nextModel.model_id !== previousModel.model_id ||
      this.getActiveReasoningEffort() !== previousReasoningEffort;
    if (activationRequired) {
      if (this.runtime?.is_running) {
        this.selectionActivationPending = true;
      } else {
        await this.activateSelection();
        this.selectionActivationPending = false;
      }
    }
    return true;
  }

  private async finishPendingSelectionActivation(): Promise<void> {
    if (!this.selectionActivationPending || this.runtime?.is_running) return;
    await this.activateSelection();
    this.selectionActivationPending = false;
    if (this.hasBootstrapped) await this.emitStateSnapshot();
  }

  private async initialize(): Promise<void> {
    let loaded = await this.projectStore.load();
    if (!loaded) {
      loaded = await this.initializeEmptyProjectStore();
    }
    await reconcileOrphanedWorkspaces(
      this.workspaceBackend,
      loaded.projects.map((project) => project.project_id),
    );
    const repaired = await repairPersistedStateOnStartup(
      loaded,
      this.projectStore,
      this.workspaceBackend,
    );
    this.state = repaired.state;
    this.initializeLocalSelection(repaired.state);
    this.workspaceChangeQuarantine =
      workspaceChangeQuarantineFromReconciliation(
        repaired.workspace_change_reconciliation,
      );
    this.ensurePersistedModelsRegistered();
    await this.activateSelection();
  }

  private async initializeEmptyProjectStore(): Promise<ProjectStoreState> {
    const state = createInitialState(this.defaultModelSelection);
    const projectId = state.active_project_id;
    await this.workspaceBackend.create(projectId);
    state.state_revision = 1;
    try {
      await this.projectStore.save(state, null);
      return state;
    } catch (error) {
      const canonical = await this.rollbackWorkspaceCreation(projectId);
      if (canonical) return canonical;
      throw error;
    }
  }

  private async handleMutation(
    command: Exclude<
      ViewerCommand,
      {
        type:
          | "bootstrap"
          | "provider_refresh"
          | "abort"
          | "prompt"
          | "fs_list"
          | "fs_read"
          | "workspace_export"
          | "workspace_export_cancel";
      }
    >,
  ): Promise<void> {
    switch (command.type) {
      case "project_create":
        await this.createProject(command.payload.name, command.request_id);
        return;
      case "project_import":
        await this.importProject(
          command.payload.name,
          command.payload.files,
          command.request_id,
        );
        return;
      case "workspace_change_read":
        await this.readWorkspaceChange(command);
        return;
      case "workspace_change_revert":
        await this.revertWorkspaceChange(command);
        return;
      case "project_update":
        await this.updateProject(
          command.payload.project_id,
          command.payload.name,
          command.request_id,
        );
        return;
      case "project_delete":
        await this.deleteProject(command.payload.project_id, command.request_id);
        return;
      case "project_select":
        await this.selectProject(command.payload.project_id, command.request_id);
        return;
      case "new_chat":
        await this.selectNewChat(
          command.payload.project_id,
          command.request_id,
        );
        return;
      case "model_select":
        await this.selectModel(command.payload, command.request_id);
        return;
      case "reasoning_effort_select":
        await this.selectReasoningEffort(
          command.payload,
          command.request_id,
        );
        return;
      case "input_draft_update":
        await this.updateInputDraft(
          command.payload.project_id,
          command.payload.session_id,
          command.payload.input_draft,
          command.request_id,
        );
        return;
      case "session_update":
        await this.updateSession(
          command.payload.project_id,
          command.payload.session_id,
          command.payload.title,
          command.request_id,
        );
        return;
      case "session_delete":
        await this.deleteSession(
          command.payload.project_id,
          command.payload.session_id,
          command.request_id,
        );
        return;
      case "session_select":
        await this.selectSession(
          command.payload.project_id,
          command.payload.session_id,
          command.request_id,
        );
        return;
    }
  }

  private async prompt(
    command: Extract<ViewerCommand, { type: "prompt" }>,
  ): Promise<void> {
    let runPromise: Promise<void> | null = null;
    await this.enqueueMutation(async () => {
      await this.refreshPersistedState();
      const promptText = command.payload.text.trim();
      if (!promptText) {
        this.emitError(
          "invalid_prompt",
          "A prompt must contain at least one non-whitespace character.",
          command.request_id,
          command.payload.project_id,
          command.payload.session_id ?? undefined,
        );
        return;
      }
      if (
        !this.validateActiveSelection(
          command.payload.project_id,
          command.payload.session_id,
          command.request_id,
        )
      ) {
        return;
      }

      if (this.runtime?.is_running) {
        this.emitError(
          "run_in_progress",
          "Wait for the current response to finish.",
          command.request_id,
          command.payload.project_id,
          command.payload.session_id ?? undefined,
        );
        return;
      }
      const activeModel = this.getActiveModelSelection();
      if (!this.isModelReady(activeModel)) {
        this.emitError(
          "model_unavailable",
          "The selected model is unavailable. Choose another model or retry its provider.",
          command.request_id,
          command.payload.project_id,
          command.payload.session_id ?? undefined,
        );
        return;
      }

      if (command.payload.session_id === null) {
        const currentProject = this.requireProject(
          command.payload.project_id,
        );
        const submittedDraft = currentProject.new_chat_draft;
        const created = createSessionRecord(
          command.payload.project_id,
          deriveSessionTitle(promptText),
          false,
          currentProject.new_chat_model,
          currentProject.new_chat_reasoning_effort,
        );
        const staged = stagePrompt(created.document, promptText);
        try {
          await this.commitMutation(
            (draft) => {
              draft.sessions.push(created.session);
              draft.documents.push(created.document);
              const project = findProject(
                draft,
                command.payload.project_id,
              );
              project.last_session_id = created.session.session_id;
              if (project.new_chat_draft === submittedDraft) {
                project.new_chat_draft = "";
              }
              project.updated_at = created.session.updated_at;
              draft.active_project_id = command.payload.project_id;
              draft.active_session_id = created.session.session_id;
              return draft;
            },
            {
              project_id: command.payload.project_id,
              session_id: created.session.session_id,
            },
          );
        } catch (error) {
          this.emitError(
            "persistence_failed",
            toErrorMessage(error, "The new chat could not be saved."),
            command.request_id,
            command.payload.project_id,
          );
          return;
        }
        await this.activateSelection();
        await this.emitStateSnapshot(command.request_id);
        runPromise = this.requireRuntime().continueStagedPrompt(
          staged.run_id,
          command.request_id,
        );
        return;
      }

      this.submittedDraft = {
        project_id: command.payload.project_id,
        session_id: command.payload.session_id,
        input_draft: this.requireDocument(
          command.payload.session_id,
        ).input_draft,
      };
      runPromise = this.requireRuntime().startPrompt(
        promptText,
        command.request_id,
      );
    });
    if (!runPromise) return;
    try {
      await runPromise;
    } finally {
      this.submittedDraft = null;
      await this.enqueueMutation(() =>
        this.finishPendingSelectionActivation(),
      );
    }
  }

  private async abort(
    command: Extract<ViewerCommand, { type: "abort" }>,
  ): Promise<void> {
    const runtime = this.runtime;
    if (
      runtime?.project_id === command.payload.project_id &&
      runtime.session_id === command.payload.session_id
    ) {
      runtime.abort();
      return;
    }
    await this.mutationTail;
    if (
      this.validateActiveSession(
        command.payload.project_id,
        command.payload.session_id,
        command.request_id,
      )
    ) {
      this.requireRuntime().abort();
    }
  }

  private resolveSummaryReview(
    command: Extract<
      ViewerCommand,
      { type: "summary_review_resolve" }
    >,
  ): void {
    const runtime = this.runtime;
    if (
      runtime?.project_id !== command.payload.project_id ||
      runtime.session_id !== command.payload.session_id
    ) {
      this.emitError(
        "summary_review_not_found",
        "The summary review is no longer active.",
        command.request_id,
        command.payload.project_id,
        command.payload.session_id,
      );
      return;
    }
    try {
      runtime.resolveSummaryReview(
        command.payload.interaction_id,
        command.payload.resolution,
      );
      this.emit(
        "summary_review_resolved",
        {
          project_id: command.payload.project_id,
          session_id: command.payload.session_id,
          interaction_id: command.payload.interaction_id,
          decision: command.payload.resolution.decision,
        },
        command.request_id,
      );
    } catch (error) {
      this.emitError(
        "summary_review_not_found",
        error instanceof Error
          ? error.message
          : "The summary review could not be resolved.",
        command.request_id,
        command.payload.project_id,
        command.payload.session_id,
      );
    }
  }

  private touchSummaryReview(
    command: Extract<
      ViewerCommand,
      { type: "summary_review_touch" }
    >,
  ): void {
    const runtime = this.runtime;
    if (
      runtime?.project_id !== command.payload.project_id ||
      runtime.session_id !== command.payload.session_id
    ) {
      return;
    }
    runtime.touchSummaryReview(command.payload.interaction_id);
  }

  private setSummaryReviewVisibility(
    command: Extract<
      ViewerCommand,
      { type: "summary_review_visibility" }
    >,
  ): void {
    const runtime = this.runtime;
    if (
      runtime?.project_id !== command.payload.project_id ||
      runtime.session_id !== command.payload.session_id
    ) {
      return;
    }
    runtime.setSummaryReviewVisibility(
      command.payload.interaction_id,
      command.payload.is_visible,
    );
  }

  private async createProject(name: string, requestId: string): Promise<void> {
    const normalizedName = this.validateName(name, "project", requestId);
    if (!normalizedName) return;
    if (!this.ensureManagementIdle(requestId)) return;
    await this.createProjectWorkspace(normalizedName, requestId);
  }

  private async importProject(
    name: string,
    files: WorkspaceTransferFile[],
    requestId: string,
  ): Promise<void> {
    const normalizedName = this.validateName(name, "project", requestId);
    if (!normalizedName) return;
    if (!this.ensureManagementIdle(requestId)) return;

    let initialFiles: VfsSeedFile[];
    try {
      initialFiles = normalizePortableWorkspaceSnapshot(
        { files },
        this.workspaceTransferOptions,
      ).files;
    } catch (error) {
      this.emitError(
        "invalid_workspace_import",
        toErrorMessage(error, "The imported workspace is invalid."),
        requestId,
      );
      return;
    }

    await this.createProjectWorkspace(
      normalizedName,
      requestId,
      initialFiles,
    );
  }

  private async createProjectWorkspace(
    normalizedName: string,
    requestId: string,
    initialFiles?: readonly VfsSeedFile[],
  ): Promise<void> {
    await this.stopActiveRun();

    const project = createProjectRecord(
      normalizedName,
      this.defaultModelSelection,
    );

    const createdWorkspace = await this.workspaceBackend.create(
      project.project_id,
      initialFiles === undefined
        ? undefined
        : { initial_files: initialFiles },
    );
    let initialWorkspaceState: {
      files: FileEntry[];
      workspace_revision: number;
    };
    try {
      const initialListing = await createdWorkspace.list("/");
      initialWorkspaceState = {
        files: mapEntries(initialListing.entries),
        workspace_revision: initialListing.workspace_revision,
      };
      await this.commitMutation(
        (draft) => {
          draft.projects.push(project);
          draft.active_project_id = project.project_id;
          draft.active_session_id = null;
          return draft;
        },
        {
          project_id: project.project_id,
          session_id: null,
        },
      );
    } catch (error) {
      await this.rollbackWorkspaceCreation(project.project_id);
      throw error;
    }
    this.workspaces.set(
      project.project_id,
      new WorkspaceController(createdWorkspace),
    );
    await this.activateSelection();
    await this.emitStateSnapshot(requestId, initialWorkspaceState);
  }

  private async rollbackWorkspaceCreation(
    projectId: string,
  ): Promise<ProjectStoreState | null> {
    try {
      const persisted = await this.projectStore.load();
      if (
        persisted?.projects.some(
          (project) => project.project_id === projectId,
        )
      ) {
        return persisted;
      }
      await this.workspaceBackend.delete(projectId).catch(() => undefined);
      return persisted;
    } catch {
      // A failed read can mean a durable native commit is still replaying.
      // Preserve the workspace so startup recovery can decide from canonical
      // project state instead of deleting data from an indeterminate commit.
      return null;
    }
  }

  private async updateProject(
    projectId: string,
    name: string,
    requestId: string,
  ): Promise<void> {
    const project = this.getProject(projectId, requestId);
    const normalizedName = this.validateName(name, "project", requestId);
    if (!project || !normalizedName) return;
    if (!this.ensureManagementIdle(requestId)) return;
    await this.stopActiveRun();
    const now = new Date().toISOString();
    await this.commitMutation((draft) => {
      const draftProject = findProject(draft, projectId);
      draftProject.name = normalizedName;
      draftProject.updated_at = now;
      return draft;
    });
    await this.emitStateSnapshot(requestId);
  }

  private async deleteProject(
    projectId: string,
    requestId: string,
  ): Promise<void> {
    if (!this.getProject(projectId, requestId)) return;
    if (!this.ensureManagementIdle(requestId)) return;
    await this.stopActiveRun();
    const activeChanged =
      this.requireState().active_project_id === projectId;

    let replacementProject: ProjectRecord | null = null;
    let replacementProjectId: string | null = null;
    if (this.requireState().projects.length === 1) {
      replacementProject = createProjectRecord(
        "Local workspace",
        this.defaultModelSelection,
      );
      replacementProjectId = replacementProject.project_id;
      await this.workspaceBackend.create(replacementProject.project_id);
    }

    try {
      await this.commitMutation((draft) => {
        const sessionIds = new Set(
          draft.sessions
            .filter((session) => session.project_id === projectId)
            .map((session) => session.session_id),
        );
        draft.projects = draft.projects.filter(
          (project) => project.project_id !== projectId,
        );
        draft.sessions = draft.sessions.filter(
          (session) => session.project_id !== projectId,
        );
        draft.documents = draft.documents.filter(
          (document) => !sessionIds.has(document.session_id),
        );
        if (draft.projects.length === 0) {
          if (!replacementProject) {
            throw new Error(
              "Deleting the final project requires a replacement.",
            );
          }
          draft.projects.push(replacementProject);
        }
        return draft;
      });
    } catch (error) {
      if (replacementProjectId) {
        await this.rollbackWorkspaceCreation(replacementProjectId);
      }
      throw error;
    }
    if (
      replacementProjectId !== null &&
      !this.requireState().projects.some(
        (project) => project.project_id === replacementProjectId,
      )
    ) {
      await this.workspaceBackend
        .delete(replacementProjectId)
        .catch(() => undefined);
    }
    if (activeChanged) await this.activateSelection();
    await this.emitStateSnapshot(requestId);
    try {
      await this.workspaceBackend.delete(projectId);
      this.workspaces.delete(projectId);
    } catch (error) {
      this.emitError(
        "workspace_cleanup_failed",
        toErrorMessage(error, "The deleted project workspace could not be cleaned up."),
        requestId,
      );
      return;
    }
    try {
      await this.refreshWorkspaceChangeQuarantine();
    } catch (error) {
      this.emitError(
        "workspace_recovery_refresh_failed",
        toErrorMessage(
          error,
          "Workspace receipt recovery status could not be refreshed.",
        ),
        requestId,
      );
    }
  }

  private async selectProject(
    projectId: string,
    requestId: string,
  ): Promise<void> {
    const project = this.getProject(projectId, requestId);
    if (!project) return;
    if (this.requireState().active_project_id === projectId) {
      await this.emitStateSnapshot(requestId);
      return;
    }
    if (!this.ensureManagementIdle(requestId)) return;
    await this.stopActiveRun();
    this.setLocalSelection(
      projectId,
      this.selectedSessionByProject.get(projectId) ??
        project.last_session_id,
    );
    await this.activateSelection();
    await this.emitStateSnapshot(requestId);
  }

  private async selectNewChat(
    projectId: string,
    requestId: string,
  ): Promise<void> {
    if (!this.getProject(projectId, requestId)) return;
    const state = this.requireState();
    if (
      state.active_project_id === projectId &&
      state.active_session_id === null
    ) {
      await this.emitStateSnapshot(requestId);
      return;
    }
    if (!this.ensureManagementIdle(requestId)) return;
    await this.stopActiveRun();

    this.setLocalSelection(projectId, null);
    await this.activateSelection();
    await this.emitStateSnapshot(requestId);
  }

  private async selectModel(
    payload: Extract<ViewerCommand, { type: "model_select" }>["payload"],
    requestId: string,
  ): Promise<void> {
    if (
      !this.validateActiveSelection(
        payload.project_id,
        payload.session_id,
        requestId,
      )
    ) {
      return;
    }
    if (!this.ensureManagementIdle(requestId)) return;

    const selection: ModelSelection = {
      provider_id: payload.provider_id,
      model_id: payload.model_id,
    };
    if (!this.isModelReady(selection)) {
      this.emitError(
        "model_unavailable",
        "That model is not currently available.",
        requestId,
        payload.project_id,
        payload.session_id ?? undefined,
      );
      return;
    }
    const activeSelection = this.getActiveModelSelection();
    if (
      activeSelection.provider_id === selection.provider_id &&
      activeSelection.model_id === selection.model_id
    ) {
      await this.emitStateSnapshot(requestId);
      return;
    }

    const now = new Date().toISOString();
    await this.commitMutation((draft) => {
      const project = findProject(draft, payload.project_id);
      if (payload.session_id === null) {
        project.new_chat_model = selection;
        if (
          !this.modelSupportsReasoningEffort(
            selection,
            project.new_chat_reasoning_effort,
          )
        ) {
          project.new_chat_reasoning_effort = "default";
        }
      } else {
        const session = findSession(draft, payload.session_id);
        session.selected_model = selection;
        if (
          !this.modelSupportsReasoningEffort(
            selection,
            session.reasoning_effort,
          )
        ) {
          session.reasoning_effort = "default";
        }
        session.updated_at = now;
      }
      project.updated_at = now;
      return draft;
    });
    await this.activateSelection();
    await this.emitStateSnapshot(requestId);
  }

  private async selectReasoningEffort(
    payload: Extract<
      ViewerCommand,
      { type: "reasoning_effort_select" }
    >["payload"],
    requestId: string,
  ): Promise<void> {
    if (
      !this.validateActiveSelection(
        payload.project_id,
        payload.session_id,
        requestId,
      )
    ) {
      return;
    }
    if (!this.ensureManagementIdle(requestId)) return;

    const activeModel = this.getActiveModelSelection();
    if (
      !this.modelSupportsReasoningEffort(
        activeModel,
        payload.reasoning_effort,
      )
    ) {
      this.emitError(
        "reasoning_effort_unavailable",
        "That reasoning effort is not available for the selected model.",
        requestId,
        payload.project_id,
        payload.session_id ?? undefined,
      );
      return;
    }
    if (this.getActiveReasoningEffort() === payload.reasoning_effort) {
      await this.emitStateSnapshot(requestId);
      return;
    }

    const now = new Date().toISOString();
    await this.commitMutation((draft) => {
      const project = findProject(draft, payload.project_id);
      if (payload.session_id === null) {
        project.new_chat_reasoning_effort = payload.reasoning_effort;
      } else {
        const session = findSession(draft, payload.session_id);
        session.reasoning_effort = payload.reasoning_effort;
        session.updated_at = now;
      }
      project.updated_at = now;
      return draft;
    });
    await this.activateSelection();
    await this.emitStateSnapshot(requestId);
  }

  private async updateInputDraft(
    projectId: string,
    sessionId: string | null,
    inputDraft: string,
    requestId: string,
  ): Promise<void> {
    const state = this.requireState();
    const isActiveScope =
      state.active_project_id === projectId &&
      state.active_session_id === sessionId;
    const isPromotedNewChatCleanup =
      state.active_project_id === projectId &&
      state.active_session_id !== null &&
      sessionId === null &&
      inputDraft === "";
    if (!isActiveScope && !isPromotedNewChatCleanup) {
      // A virtual prompt can promote the composer before its latest UI change
      // reaches the worker. The viewer re-sends that text in the new session
      // scope; persisting the stale command would repopulate the virtual draft.
      return;
    }
    const project = this.getProject(projectId, requestId);
    if (!project) return;
    if (sessionId !== null && !this.getSession(projectId, sessionId, requestId)) {
      return;
    }

    const requestedSelection = {
      project_id: state.active_project_id,
      session_id: state.active_session_id,
    };
    try {
      const commit = await this.projectStore.saveInputDraft({
        project_id: projectId,
        session_id: sessionId,
        input_draft: inputDraft,
      });
      this.installCommittedState(commit.state, requestedSelection);
    } catch (error) {
      this.emitError(
        "persistence_failed",
        toErrorMessage(error, "The input draft could not be saved."),
        requestId,
        projectId,
        sessionId ?? undefined,
      );
      return;
    }

    this.emit(
      "input_draft_saved",
      {
        project_id: projectId,
        session_id: sessionId,
        input_draft: inputDraft,
      },
      requestId,
    );
  }

  private async updateSession(
    projectId: string,
    sessionId: string,
    title: string,
    requestId: string,
  ): Promise<void> {
    if (!this.getSession(projectId, sessionId, requestId)) return;
    const normalizedTitle = this.validateName(title, "session", requestId);
    if (!normalizedTitle) return;
    if (!this.ensureManagementIdle(requestId)) return;
    await this.stopActiveRun();
    const now = new Date().toISOString();
    await this.commitMutation((draft) => {
      const session = findSession(draft, sessionId);
      session.title = normalizedTitle;
      session.title_is_custom = true;
      session.updated_at = now;
      findProject(draft, projectId).updated_at = session.updated_at;
      return draft;
    });
    await this.emitStateSnapshot(requestId);
  }

  private async deleteSession(
    projectId: string,
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    if (!this.getSession(projectId, sessionId, requestId)) return;
    if (!this.ensureManagementIdle(requestId)) return;
    await this.stopActiveRun();
    const state = this.requireState();
    const activeChanged = state.active_session_id === sessionId;
    const now = new Date().toISOString();
    await this.commitMutation((draft) => {
      draft.sessions = draft.sessions.filter(
        (session) => session.session_id !== sessionId,
      );
      draft.documents = draft.documents.filter(
        (document) => document.session_id !== sessionId,
      );
      const projectSessions = draft.sessions.filter(
        (session) => session.project_id === projectId,
      );
      const replacement =
        projectSessions.length === 0 ? null : newestSession(projectSessions);
      const project = findProject(draft, projectId);
      if (project.last_session_id === sessionId) {
        project.last_session_id = replacement?.session_id ?? null;
      }
      project.updated_at = now;
      return draft;
    });
    if (activeChanged) await this.activateSelection();
    await this.emitStateSnapshot(requestId);
  }

  private async selectSession(
    projectId: string,
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    if (!this.getSession(projectId, sessionId, requestId)) return;
    const state = this.requireState();
    if (
      state.active_project_id === projectId &&
      state.active_session_id === sessionId
    ) {
      await this.emitStateSnapshot(requestId);
      return;
    }
    if (!this.ensureManagementIdle(requestId)) return;
    await this.stopActiveRun();
    this.setLocalSelection(projectId, sessionId);
    await this.activateSelection();
    await this.emitStateSnapshot(requestId);
  }

  private startProviderRefreshes(): void {
    if (this.providerRefreshObserverStarted) return;
    this.providerRefreshObserverStarted = true;
    const initialCatalogRevision =
      this.providerCatalog.snapshot().catalog_revision;
    void this.providerCatalog
      .startRefreshes()
      .then(() => {
        if (
          this.providerCatalog.snapshot().catalog_revision ===
          initialCatalogRevision
        ) {
          return undefined;
        }
        return this.emitStateSnapshot();
      })
      .catch((error: unknown) => {
        this.emitError(
          "provider_refresh_failed",
          toErrorMessage(error, "The provider refresh failed."),
        );
      });
  }

  private async refreshProvider(
    providerId: string,
    requestId?: string,
  ): Promise<void> {
    if (!this.providerCatalog.hasProvider(providerId)) {
      this.emitError(
        "provider_not_found",
        "The requested model provider is not configured.",
        requestId,
      );
      return;
    }
    if (!this.providerCatalog.isDiscoverable(providerId)) {
      if (requestId) await this.emitStateSnapshot(requestId);
      return;
    }
    const refresh = this.providerCatalog.refreshProvider(providerId, {
      force: requestId !== undefined,
    });
    try {
      await this.emitStateSnapshot(requestId);
    } catch {
      // A final authoritative snapshot is attempted after discovery settles.
    }
    await refresh;
    await this.emitStateSnapshot(requestId);
  }

  private ensurePersistedModelsRegistered(): void {
    const selections: ModelSelection[] = [];
    for (const project of this.requireState().projects) {
      selections.push(project.new_chat_model);
    }
    for (const session of this.requireState().sessions) {
      selections.push(session.selected_model);
    }
    this.providerCatalog.setPersistedSelections(selections);
  }

  private getActiveModelSelection(): ModelSelection {
    const state = this.requireState();
    return state.active_session_id === null
      ? this.requireProject(state.active_project_id).new_chat_model
      : this.requireSession(state.active_session_id).selected_model;
  }

  private getActiveReasoningEffort(): ReasoningEffort {
    const state = this.requireState();
    return state.active_session_id === null
      ? this.requireProject(state.active_project_id)
          .new_chat_reasoning_effort
      : this.requireSession(state.active_session_id).reasoning_effort;
  }

  private modelSupportsReasoningEffort(
    selection: ModelSelection,
    effort: ReasoningEffort,
  ): boolean {
    if (effort === "default") return true;
    return this.providerCatalog
      .getModel(selection)
      ?.reasoning_efforts.includes(effort) === true;
  }

  private isModelReady(selection: ModelSelection): boolean {
    return this.providerCatalog.isModelReady(selection);
  }

  private requireActiveModel(): Model<string> {
    const selection = this.getActiveModelSelection();
    const model = this.providerCatalog.getModel(selection);
    if (!model) throw new Error("The selected model is not registered.");
    return model;
  }

  private async stopActiveRun(): Promise<void> {
    await this.runtime?.stopAndWait();
  }

  private async activateSelection(): Promise<void> {
    const state = this.requireState();
    const projectId = state.active_project_id;
    const workspace = await this.getWorkspaceController(projectId);
    const sessionId = state.active_session_id;
    const nextRuntime =
      sessionId === null
        ? null
        : new SessionRuntime({
            project_id: projectId,
            session_id: sessionId,
            document: this.requireDocument(sessionId),
            workspace,
            model_transport: this.modelTransport,
            model: this.requireActiveModel(),
            reasoning_effort: this.getActiveReasoningEffort(),
            resolve_model: (selection) =>
              this.providerCatalog.isModelReady(selection)
                ? this.providerCatalog.getModel(selection)
                : undefined,
            system_prompt: this.systemPrompt,
            plugins: this.plugins,
            event_sink: this.eventSink,
            checkpoint: (phase, requestId) =>
              this.enqueueMutation(async () => {
                await this.checkpointActiveSession(
                  projectId,
                  sessionId,
                  phase,
                );
                if (phase === "finished") {
                  await this.emitStateSnapshot(requestId);
                }
              }),
          });
    this.runtime?.dispose();
    this.workspace = workspace;
    this.runtime = nextRuntime;
  }

  private async getWorkspaceController(
    projectId: string,
  ): Promise<WorkspaceController> {
    let workspace = this.workspaces.get(projectId);
    if (workspace) return workspace;
    workspace = new WorkspaceController(
      await this.workspaceBackend.open(projectId),
    );
    this.workspaces.set(projectId, workspace);
    return workspace;
  }

  private async checkpointActiveSession(
    projectId: string,
    sessionId: string,
    phase: "staged" | "tool_started" | "tool_finished" | "finished",
  ): Promise<void> {
    const state = this.requireState();
    if (
      state.active_project_id !== projectId ||
      state.active_session_id !== sessionId
    ) {
      throw new Error("The running session is no longer active.");
    }

    const runtimeDocument = structuredClone(
      findDocument(state, sessionId),
    );
    const requestedSelection = {
      project_id: state.active_project_id,
      session_id: state.active_session_id,
    };
    const submittedDraft = this.submittedDraft;
    const now = new Date().toISOString();
    const commit = await this.projectStore.mutate((draft) => {
      const session = findSession(draft, sessionId);
      const document = findDocument(draft, sessionId);
      document.timeline = structuredClone(runtimeDocument.timeline);
      if (
        phase === "staged" &&
        submittedDraft?.project_id === projectId &&
        submittedDraft.session_id === sessionId &&
        document.input_draft === submittedDraft.input_draft
      ) {
        document.input_draft = runtimeDocument.input_draft;
      }
      if (
        phase === "staged" &&
        !session.title_is_custom &&
        document.timeline.filter((entry) => entry.type === "user_message")
          .length === 1
      ) {
        const firstUserMessage = document.timeline.find(
          (entry) => entry.type === "user_message",
        );
        if (firstUserMessage) {
          session.title = deriveSessionTitle(firstUserMessage.content);
        }
      }
      session.updated_at = now;
      findProject(draft, projectId).updated_at = now;
      normalizePersistedSelection(draft);
      return draft;
    });
    this.installCommittedState(commit.state, requestedSelection);
  }

  private async commitMutation(
    mutation: (
      draft: ProjectStoreState,
    ) => ProjectStoreState | null,
    selection?: {
      project_id: string;
      session_id: string | null;
    },
  ): Promise<boolean> {
    const current = this.requireState();
    const requestedSelection = selection ?? {
      project_id: current.active_project_id,
      session_id: current.active_session_id,
    };
    const commit = await this.projectStore.mutate((draft) => {
      const result = mutation(draft);
      if (result === null) return null;
      normalizePersistedSelection(result);
      return result;
    });
    this.installCommittedState(commit.state, requestedSelection);
    return commit.changed;
  }

  private installCommittedState(
    committed: ProjectStoreState,
    requestedSelection: {
      project_id: string;
      session_id: string | null;
    },
  ): void {
    const runtime = this.runtime;
    const runningDocument =
      runtime?.is_running && this.state
        ? findDocument(this.state, runtime.session_id)
        : null;
    if (
      runtime &&
      runningDocument &&
      isOwnedSession(committed, runtime.project_id, runtime.session_id)
    ) {
      const committedDocument = findDocument(
        committed,
        runtime.session_id,
      );
      runningDocument.input_draft = committedDocument.input_draft;
      const documentIndex = committed.documents.findIndex(
        (document) => document.session_id === runtime.session_id,
      );
      committed.documents[documentIndex] = runningDocument;
    }

    const projectIds = new Set(
      committed.projects.map((project) => project.project_id),
    );
    for (const projectId of this.workspaces.keys()) {
      if (!projectIds.has(projectId)) this.workspaces.delete(projectId);
    }
    for (const projectId of this.selectedSessionByProject.keys()) {
      if (!projectIds.has(projectId)) {
        this.selectedSessionByProject.delete(projectId);
      }
    }
    for (const project of committed.projects) {
      const remembered = this.selectedSessionByProject.get(
        project.project_id,
      );
      if (
        remembered === undefined ||
        (remembered !== null &&
          !isOwnedSession(committed, project.project_id, remembered))
      ) {
        this.selectedSessionByProject.set(
          project.project_id,
          project.last_session_id,
        );
      }
    }

    this.state = committed;
    const project = committed.projects.find(
      (candidate) => candidate.project_id === requestedSelection.project_id,
    ) ?? newestProject(committed.projects);
    const requestedSessionId = requestedSelection.session_id;
    const sessionId =
      requestedSessionId === null ||
      isOwnedSession(committed, project.project_id, requestedSessionId)
        ? requestedSessionId
        : this.selectedSessionByProject.get(project.project_id) ??
          project.last_session_id;
    this.setLocalSelection(
      project.project_id,
      sessionId !== null &&
        isOwnedSession(committed, project.project_id, sessionId)
        ? sessionId
        : null,
    );
    this.ensurePersistedModelsRegistered();

    if (
      runtime &&
      !runtime.is_running &&
      isOwnedSession(committed, runtime.project_id, runtime.session_id)
    ) {
      runtime.bindDocument(this.requireDocument(runtime.session_id));
    }
  }

  private async emitStateSnapshot(
    requestId?: string,
    cachedWorkspaceState?: {
      files: FileEntry[];
      workspace_revision: number;
    },
  ): Promise<void> {
    this.emit(
      "state_snapshot",
      { state: await this.createCoreState(cachedWorkspaceState) },
      requestId,
    );
  }

  private async createCoreState(cachedWorkspaceState?: {
    files: FileEntry[];
    workspace_revision: number;
  }): Promise<CoreStateSnapshot> {
    let files: FileEntry[];
    let workspaceRevision: number;
    if (cachedWorkspaceState) {
      files = cachedWorkspaceState.files.map((entry) => ({ ...entry }));
      workspaceRevision = cachedWorkspaceState.workspace_revision;
    } else {
      while (true) {
        const projectId = this.requireState().active_project_id;
        const workspace = this.requireWorkspace();
        const listing = await workspace.list("/");
        files = mapEntries(listing.entries);
        workspaceRevision = listing.workspace_revision;
        if (
          this.requireWorkspace() === workspace &&
          this.requireState().active_project_id === projectId
        ) {
          break;
        }
      }
    }

    const state = this.requireState();
    const document =
      state.active_session_id === null
        ? null
        : this.requireDocument(state.active_session_id);
    const activeProject = this.requireProject(state.active_project_id);
    const activeModel = this.getActiveModelSelection();
    const catalog = this.providerCatalog.snapshot();
    return {
      state_revision: state.state_revision,
      catalog_revision: catalog.catalog_revision,
      workspace_revision: workspaceRevision,
      projects: [...state.projects]
        .sort(compareUpdatedDescending)
        .map(
          ({
            project_id,
            name,
            created_at,
            updated_at,
            new_chat_draft,
          }) => ({
            project_id,
            name,
            created_at,
            updated_at,
            has_new_chat_draft: new_chat_draft.length > 0,
          }),
        ),
      sessions: [...state.sessions]
        .sort(compareUpdatedDescending)
        .map(({ session_id, project_id, title, created_at, updated_at }) => ({
          session_id,
          project_id,
          title,
          created_at,
          updated_at,
          message_count: this.requireDocument(session_id).timeline.filter(
            (entry) => entry.type === "user_message",
          ).length,
        })),
      providers: catalog.providers,
      active_model: { ...activeModel },
      active_reasoning_effort: this.getActiveReasoningEffort(),
      active_project_id: state.active_project_id,
      active_session_id: state.active_session_id,
      input_draft:
        document === null
          ? activeProject.new_chat_draft
          : document.input_draft,
      timeline: structuredClone(document?.timeline ?? []),
      files,
      is_running: this.runtime?.is_running ?? false,
    };
  }

  private async listFiles(
    command: Extract<ViewerCommand, { type: "fs_list" }>,
  ): Promise<void> {
    if (!this.validateActiveProject(command.payload.project_id, command.request_id)) {
      return;
    }
    try {
      const listing = await this.requireWorkspace().list(command.payload.path);
      this.emit(
        "files_snapshot",
        {
          project_id: command.payload.project_id,
          path: command.payload.path,
          workspace_revision: listing.workspace_revision,
          files: mapEntries(listing.entries),
        },
        command.request_id,
      );
    } catch (error) {
      this.emitFileError("fs_list_failed", error, command.request_id);
    }
  }

  private async exportWorkspace(
    command: Extract<ViewerCommand, { type: "workspace_export" }>,
    captureController: AbortController,
  ): Promise<void> {
    if (captureController.signal.aborted) {
      this.emitWorkspaceExportCanceled(command);
      return;
    }
    const projectId = command.payload.project_id;
    const project = this.getProject(projectId, command.request_id);
    if (!project) return;
    if (!this.ensureWorkspaceTransferIdle(command.request_id)) return;

    try {
      const workspace = await this.getWorkspaceController(projectId);
      const captured = await capturePortableWorkspace(
        workspace,
        this.workspaceTransferOptions,
        captureController.signal,
      );
      this.emit(
        "workspace_export_snapshot",
        {
          project_id: projectId,
          project_name: project.name,
          workspace_revision: captured.workspace_revision,
          files: captured.snapshot.files.map(({ path, content }) => ({
            path,
            content,
          })),
        },
        command.request_id,
      );
    } catch (error) {
      if (captureController.signal.aborted) {
        this.emitWorkspaceExportCanceled(command);
        return;
      }
      this.emitError(
        "workspace_export_failed",
        toErrorMessage(error, "The workspace could not be exported."),
        command.request_id,
        projectId,
      );
    }
  }

  private async readWorkspaceChange(
    command: Extract<ViewerCommand, { type: "workspace_change_read" }>,
  ): Promise<void> {
    const { project_id: projectId, change_id: changeId } = command.payload;
    if (!this.getProject(projectId, command.request_id)) return;

    try {
      const workspace = await this.getWorkspaceController(projectId);
      const inspection = await inspectWorkspaceChange(workspace, changeId);
      this.emit(
        "workspace_change_snapshot",
        {
          project_id: projectId,
          workspace_revision: inspection.workspace_revision,
          change: workspaceChangeDetails(
            inspection.change,
            inspection.current_content,
            inspection.revert_status,
          ),
        },
        command.request_id,
      );
    } catch (error) {
      this.emitWorkspaceChangeError(
        "read",
        error,
        command.request_id,
        projectId,
      );
    }
  }

  private async revertWorkspaceChange(
    command: Extract<ViewerCommand, { type: "workspace_change_revert" }>,
  ): Promise<void> {
    const { project_id: projectId, change_id: changeId } = command.payload;
    if (!this.getProject(projectId, command.request_id)) return;
    if (
      !this.ensureWorkspaceChangeRevertIdle(
        command.request_id,
        projectId,
      )
    ) {
      return;
    }

    try {
      const workspace = await this.getWorkspaceController(projectId);
      const preflight = await workspace.getChange(changeId);
      const preflightChange = preflight.change;
      if (preflightChange === null) {
        throw new WorkspaceChangeNotFoundError(changeId);
      }
      assertValidWorkspaceChangeRecord(
        preflightChange,
        preflight.workspace_revision,
      );
      if (preflightChange.change_id !== changeId) {
        throw invalidWorkspaceChangeRevertResult(
          "preflight receipt does not match the requested change",
        );
      }
      const result = await workspace.revertChange(changeId);
      assertValidWorkspaceChangeRevertResult(
        result,
        {
          workspace_revision: preflight.workspace_revision,
          change: preflightChange,
        },
        changeId,
      );
      if (result.revert_outcome === "applied") {
        // Workspace bytes and project state commit independently. Advancing the
        // project-store revision makes other cores reload the workspace snapshot.
        await this.commitMutation((draft) => {
          findProject(draft, projectId);
          return draft;
        });
      }
      this.emitWorkspaceChangeReverted(command, result);
    } catch (error) {
      this.emitWorkspaceChangeError(
        "revert",
        error,
        command.request_id,
        projectId,
      );
    }
  }

  private emitWorkspaceChangeReverted(
    command: Extract<ViewerCommand, { type: "workspace_change_revert" }>,
    result: WorkspaceChangeRevertResult,
  ): void {
    const { change } = result;
    this.emit(
      "workspace_change_reverted",
      {
        project_id: command.payload.project_id,
        change_id: change.change_id,
        path: change.path,
        change_kind: change.change_kind,
        tool_name: change.tool_name,
        workspace_revision: result.workspace_revision,
        reverted_at_workspace_revision:
          result.reverted_at_workspace_revision,
        revert_outcome: result.revert_outcome,
      },
      command.request_id,
    );
  }

  private emitWorkspaceChangeError(
    operation: "read" | "revert",
    error: unknown,
    requestId: string,
    projectId: string,
  ): void {
    if (
      error instanceof WorkspaceChangeNotFoundError ||
      (operation === "revert" &&
        error instanceof VfsError &&
        error.code === "not_found")
    ) {
      this.emitError(
        "workspace_change_not_found",
        error.message,
        requestId,
        projectId,
      );
      return;
    }
    if (
      error instanceof WorkspaceChangeConflictError ||
      (operation === "revert" &&
        error instanceof VfsError &&
        error.code === "conflict")
    ) {
      this.emitError(
        "workspace_change_conflict",
        error.message,
        requestId,
        projectId,
      );
      return;
    }
    this.emitError(
      operation === "read"
        ? "workspace_change_read_failed"
        : "workspace_change_revert_failed",
      toErrorMessage(
        error,
        operation === "read"
          ? "The workspace change could not be read."
          : "The workspace change could not be reverted.",
      ),
      requestId,
      projectId,
    );
  }

  private emitWorkspaceExportCanceled(
    command: Extract<ViewerCommand, { type: "workspace_export" }>,
  ): void {
    this.emitError(
      "workspace_export_cancelled",
      "The workspace export was canceled.",
      command.request_id,
      command.payload.project_id,
    );
  }

  private cancelWorkspaceExport(
    command: Extract<ViewerCommand, { type: "workspace_export_cancel" }>,
  ): void {
    this.workspaceExportControllers
      .get(command.payload.target_request_id)
      ?.abort(
        new DOMException("The workspace export was canceled.", "AbortError"),
      );
  }

  private async readFile(
    command: Extract<ViewerCommand, { type: "fs_read" }>,
  ): Promise<void> {
    if (!this.validateActiveProject(command.payload.project_id, command.request_id)) {
      return;
    }
    try {
      const file = await this.requireWorkspace().read(command.payload.path);
      this.emit(
        "file_content",
        {
          project_id: command.payload.project_id,
          path: command.payload.path,
          workspace_revision: file.workspace_revision,
          content: file.content,
        },
        command.request_id,
      );
    } catch (error) {
      this.emitFileError("fs_read_failed", error, command.request_id);
    }
  }

  private emitFileError(
    code: "fs_list_failed" | "fs_read_failed",
    error: unknown,
    requestId: string,
  ): void {
    const state = this.requireState();
    this.emitError(
      code,
      toErrorMessage(error, "Filesystem operation failed."),
      requestId,
      state.active_project_id,
      state.active_session_id ?? undefined,
    );
  }

  private validateActiveProject(projectId: string, requestId: string): boolean {
    if (projectId === this.requireState().active_project_id) return true;
    this.emitError(
      "project_not_active",
      "The requested project is not active.",
      requestId,
      projectId,
    );
    return false;
  }

  private validateActiveSession(
    projectId: string,
    sessionId: string,
    requestId: string,
  ): boolean {
    const state = this.requireState();
    const session = state.sessions.find(
      (candidate) => candidate.session_id === sessionId,
    );
    if (!session) {
      this.emitError(
        "session_not_found",
        "The requested session does not exist.",
        requestId,
        projectId,
        sessionId,
      );
      return false;
    }
    if (session.project_id !== projectId) {
      this.emitError(
        "session_project_mismatch",
        "The requested session does not belong to that project.",
        requestId,
        projectId,
        sessionId,
      );
      return false;
    }
    if (
      state.active_project_id !== projectId ||
      state.active_session_id !== sessionId
    ) {
      this.emitError(
        "session_not_active",
        "The requested session is not active.",
        requestId,
        projectId,
        sessionId,
      );
      return false;
    }
    return true;
  }

  private validateActiveSelection(
    projectId: string,
    sessionId: string | null,
    requestId: string,
  ): boolean {
    const state = this.requireState();
    if (state.active_project_id !== projectId) {
      this.emitError(
        "project_not_active",
        "The requested project is not active.",
        requestId,
        projectId,
        sessionId ?? undefined,
      );
      return false;
    }
    if (state.active_session_id !== sessionId) {
      this.emitError(
        "session_not_active",
        "The requested chat is not active.",
        requestId,
        projectId,
        sessionId ?? undefined,
      );
      return false;
    }
    return sessionId === null
      ? true
      : this.validateActiveSession(projectId, sessionId, requestId);
  }

  private getProject(projectId: string, requestId: string): ProjectRecord | null {
    const project = this.requireState().projects.find(
      (candidate) => candidate.project_id === projectId,
    );
    if (project) return project;
    this.emitError(
      "project_not_found",
      "The requested project does not exist.",
      requestId,
      projectId,
    );
    return null;
  }

  private getSession(
    projectId: string,
    sessionId: string,
    requestId: string,
  ): SessionRecord | null {
    if (!this.getProject(projectId, requestId)) return null;
    const session = this.requireState().sessions.find(
      (candidate) => candidate.session_id === sessionId,
    );
    if (!session) {
      this.emitError(
        "session_not_found",
        "The requested session does not exist.",
        requestId,
        projectId,
        sessionId,
      );
      return null;
    }
    if (session.project_id !== projectId) {
      this.emitError(
        "session_project_mismatch",
        "The requested session does not belong to that project.",
        requestId,
        projectId,
        sessionId,
      );
      return null;
    }
    return session;
  }

  private validateName(
    value: string,
    entity: "project" | "session",
    requestId: string,
  ): string | null {
    const normalized = value.trim();
    const maximum = entity === "project" ? 80 : 100;
    if (!normalized || normalized.length > maximum) {
      this.emitError(
        "invalid_name",
        `${capitalize(entity)} names must contain 1 to ${maximum} characters.`,
        requestId,
      );
      return null;
    }
    return normalized;
  }

  private ensureManagementIdle(requestId: string): boolean {
    if (!this.runtime?.is_running) return true;
    const state = this.requireState();
    this.emitError(
      "run_in_progress",
      "Wait for the current response to finish before changing projects or chats.",
      requestId,
      state.active_project_id,
      state.active_session_id ?? undefined,
    );
    return false;
  }

  private ensureWorkspaceTransferIdle(requestId: string): boolean {
    if (!this.runtime?.is_running) return true;
    const state = this.requireState();
    this.emitError(
      "run_in_progress",
      "Wait for the current response to finish before exporting a workspace.",
      requestId,
      state.active_project_id,
      state.active_session_id ?? undefined,
    );
    return false;
  }

  private ensureWorkspaceChangeRevertIdle(
    requestId: string,
    projectId: string,
  ): boolean {
    if (
      !this.runtime?.is_running ||
      this.requireState().active_project_id !== projectId
    ) {
      return true;
    }
    const state = this.requireState();
    this.emitError(
      "run_in_progress",
      "Wait for the current response to finish before reverting a workspace change.",
      requestId,
      state.active_project_id,
      state.active_session_id ?? undefined,
    );
    return false;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private initializeLocalSelection(state: ProjectStoreState): void {
    this.selectedSessionByProject.clear();
    for (const project of state.projects) {
      this.selectedSessionByProject.set(
        project.project_id,
        project.last_session_id,
      );
    }
    this.setLocalSelection(
      state.active_project_id,
      state.active_session_id,
    );
  }

  private async restoreBootstrapSelection(
    selection: Extract<
      ViewerCommand,
      { type: "bootstrap" }
    >["payload"],
  ): Promise<void> {
    const projectId = selection.active_project_id;
    if (projectId === undefined) return;
    const state = this.requireState();
    const project = state.projects.find(
      (candidate) => candidate.project_id === projectId,
    );
    if (!project) return;

    const requestedSessionId =
      "active_session_id" in selection
        ? selection.active_session_id ?? null
        : this.selectedSessionByProject.get(projectId) ??
          project.last_session_id;
    const sessionId =
      requestedSessionId !== null &&
      state.sessions.some(
        (session) =>
          session.session_id === requestedSessionId &&
          session.project_id === projectId,
      )
        ? requestedSessionId
        : null;
    if (
      state.active_project_id === projectId &&
      state.active_session_id === sessionId
    ) {
      return;
    }
    this.setLocalSelection(projectId, sessionId);
    await this.activateSelection();
  }

  private setLocalSelection(
    projectId: string,
    sessionId: string | null,
  ): void {
    const state = this.requireState();
    const project = findProject(state, projectId);
    if (sessionId !== null) {
      const session = findSession(state, sessionId);
      if (session.project_id !== project.project_id) {
        throw new Error(
          `Session ${sessionId} does not belong to project ${projectId}.`,
        );
      }
    }
    state.active_project_id = projectId;
    state.active_session_id = sessionId;
    this.selectedSessionByProject.set(projectId, sessionId);
  }

  private requireState(): ProjectStoreState {
    if (!this.state) throw new Error("rrbox core is not initialized.");
    return this.state;
  }

  private requireRuntime(): SessionRuntime {
    if (!this.runtime) throw new Error("No active session runtime is available.");
    return this.runtime;
  }

  private requireWorkspace(): WorkspaceController {
    if (!this.workspace) throw new Error("No active project workspace is available.");
    return this.workspace;
  }

  private requireProject(projectId: string): ProjectRecord {
    return findProject(this.requireState(), projectId);
  }

  private requireSession(sessionId: string): SessionRecord {
    return findSession(this.requireState(), sessionId);
  }

  private requireDocument(sessionId: string): SessionDocument {
    const document = this.requireState().documents.find(
      (candidate) => candidate.session_id === sessionId,
    );
    if (!document) throw new Error(`Session document not found: ${sessionId}`);
    return document;
  }

  private emit<T extends CoreEvent["type"]>(
    type: T,
    payload: Extract<CoreEvent, { type: T }>["payload"],
    requestId?: string,
  ): void {
    this.eventSink({
      protocol_version: PROTOCOL_VERSION,
      event_id: crypto.randomUUID(),
      ...(requestId === undefined ? {} : { request_id: requestId }),
      type,
      payload,
    } as Extract<CoreEvent, { type: T }>);
  }

  private emitError(
    code: string,
    message: string,
    requestId?: string,
    projectId?: string,
    sessionId?: string,
  ): void {
    this.emit(
      "error",
      {
        code,
        message,
        ...(projectId === undefined ? {} : { project_id: projectId }),
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
      },
      requestId,
    );
  }

  private async refreshWorkspaceChangeQuarantine(): Promise<void> {
    const journals = await loadWorkspaceChangeJournals(
      this.requireState(),
      this.workspaceBackend,
    );
    this.workspaceChangeQuarantine =
      workspaceChangeQuarantineFromReconciliation(journals);
    this.emitWorkspaceChangeQuarantineStatus();
  }

  private emitWorkspaceChangeQuarantineStatus(): void {
    const quarantine = this.workspaceChangeQuarantine;
    const signature =
      quarantine === null
        ? null
        : [
            quarantine.quarantined_receipt_count,
            quarantine.pending_receipt_count,
            quarantine.affected_project_count,
          ].join(":");
    if (
      this.hasEmittedWorkspaceChangeQuarantineStatus &&
      this.emittedWorkspaceChangeQuarantineSignature === signature
    ) {
      return;
    }
    if (quarantine === null) {
      if (!this.hasEmittedWorkspaceChangeQuarantineStatus) return;
      this.hasEmittedWorkspaceChangeQuarantineStatus = true;
      this.emittedWorkspaceChangeQuarantineSignature = null;
      this.emit("workspace_recovery_cleared", {});
      return;
    }
    this.hasEmittedWorkspaceChangeQuarantineStatus = true;
    this.emittedWorkspaceChangeQuarantineSignature = signature;
    const receiptLabel =
      quarantine.quarantined_receipt_count === 1
        ? "receipt was"
        : "receipts were";
    const projectLabel =
      quarantine.affected_project_count === 1
        ? "workspace"
        : "workspaces";
    const pendingMessage =
      quarantine.pending_receipt_count === 0
        ? ""
        : ` ${quarantine.pending_receipt_count} isolation ${
            quarantine.pending_receipt_count === 1
              ? "marker"
              : "markers"
          } could not yet be saved and will be retried the next time the workspace is checked.`;
    this.emit("workspace_recovery_notice", {
      code: "workspace_change_quarantine",
      message:
        `${quarantine.quarantined_receipt_count} malformed stored workspace change ${receiptLabel} isolated across ` +
        `${quarantine.affected_project_count} ${projectLabel}. No files, projects, or chats were removed. ` +
        `Those receipts cannot be reviewed or reverted.${pendingMessage}`,
      quarantined_receipt_count:
        quarantine.quarantined_receipt_count,
      pending_receipt_count: quarantine.pending_receipt_count,
      affected_project_count: quarantine.affected_project_count,
    });
  }
}

export { ResearchBoxCore as AgentCore };

function createInitialState(
  modelSelection: ModelSelection,
): ProjectStoreState {
  const project = createProjectRecord("Local workspace", modelSelection);
  return {
    schema_version: PROJECT_STORE_SCHEMA_VERSION,
    state_revision: 0,
    active_project_id: project.project_id,
    active_session_id: null,
    projects: [project],
    sessions: [],
    documents: [],
  };
}

function createProjectRecord(
  name: string,
  modelSelection: ModelSelection,
): ProjectRecord {
  const projectId = crypto.randomUUID();
  const now = new Date().toISOString();
  return {
    project_id: projectId,
    name,
    created_at: now,
    updated_at: now,
    last_session_id: null,
    new_chat_draft: "",
    new_chat_model: { ...modelSelection },
    new_chat_reasoning_effort: "default",
  };
}

function createSessionRecord(
  projectId: string,
  title: string,
  titleIsCustom: boolean,
  modelSelection: ModelSelection,
  reasoningEffort: ReasoningEffort,
): { session: SessionRecord; document: SessionDocument } {
  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  return {
    session: {
      session_id: sessionId,
      project_id: projectId,
      title,
      title_is_custom: titleIsCustom,
      created_at: now,
      updated_at: now,
      selected_model: { ...modelSelection },
      reasoning_effort: reasoningEffort,
    },
    document: {
      format_version: SESSION_DOCUMENT_FORMAT_VERSION,
      session_id: sessionId,
      project_id: projectId,
      input_draft: "",
      timeline: [],
    },
  };
}

async function reconcileWorkspaceChanges(
  state: ProjectStoreState,
  workspaceBackend: WorkspaceBackend,
): Promise<WorkspaceChangeReconciliation> {
  const journals = await loadWorkspaceChangeJournals(
    state,
    workspaceBackend,
  );
  const changesByProject = journals.changes_by_project;

  let reconciled = false;
  for (const document of state.documents) {
    const projectChanges = changesByProject.get(document.project_id) ?? [];
    if (projectChanges.length === 0) continue;
    const consumedChangeIds = new Set<string>();
    for (const pending of collectPendingToolCalls(document)) {
      if (!isMutationToolName(pending.block.tool_name)) continue;
      const record = [...projectChanges].reverse().find(
        (candidate) =>
          !consumedChangeIds.has(candidate.change_id) &&
          candidate.session_id === document.session_id &&
          candidate.tool_call_id === pending.block.tool_call_id &&
          candidate.tool_name === pending.block.tool_name &&
          matchesWorkspaceChangeIdentity(candidate, pending),
      );
      if (!record) continue;

      consumedChangeIds.add(record.change_id);
      const change = workspaceChangeSummary(record);
      document.timeline.push(
        workspaceChangeToolResult(
          record,
          change,
          pending.block,
          pending.run_id,
        ),
      );
      reconciled = true;
    }
  }
  return {
    state_changed: reconciled,
    quarantined_receipt_count: journals.quarantined_receipt_count,
    pending_receipt_count: journals.pending_receipt_count,
    affected_project_count: journals.affected_project_count,
  };
}

type StartupStateRepairResult = {
  state: ProjectStoreState;
  workspace_change_reconciliation: WorkspaceChangeReconciliation;
};

async function repairPersistedStateOnStartup(
  initialState: ProjectStoreState,
  projectStore: ProjectStore,
  workspaceBackend: WorkspaceBackend,
): Promise<StartupStateRepairResult> {
  let state = initialState;

  for (
    let attempt = 0;
    attempt < STARTUP_REPAIR_SAVE_ATTEMPTS;
    attempt += 1
  ) {
    const workspaceChangeReconciliation =
      await reconcileWorkspaceChanges(state, workspaceBackend);
    const repairedTranscripts = repairInvalidTranscripts(state);
    const repairedRuns = repairInterruptedSessions(state);
    const stateChanged =
      workspaceChangeReconciliation.state_changed ||
      repairedTranscripts ||
      repairedRuns;

    if (!stateChanged) {
      return {
        state,
        workspace_change_reconciliation:
          workspaceChangeReconciliation,
      };
    }

    const expectedRevision = state.state_revision;
    state.state_revision = expectedRevision + 1;
    try {
      await projectStore.save(state, expectedRevision);
      return {
        state,
        workspace_change_reconciliation:
          workspaceChangeReconciliation,
      };
    } catch (error) {
      if (
        !(error instanceof ProjectStoreConflictError) ||
        attempt === STARTUP_REPAIR_SAVE_ATTEMPTS - 1
      ) {
        throw error;
      }
    }

    const reloaded = await projectStore.load();
    if (!reloaded) {
      throw new Error(
        "The project store disappeared during startup repair.",
      );
    }
    state = reloaded;
  }

  throw new Error("Startup repair exhausted its save attempts.");
}

type WorkspaceChangeJournalSnapshot = WorkspaceChangeQuarantineSummary & {
  changes_by_project: Map<string, WorkspaceChangeRecord[]>;
};

async function loadWorkspaceChangeJournals(
  state: ProjectStoreState,
  workspaceBackend: WorkspaceBackend,
): Promise<WorkspaceChangeJournalSnapshot> {
  const changesByProject = new Map<string, WorkspaceChangeRecord[]>();
  let quarantinedReceiptCount = 0;
  let pendingReceiptCount = 0;
  let affectedProjectCount = 0;
  for (const project of state.projects) {
    const workspace = await workspaceBackend.open(project.project_id);
    const journal = await workspace.listChanges();
    changesByProject.set(project.project_id, journal.changes);
    const quarantine = journal.quarantine_status;
    if (
      quarantine !== undefined &&
      quarantine.quarantined_receipt_count > 0
    ) {
      quarantinedReceiptCount +=
        quarantine.quarantined_receipt_count;
      pendingReceiptCount += quarantine.pending_receipt_count;
      affectedProjectCount += 1;
    }
  }
  return {
    changes_by_project: changesByProject,
    quarantined_receipt_count: quarantinedReceiptCount,
    pending_receipt_count: pendingReceiptCount,
    affected_project_count: affectedProjectCount,
  };
}

function workspaceChangeQuarantineFromReconciliation(
  reconciliation: WorkspaceChangeQuarantineSummary,
): WorkspaceChangeQuarantineSummary | null {
  if (reconciliation.quarantined_receipt_count === 0) return null;
  return {
    quarantined_receipt_count:
      reconciliation.quarantined_receipt_count,
    pending_receipt_count: reconciliation.pending_receipt_count,
    affected_project_count: reconciliation.affected_project_count,
  };
}

async function reconcileOrphanedWorkspaces(
  workspaceBackend: WorkspaceBackend,
  retainedProjectIds: readonly string[],
): Promise<void> {
  if (!isWorkspaceOrphanReconciler(workspaceBackend)) return;
  await workspaceBackend.reconcileOrphanedWorkspaces(retainedProjectIds);
}

function workspaceChangeSummary(
  record: WorkspaceChangeRecord,
): WorkspaceChangeSummary {
  return {
    change_id: record.change_id,
    tool_call_id: record.tool_call_id,
    tool_name: record.tool_name,
    path: record.path,
    change_kind: record.change_kind,
    additions: record.additions,
    deletions: record.deletions,
    byte_size: record.byte_size,
  };
}

function workspaceChangeDetails(
  record: WorkspaceChangeRecord,
  currentContent: string | null,
  revertStatus: WorkspaceChangeDetails["revert_status"],
): WorkspaceChangeDetails {
  return {
    ...workspaceChangeSummary(record),
    before_content: record.before_content,
    after_content: record.after_content,
    current_content: currentContent,
    reverted_at_workspace_revision:
      record.reverted_at_workspace_revision,
    revert_status: revertStatus,
  };
}

type WorkspaceChangeInspection = {
  workspace_revision: number;
  change: WorkspaceChangeRecord;
  current_content: string | null;
  revert_status: WorkspaceChangeDetails["revert_status"];
};

type WorkspacePathState = Awaited<
  ReturnType<WorkspaceController["getPathState"]>
>;

const WORKSPACE_CHANGE_INSPECTION_ATTEMPTS = 8;

async function inspectWorkspaceChange(
  workspace: WorkspaceController,
  changeId: string,
): Promise<WorkspaceChangeInspection> {
  for (
    let attempt = 0;
    attempt < WORKSPACE_CHANGE_INSPECTION_ATTEMPTS;
    attempt += 1
  ) {
    const initial = await workspace.getChange(changeId);
    if (!initial.change) throw new WorkspaceChangeNotFoundError(changeId);
    assertValidWorkspaceChangeRecord(
      initial.change,
      initial.workspace_revision,
    );
    if (initial.change.change_id !== changeId) {
      throw new Error(
        "The workspace returned a different change receipt.",
      );
    }

    const pathState = await workspace.getPathState(initial.change.path);

    const confirmed = await workspace.getChange(changeId);
    if (!confirmed.change) throw new WorkspaceChangeNotFoundError(changeId);
    assertValidWorkspaceChangeRecord(
      confirmed.change,
      confirmed.workspace_revision,
    );
    if (confirmed.change.change_id !== changeId) {
      throw new Error(
        "The workspace returned a different change receipt.",
      );
    }
    if (
      !sameWorkspaceChangeReceipt(initial.change, confirmed.change) ||
      (initial.change.reverted_at_workspace_revision !== null &&
        initial.change.reverted_at_workspace_revision !==
          confirmed.change.reverted_at_workspace_revision)
    ) {
      throw new Error("The workspace change receipt was mutated.");
    }
    if (confirmed.workspace_revision !== pathState.workspace_revision) {
      continue;
    }

    const currentContent =
      pathState.kind === "file" ? pathState.content : null;
    return {
      workspace_revision: confirmed.workspace_revision,
      change: confirmed.change,
      current_content: currentContent,
      revert_status: classifyWorkspaceChangeRevert(
        confirmed.change,
        pathState,
      ),
    };
  }

  throw new WorkspaceChangeConflictError(
    "The workspace kept changing while this change was inspected.",
  );
}

function classifyWorkspaceChangeRevert(
  change: WorkspaceChangeRecord,
  pathState: WorkspacePathState,
): WorkspaceChangeDetails["revert_status"] {
  if (change.reverted_at_workspace_revision !== null) {
    return "already_reverted";
  }
  if (change.applied_workspace_revision === null) return "conflict";
  if (change.change_kind === "deleted") {
    return pathState.kind === "missing" &&
      pathState.path_revision === change.applied_workspace_revision
      ? "available"
      : "conflict";
  }
  return pathState.kind === "file" &&
    pathState.path_revision === change.applied_workspace_revision &&
    pathState.content === change.after_content
    ? "available"
    : "conflict";
}

function sameWorkspaceChangeReceipt(
  left: WorkspaceChangeRecord,
  right: WorkspaceChangeRecord,
): boolean {
  return (
    left.change_id === right.change_id &&
    left.session_id === right.session_id &&
    left.tool_call_block_id === right.tool_call_block_id &&
    left.legacy_message_id === right.legacy_message_id &&
    left.assistant_message_index === right.assistant_message_index &&
    left.tool_call_id === right.tool_call_id &&
    left.tool_name === right.tool_name &&
    left.created_at === right.created_at &&
    left.applied_workspace_revision ===
      right.applied_workspace_revision &&
    left.path === right.path &&
    left.change_kind === right.change_kind &&
    left.before_content === right.before_content &&
    left.after_content === right.after_content &&
    left.additions === right.additions &&
    left.deletions === right.deletions &&
    left.byte_size === right.byte_size
  );
}

function assertValidWorkspaceChangeRevertResult(
  result: WorkspaceChangeRevertResult,
  preflight: {
    workspace_revision: number;
    change: WorkspaceChangeRecord;
  },
  expectedChangeId: string,
): void {
  assertValidWorkspaceChangeRecord(
    result.change,
    result.workspace_revision,
  );
  if (
    result.change.change_id !== expectedChangeId ||
    !sameWorkspaceChangeReceipt(result.change, preflight.change)
  ) {
    throw invalidWorkspaceChangeRevertResult(
      "receipt identity changed during the operation",
    );
  }
  if (
    !Number.isSafeInteger(result.reverted_at_workspace_revision) ||
    result.reverted_at_workspace_revision < 1 ||
    result.change.reverted_at_workspace_revision !==
      result.reverted_at_workspace_revision
  ) {
    throw invalidWorkspaceChangeRevertResult(
      "returned an invalid disposition revision",
    );
  }
  if (result.workspace_revision < preflight.workspace_revision) {
    throw invalidWorkspaceChangeRevertResult(
      "moved the workspace revision backwards",
    );
  }
  if (
    preflight.change.reverted_at_workspace_revision !== null &&
    preflight.change.reverted_at_workspace_revision !==
      result.reverted_at_workspace_revision
  ) {
    throw invalidWorkspaceChangeRevertResult(
      "changed an existing revert disposition",
    );
  }
  if (result.revert_outcome === "applied") {
    if (
      preflight.change.reverted_at_workspace_revision !== null ||
      result.reverted_at_workspace_revision !==
        result.workspace_revision ||
      result.workspace_revision <= preflight.workspace_revision
    ) {
      throw invalidWorkspaceChangeRevertResult(
        "returned inconsistent applied revisions",
      );
    }
    return;
  }
  if (result.revert_outcome === "already_reverted") {
    if (
      result.reverted_at_workspace_revision >
      result.workspace_revision
    ) {
      throw invalidWorkspaceChangeRevertResult(
        "returned a future disposition revision",
      );
    }
    return;
  }
  throw invalidWorkspaceChangeRevertResult(
    "returned an invalid outcome",
  );
}

function invalidWorkspaceChangeRevertResult(
  detail: string,
): WorkspaceCorruptionError {
  return new WorkspaceCorruptionError(
    `Workspace change revert ${detail}.`,
  );
}

class WorkspaceChangeNotFoundError extends Error {
  constructor(changeId: string) {
    super(`Workspace change not found: ${changeId}`);
    this.name = "WorkspaceChangeNotFoundError";
  }
}

class WorkspaceChangeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceChangeConflictError";
  }
}

function workspaceChangeActivitySummary(change: WorkspaceChangeSummary): string {
  const verb =
    change.change_kind === "created"
      ? "Created"
      : change.change_kind === "updated"
        ? "Updated"
        : "Deleted";
  return `${verb} · +${change.additions} −${change.deletions}`;
}

function workspaceChangeToolResult(
  record: WorkspaceChangeRecord,
  change: WorkspaceChangeSummary,
  block: ToolCallBlock,
  runId: string,
): ToolResultEntry {
  return {
    type: "tool_result",
    entry_id: crypto.randomUUID(),
    run_id: runId,
    created_at: record.created_at,
    tool_call_block_id: block.block_id,
    tool_call_id: record.tool_call_id,
    tool_name: record.tool_name,
    content: JSON.stringify(change),
    is_error: false,
    summary: workspaceChangeActivitySummary(change),
    file_change: change,
  };
}

function isMutationToolName(
  toolName: string,
): toolName is WorkspaceChangeRecord["tool_name"] {
  return (
    toolName === "write_file" ||
    toolName === "replace_text" ||
    toolName === "remove_file"
  );
}

function repairInterruptedSessions(state: ProjectStoreState): boolean {
  let repaired = false;
  const sessions = new Map(
    state.sessions.map((session) => [session.session_id, session]),
  );
  for (const document of state.documents) {
    for (const entry of document.timeline) {
      if (
        entry.type !== "assistant_message" ||
        entry.status !== "streaming"
      ) {
        continue;
      }
      entry.status = "aborted";
      entry.stop_reason = "aborted";
      repaired = true;
    }

    const lastEntry = document.timeline.at(-1);
    if (lastEntry?.type !== "user_message") continue;
    const session = sessions.get(document.session_id);
    if (!session) continue;
    const previousAssistant = [...document.timeline]
      .reverse()
      .find((entry) => entry.type === "assistant_message");
    document.timeline.push({
      type: "assistant_message",
      entry_id: crypto.randomUUID(),
      run_id: lastEntry.run_id,
      created_at: new Date().toISOString(),
      status: "aborted",
      api: previousAssistant?.api ?? "researchbox-recovery",
      provider:
        previousAssistant?.provider ?? session.selected_model.provider_id,
      model: previousAssistant?.model ?? session.selected_model.model_id,
      usage: emptyAssistantUsage(),
      stop_reason: "aborted",
      blocks: [],
    });
    repaired = true;
  }
  return repaired;
}

function repairInvalidTranscripts(state: ProjectStoreState): boolean {
  let repaired = false;
  for (const document of state.documents) {
    repaired = repairInvalidTranscript(document) || repaired;
  }
  return repaired;
}

function repairInvalidTranscript(document: SessionDocument): boolean {
  const pending = collectPendingToolCalls(document);
  if (pending.length === 0) return false;

  const createdAt = new Date().toISOString();
  for (const call of pending) {
    document.timeline.push({
      type: "tool_result",
      entry_id: crypto.randomUUID(),
      run_id: call.run_id,
      created_at: createdAt,
      tool_call_block_id: call.block.block_id,
      tool_call_id: call.block.tool_call_id,
      tool_name: call.block.tool_name,
      content:
        "No tool result was recovered after reload. The operation may have completed; inspect the workspace before retrying.",
      is_error: true,
      summary: "Result unavailable after reload",
    });
  }
  return true;
}

function collectPendingToolCalls(document: SessionDocument): Array<{
  run_id: string;
  assistant_entry_id: string;
  legacy_message_id: string;
  assistant_message_index: number;
  block: ToolCallBlock;
}> {
  const resultBlockIds = new Set(
    document.timeline.flatMap((entry) =>
      entry.type === "tool_result" ? [entry.tool_call_block_id] : [],
    ),
  );
  const pending: Array<{
    run_id: string;
    assistant_entry_id: string;
    legacy_message_id: string;
    assistant_message_index: number;
    block: ToolCallBlock;
  }> = [];
  const firstAssistantEntryByRun = new Map<string, string>();
  for (const [entryIndex, entry] of document.timeline.entries()) {
    if (entry.type !== "assistant_message") continue;
    const legacyMessageId =
      firstAssistantEntryByRun.get(entry.run_id) ?? entry.entry_id;
    firstAssistantEntryByRun.set(entry.run_id, legacyMessageId);
    for (const block of entry.blocks) {
      if (
        block.type === "tool_call" &&
        !resultBlockIds.has(block.block_id)
      ) {
        pending.push({
          run_id: entry.run_id,
          assistant_entry_id: entry.entry_id,
          legacy_message_id: legacyMessageId,
          assistant_message_index: entryIndex,
          block,
        });
      }
    }
  }
  return pending;
}

function matchesWorkspaceChangeIdentity(
  record: WorkspaceChangeRecord,
  pending: ReturnType<typeof collectPendingToolCalls>[number],
): boolean {
  if (record.tool_call_block_id !== null) {
    return record.tool_call_block_id === pending.block.block_id;
  }
  if (record.legacy_message_id !== undefined) {
    return (
      record.legacy_message_id === pending.legacy_message_id ||
      record.legacy_message_id === pending.assistant_entry_id
    );
  }
  return (
    record.assistant_message_index !== null &&
    record.assistant_message_index === pending.assistant_message_index
  );
}

function findDocument(
  state: ProjectStoreState,
  sessionId: string,
): SessionDocument {
  const document = state.documents.find(
    (candidate) => candidate.session_id === sessionId,
  );
  if (!document) throw new Error(`Session document not found: ${sessionId}`);
  return document;
}

function findProject(state: ProjectStoreState, projectId: string): ProjectRecord {
  const project = state.projects.find(
    (candidate) => candidate.project_id === projectId,
  );
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project;
}

function findSession(state: ProjectStoreState, sessionId: string): SessionRecord {
  const session = state.sessions.find(
    (candidate) => candidate.session_id === sessionId,
  );
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session;
}

function isOwnedSession(
  state: ProjectStoreState,
  projectId: string,
  sessionId: string,
): boolean {
  return state.sessions.some(
    (session) =>
      session.session_id === sessionId &&
      session.project_id === projectId,
  );
}

function normalizePersistedSelection(state: ProjectStoreState): void {
  const activeProject = state.projects.find(
    (project) => project.project_id === state.active_project_id,
  ) ?? newestProject(state.projects);
  state.active_project_id = activeProject.project_id;
  if (
    state.active_session_id !== null &&
    isOwnedSession(
      state,
      activeProject.project_id,
      state.active_session_id,
    )
  ) {
    return;
  }
  state.active_session_id =
    activeProject.last_session_id !== null &&
    isOwnedSession(
      state,
      activeProject.project_id,
      activeProject.last_session_id,
    )
      ? activeProject.last_session_id
      : null;
}

function newestProject(projects: ProjectRecord[]): ProjectRecord {
  const project = [...projects].sort(compareUpdatedDescending)[0];
  if (!project) throw new Error("No project is available.");
  return project;
}

function newestSession(sessions: SessionRecord[]): SessionRecord {
  const session = [...sessions].sort(compareUpdatedDescending)[0];
  if (!session) throw new Error("No session is available.");
  return session;
}

function compareUpdatedDescending(
  left: { updated_at: string },
  right: { updated_at: string },
): number {
  return right.updated_at.localeCompare(left.updated_at);
}

function deriveSessionTitle(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]?.trim() || "New chat";
  return firstLine.length <= 56 ? firstLine : `${firstLine.slice(0, 55).trimEnd()}…`;
}

function mapEntries(entries: VfsEntry[]): FileEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function snapshotWorkspaceTransferOptions(
  options: WorkspaceArchiveOptions | undefined,
): WorkspaceArchiveOptions | undefined {
  if (!options) return undefined;
  return options.limits
    ? { limits: { ...options.limits } }
    : {};
}
