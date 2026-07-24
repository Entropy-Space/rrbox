import type { Model } from "@earendil-works/pi-ai";
import type { ModelTransport } from "@researchbox/model-transport";
import {
  PROJECT_STORE_SCHEMA_VERSION,
  SESSION_DOCUMENT_FORMAT_VERSION,
  assertProjectStoreInvariants,
  cloneProjectStoreState,
  type ProjectRecord,
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
  type ToolCallBlock,
  type ToolResultEntry,
  type ViewerCommand,
  type WorkspaceChangeSummary,
} from "@researchbox/protocol";
import type {
  VfsEntry,
  WorkspaceBackend,
  WorkspaceChangeRecord,
} from "@researchbox/vfs";
import {
  SessionRuntime,
  stagePrompt,
  type CoreEventSink,
} from "./session-runtime.ts";
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
  eventSink: CoreEventSink;
} & WorkspaceBackendOption;

export type AgentCoreOptions = ResearchBoxCoreOptions;

export class ResearchBoxCore {
  private readonly projectStore: ProjectStore;
  private readonly workspaceBackend: WorkspaceBackend;
  private readonly modelTransport: ModelTransport;
  private readonly providerCatalog: ProviderCatalogService;
  private readonly defaultModel: Model<string>;
  private readonly defaultModelSelection: ModelSelection;
  private readonly systemPrompt: string;
  private readonly eventSink: CoreEventSink;
  private readonly workspaces = new Map<string, WorkspaceController>();
  private state: ProjectStoreState | null = null;
  private workspace: WorkspaceController | null = null;
  private runtime: SessionRuntime | null = null;
  private initialization: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private providerRefreshObserverStarted = false;

  constructor(options: ResearchBoxCoreOptions) {
    this.projectStore = options.projectStore;
    this.workspaceBackend =
      options.workspaceBackend ?? options.workspaceProvider;
    this.modelTransport = options.modelTransport;
    this.defaultModel = options.model;
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
    this.eventSink = options.eventSink;
  }

  async handle(command: ViewerCommand): Promise<void> {
    await this.ensureInitialized();
    switch (command.type) {
      case "bootstrap":
        await this.mutationTail;
        this.emit("ready", { state: await this.createCoreState() }, command.request_id);
        this.startProviderRefreshes();
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
      case "prompt":
        await this.prompt(command);
        return;
      case "fs_list":
        await this.mutationTail;
        await this.listFiles(command);
        return;
      case "fs_read":
        await this.mutationTail;
        await this.readFile(command);
        return;
      default:
        await this.enqueueMutation(() => this.handleMutation(command));
    }
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

  private async initialize(): Promise<void> {
    const loaded = await this.projectStore.load();
    if (loaded) {
      this.state = loaded;
      const reconciledChanges = await reconcileWorkspaceChanges(
        loaded,
        this.workspaceBackend,
      );
      const repairedTranscripts = repairInvalidTranscripts(loaded);
      const repairedRuns = repairInterruptedSessions(loaded);
      if (reconciledChanges || repairedTranscripts || repairedRuns) {
        await this.persistCurrentState();
      }
    } else {
      const state = createInitialState(this.defaultModelSelection);
      const projectId = state.active_project_id;
      await this.workspaceBackend.create(projectId);
      state.state_revision = 1;
      try {
        await this.projectStore.save(state, null);
      } catch (error) {
        await this.workspaceBackend.delete(projectId).catch(() => undefined);
        throw error;
      }
      this.state = state;
    }
    this.ensurePersistedModelsRegistered();
    await this.activateSelection();
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
          | "fs_read";
      }
    >,
  ): Promise<void> {
    switch (command.type) {
      case "project_create":
        await this.createProject(command.payload.name, command.request_id);
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
        const draft = cloneProjectStoreState(this.requireState());
        const created = createSessionRecord(
          command.payload.project_id,
          deriveSessionTitle(promptText),
          false,
          findProject(draft, command.payload.project_id).new_chat_model,
        );
        const staged = stagePrompt(created.document, promptText);
        draft.sessions.push(created.session);
        draft.documents.push(created.document);
        const project = findProject(draft, command.payload.project_id);
        project.last_session_id = created.session.session_id;
        project.new_chat_draft = "";
        project.updated_at = created.session.updated_at;
        draft.active_session_id = created.session.session_id;
        try {
          await this.commitDraft(draft);
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

      runPromise = this.requireRuntime().startPrompt(
        promptText,
        command.request_id,
      );
    });
    if (runPromise) await runPromise;
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

  private async createProject(name: string, requestId: string): Promise<void> {
    const normalizedName = this.validateName(name, "project", requestId);
    if (!normalizedName) return;
    if (!this.ensureManagementIdle(requestId)) return;
    await this.stopActiveRun();

    const draft = cloneProjectStoreState(this.requireState());
    const project = createProjectRecord(
      normalizedName,
      this.defaultModelSelection,
    );
    draft.projects.push(project);
    draft.active_project_id = project.project_id;
    draft.active_session_id = null;

    await this.workspaceBackend.create(project.project_id);
    try {
      await this.commitDraft(draft);
    } catch (error) {
      await this.workspaceBackend
        .delete(project.project_id)
        .catch(() => undefined);
      throw error;
    }
    await this.activateSelection();
    await this.emitStateSnapshot(requestId);
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
    const draft = cloneProjectStoreState(this.requireState());
    const draftProject = findProject(draft, projectId);
    draftProject.name = normalizedName;
    draftProject.updated_at = new Date().toISOString();
    await this.commitDraft(draft);
    await this.emitStateSnapshot(requestId);
  }

  private async deleteProject(
    projectId: string,
    requestId: string,
  ): Promise<void> {
    if (!this.getProject(projectId, requestId)) return;
    if (!this.ensureManagementIdle(requestId)) return;
    await this.stopActiveRun();
    const previousState = this.requireState();
    const draft = cloneProjectStoreState(previousState);
    const activeChanged = draft.active_project_id === projectId;
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

    let replacementProjectId: string | null = null;
    if (draft.projects.length === 0) {
      const replacement = createProjectRecord(
        "Local workspace",
        this.defaultModelSelection,
      );
      draft.projects.push(replacement);
      replacementProjectId = replacement.project_id;
      await this.workspaceBackend.create(replacement.project_id);
    }
    if (activeChanged) {
      const nextProject = newestProject(draft.projects);
      draft.active_project_id = nextProject.project_id;
      draft.active_session_id = nextProject.last_session_id;
    }

    try {
      await this.commitDraft(draft);
    } catch (error) {
      if (replacementProjectId) {
        await this.workspaceBackend
          .delete(replacementProjectId)
          .catch(() => undefined);
      }
      throw error;
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
    const draft = cloneProjectStoreState(this.requireState());
    draft.active_project_id = projectId;
    draft.active_session_id = findProject(draft, projectId).last_session_id;
    await this.commitDraft(draft);
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

    const draft = cloneProjectStoreState(state);
    const project = findProject(draft, projectId);
    project.last_session_id = null;
    draft.active_project_id = projectId;
    draft.active_session_id = null;
    await this.commitDraft(draft);
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

    const draft = cloneProjectStoreState(this.requireState());
    const now = new Date().toISOString();
    const project = findProject(draft, payload.project_id);
    if (payload.session_id === null) {
      project.new_chat_model = selection;
    } else {
      const session = findSession(draft, payload.session_id);
      session.selected_model = selection;
      session.updated_at = now;
    }
    project.updated_at = now;
    await this.commitDraft(draft);
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

    try {
      await this.projectStore.saveInputDraft({
        project_id: projectId,
        session_id: sessionId,
        input_draft: inputDraft,
      });
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

    if (sessionId === null) {
      project.new_chat_draft = inputDraft;
    } else {
      this.requireDocument(sessionId).input_draft = inputDraft;
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
    const draft = cloneProjectStoreState(this.requireState());
    const session = findSession(draft, sessionId);
    session.title = normalizedTitle;
    session.title_is_custom = true;
    session.updated_at = new Date().toISOString();
    findProject(draft, projectId).updated_at = session.updated_at;
    await this.commitDraft(draft);
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
    const draft = cloneProjectStoreState(state);
    const activeChanged = draft.active_session_id === sessionId;
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
    project.updated_at = new Date().toISOString();
    if (activeChanged) draft.active_session_id = replacement?.session_id ?? null;
    await this.commitDraft(draft);
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
    const draft = cloneProjectStoreState(state);
    draft.active_project_id = projectId;
    draft.active_session_id = sessionId;
    const project = findProject(draft, projectId);
    project.last_session_id = sessionId;
    project.updated_at = new Date().toISOString();
    await this.commitDraft(draft);
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
    let workspace = this.workspaces.get(projectId);
    if (!workspace) {
      workspace = new WorkspaceController(
        await this.workspaceBackend.open(projectId),
      );
      this.workspaces.set(projectId, workspace);
    }
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
            system_prompt: this.systemPrompt,
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

    const expectedRevision = state.state_revision;
    const persisted = cloneProjectStoreState(state);
    const session = findSession(persisted, sessionId);
    const document = findDocument(persisted, sessionId);
    const now = new Date().toISOString();
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
    findProject(persisted, projectId).updated_at = now;
    persisted.state_revision = expectedRevision + 1;
    assertProjectStoreInvariants(persisted);
    await this.projectStore.save(persisted, expectedRevision);

    const currentSession = this.requireSession(sessionId);
    currentSession.title = session.title;
    currentSession.updated_at = now;
    this.requireProject(projectId).updated_at = now;
    state.state_revision = persisted.state_revision;
  }

  private async persistCurrentState(): Promise<void> {
    const state = this.requireState();
    const expectedRevision = state.state_revision;
    const persisted = cloneProjectStoreState(state);
    persisted.state_revision = expectedRevision + 1;
    assertProjectStoreInvariants(persisted);
    await this.projectStore.save(persisted, expectedRevision);
    state.state_revision = persisted.state_revision;
    this.ensurePersistedModelsRegistered();
  }

  private async commitDraft(draft: ProjectStoreState): Promise<void> {
    const current = this.requireState();
    const expectedRevision = current.state_revision;
    if (draft.active_session_id !== null) {
      repairInvalidTranscript(findDocument(draft, draft.active_session_id));
    }
    draft.state_revision = expectedRevision + 1;
    assertProjectStoreInvariants(draft);
    await this.projectStore.save(draft, expectedRevision);
    const sameRuntime =
      draft.active_session_id !== null &&
      this.runtime?.project_id === draft.active_project_id &&
      this.runtime.session_id === draft.active_session_id;
    this.state = draft;
    this.ensurePersistedModelsRegistered();
    if (sameRuntime && draft.active_session_id !== null) {
      this.runtime?.bindDocument(this.requireDocument(draft.active_session_id));
    }
  }

  private async emitStateSnapshot(requestId?: string): Promise<void> {
    this.emit(
      "state_snapshot",
      { state: await this.createCoreState() },
      requestId,
    );
  }

  private async createCoreState(): Promise<CoreStateSnapshot> {
    let files: FileEntry[];
    let workspaceRevision: number;
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
        .map(({ project_id, name, created_at, updated_at }) => ({
          project_id,
          name,
          created_at,
          updated_at,
        })),
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

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requireState(): ProjectStoreState {
    if (!this.state) throw new Error("ResearchBox core is not initialized.");
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
  };
}

function createSessionRecord(
  projectId: string,
  title: string,
  titleIsCustom: boolean,
  modelSelection: ModelSelection,
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
): Promise<boolean> {
  const changesByProject = new Map<string, WorkspaceChangeRecord[]>();
  for (const project of state.projects) {
    const workspace = await workspaceBackend.open(project.project_id);
    const journal = await workspace.listChanges();
    changesByProject.set(project.project_id, journal.changes);
  }

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
  return reconciled;
}

function workspaceChangeSummary(
  record: WorkspaceChangeRecord,
): WorkspaceChangeSummary {
  return {
    change_id: record.change_id,
    tool_call_id: record.tool_call_id,
    path: record.path,
    change_kind: record.change_kind,
    additions: record.additions,
    deletions: record.deletions,
    byte_size: record.byte_size,
  };
}

function workspaceChangeActivitySummary(change: WorkspaceChangeSummary): string {
  const verb = change.change_kind === "created" ? "Created" : "Updated";
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
  return toolName === "write_file" || toolName === "replace_text";
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
      content: "Tool execution was interrupted before it produced a result.",
      is_error: true,
      summary: "Interrupted by reload",
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
