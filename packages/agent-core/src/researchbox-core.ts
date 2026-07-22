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
  type ViewerCommand,
} from "@researchbox/protocol";
import type {
  ProjectFileSystemProvider,
  VfsEntry,
  VirtualFileSystem,
} from "@researchbox/vfs";
import {
  SessionRuntime,
  stagePrompt,
  type CoreEventSink,
} from "./session-runtime.ts";
import {
  decodeAgentMessages,
  encodeAgentMessages,
} from "./session-codec.ts";
import {
  ProviderCatalogService,
  type ModelProviderDefinition,
  type ProviderModelCatalog,
} from "./provider-catalog-service.ts";
import { repairUnansweredToolCalls } from "./tool-transcript.ts";

export type ResearchBoxCoreOptions = {
  projectStore: ProjectStore;
  workspaceProvider: ProjectFileSystemProvider;
  modelTransport: ModelTransport;
  providerCatalog?: ProviderCatalogService;
  modelCatalog?: ProviderModelCatalog;
  model: Model<string>;
  providers?: ModelProviderDefinition[];
  systemPrompt: string;
  eventSink: CoreEventSink;
};

export type AgentCoreOptions = ResearchBoxCoreOptions;

export class ResearchBoxCore {
  private readonly projectStore: ProjectStore;
  private readonly workspaceProvider: ProjectFileSystemProvider;
  private readonly modelTransport: ModelTransport;
  private readonly providerCatalog: ProviderCatalogService;
  private readonly defaultModel: Model<string>;
  private readonly defaultModelSelection: ModelSelection;
  private readonly systemPrompt: string;
  private readonly eventSink: CoreEventSink;
  private state: ProjectStoreState | null = null;
  private workspace: VirtualFileSystem | null = null;
  private runtime: SessionRuntime | null = null;
  private initialization: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private providerRefreshObserverStarted = false;

  constructor(options: ResearchBoxCoreOptions) {
    this.projectStore = options.projectStore;
    this.workspaceProvider = options.workspaceProvider;
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
      const repairedTranscripts = repairInvalidTranscripts(loaded);
      const repairedRuns = repairInterruptedSessions(loaded);
      if (repairedTranscripts || repairedRuns) await this.persistCurrentState();
    } else {
      const state = createInitialState(this.defaultModelSelection);
      const projectId = state.active_project_id;
      await this.workspaceProvider.create(projectId);
      state.state_revision = 1;
      try {
        await this.projectStore.save(state, null);
      } catch (error) {
        await this.workspaceProvider.delete(projectId).catch(() => undefined);
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
          staged.assistant_message.id,
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

    await this.workspaceProvider.create(project.project_id);
    try {
      await this.commitDraft(draft);
    } catch (error) {
      await this.workspaceProvider
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
      await this.workspaceProvider.create(replacement.project_id);
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
        await this.workspaceProvider
          .delete(replacementProjectId)
          .catch(() => undefined);
      }
      throw error;
    }
    if (activeChanged) await this.activateSelection();
    await this.emitStateSnapshot(requestId);
    try {
      await this.workspaceProvider.delete(projectId);
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
    void this.providerCatalog
      .startRefreshes()
      .then(() => this.emitStateSnapshot())
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
    const workspace = await this.workspaceProvider.open(state.active_project_id);
    const projectId = state.active_project_id;
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
    phase: "staged" | "finished",
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
      document.messages.length === 2
    ) {
      const firstUserMessage = document.messages[0];
      if (firstUserMessage?.role === "user") {
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
    while (true) {
      const projectId = this.requireState().active_project_id;
      const workspace = this.requireWorkspace();
      files = mapEntries(await workspace.list("/"));
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
          message_count: this.requireDocument(session_id).messages.length,
        })),
      providers: catalog.providers,
      active_model: { ...activeModel },
      active_project_id: state.active_project_id,
      active_session_id: state.active_session_id,
      input_draft:
        document === null
          ? activeProject.new_chat_draft
          : document.input_draft,
      messages: structuredClone(document?.messages ?? []),
      activities: structuredClone(document?.activities ?? []),
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
      this.emit(
        "files_snapshot",
        {
          project_id: command.payload.project_id,
          path: command.payload.path,
          files: mapEntries(await this.requireWorkspace().list(command.payload.path)),
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
      this.emit(
        "file_content",
        {
          project_id: command.payload.project_id,
          path: command.payload.path,
          content: await this.requireWorkspace().read(command.payload.path),
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

  private requireWorkspace(): VirtualFileSystem {
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
      messages: [],
      activities: [],
      agent_messages: [],
    },
  };
}

function repairInterruptedSessions(state: ProjectStoreState): boolean {
  let repaired = false;
  for (const document of state.documents) {
    const hadStreamingMessage = document.messages.some((message) => {
      if (message.status !== "streaming") return false;
      message.status = "aborted";
      repaired = true;
      return true;
    });
    for (const activity of document.activities) {
      if (activity.status !== "running") continue;
      activity.status = "error";
      activity.summary = "Interrupted by reload";
      repaired = true;
    }
    if (
      hadStreamingMessage &&
      isStoredUserMessage(document.agent_messages.at(-1))
    ) {
      document.agent_messages.pop();
      repaired = true;
    }
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
  try {
    const decoded = decodeAgentMessages(document.agent_messages);
    const repaired = repairUnansweredToolCalls(
      decoded,
      "Tool execution was interrupted before it produced a result.",
    );
    if (repaired.repaired) {
      document.agent_messages = encodeAgentMessages(repaired.messages);
    }
    return repaired.repaired;
  } catch {
    document.agent_messages = [];
    return true;
  }
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

function isStoredUserMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).role === "user"
  );
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
