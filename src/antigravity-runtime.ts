import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  AgentTurnNotSubmittedError,
  AntigravitySessionRecoveryError,
  checkSearchCancellation,
  PendingRequestResolutionError,
  localTaskMetadata,
  searchQuery,
  searchTextMatches,
  searchTextSnippet,
  type AgentCancellationSignal,
  type AgentEngineService,
  type AgentExecutionAdapter,
  type AgentProviderEvent,
  type AgentProviderEventListener,
  type AgentProviderTurnInput,
  type AgentTaskScope,
  type LocalCatalogStore,
  type ResolvePendingRequestInput,
  type StartAgentTaskOptions,
} from "@codexly/core";
import type {
  AgentEngineProfile,
  AgentTask,
  AgentModel,
  AgentItem,
  AgentTurn,
  AgentTurnOptions,
  PendingApprovalDecision,
  PendingRequest,
  SearchOccurrence,
  SearchOccurrencesQuery,
  AntigravityDefaults,
  AntigravityConfig,
} from "@codexly/protocol";
import { resolveAntigravitySelection } from "@codexly/protocol";
import {
  AntigravityAcp,
  object,
  string,
  type AcpObject,
  type AcpSession,
} from "./antigravity-acp.js";
import { applyAntigravitySelection, listAntigravityModels } from "./antigravity-models.js";
import { AntigravityExtensions } from "./antigravity-extensions.js";
import {
  antigravityHistoryWorkspace,
  antigravityMissingSessionHelp,
  AntigravitySessionMissingError,
  isMissingAntigravitySession,
  listAntigravitySessions,
  readAntigravityHistory,
} from "./antigravity-history.js";

const engine = "antigravity" as const;
const emptyPage = { data: [], nextCursor: null };
const capabilities = {
  provider: engine,
  feedback: { upload: false },
  goals: { clear: false, read: false, update: false },
  skills: { list: false, use: false },
  tasks: { fork: false, list: true, read: true, start: true },
  turns: { compact: false, interrupt: true, review: false, start: true, steer: false },
};
type Approval = Extract<PendingRequest, { type: "tool_approval" }> & { status: "pending" };
type WaitingApproval = {
  request: Approval;
  rpcId: string | number;
  choices: Map<PendingApprovalDecision, string>;
};
type LiveTurn = {
  client: AntigravityAcp;
  turn: AgentTurn;
  sessionId: string;
  approvals: Map<string, WaitingApproval>;
  cancelled: boolean;
  forceStop?: ReturnType<typeof setTimeout>;
  messageId?: string | undefined;
};

export class AntigravityRuntime {
  readonly #projects = new Map<string, AntigravityProject>();
  readonly #imports = new Map<string, Promise<AgentTask>>();
  readonly #extensions: AntigravityExtensions;
  #profile: { until: number; result: Promise<AgentEngineProfile> } | undefined;
  #configWrite = Promise.resolve();

  constructor(
    readonly directory: string,
    readonly catalog: LocalCatalogStore,
    readonly environment: NodeJS.ProcessEnv,
    readonly workspaceRoots: readonly string[] = [],
  ) {
    this.#extensions = new AntigravityExtensions(environment);
  }

  forScope(scope: AgentTaskScope) {
    let project = this.#projects.get(scope.id);
    if (!project) {
      project = new AntigravityProject(this, scope);
      this.#projects.set(scope.id, project);
    }
    return project;
  }

  release(id: string) {
    this.#projects.get(id)?.release();
    this.#projects.delete(id);
  }

  search(
    scope: AgentTaskScope,
    id: string,
    input: SearchOccurrencesQuery,
    signal?: AgentCancellationSignal,
    limit?: number,
  ) {
    const project = this.#projects.get(scope.id) ?? new AntigravityProject(this, scope);
    return project.search(id, input, signal, limit);
  }

  async inspect(refresh = false): Promise<AgentEngineProfile> {
    if (refresh) this.#profile = undefined;
    const profile = await this.#readProfile();
    const defaults = resolveAntigravitySelection(profile.models.data, await this.#readDefaults());
    return defaults ? { ...profile, antigravityDefaults: defaults } : profile;
  }

  async #loadSession(scope: AgentTaskScope, sessionId: string, taskId?: string) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await listAntigravitySessions(
        this.environment,
        scope,
        this.workspaceRoots,
        cursor,
      );
      const match = page.data.find((session) => session.id === sessionId);
      if (match) {
        const cwd = await antigravityHistoryWorkspace(scope, this.workspaceRoots, match.cwd);
        if (taskId) return this.forScope(scope).repairSession(taskId, sessionId);
        const turns = await readAntigravityHistory(this.environment, cwd, sessionId);
        const existing = (await this.catalog.catalog("task.bindings", undefined)).find(
          (task) => task.provider === engine && task.sessionId === sessionId,
        );
        if (existing) return localTaskMetadata(existing);
        return this.forScope(scope).importSession({ ...match, cwd }, turns);
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) break;
      if (cursor) seen.add(cursor);
    } while (cursor);
    throw new AntigravitySessionRecoveryError("当前范围内找不到这个 Antigravity 会话。");
  }

  #resumeSession(scope: AgentTaskScope, sessionId: string, taskId?: string) {
    const key = JSON.stringify([scope.id, sessionId, taskId]);
    const running = this.#imports.get(key);
    if (running) return running;
    const result = this.#loadSession(scope, sessionId, taskId);
    this.#imports.set(key, result);
    void result.finally(() => this.#imports.delete(key)).catch(() => undefined);
    return result;
  }

  async #readDefaults(): Promise<AntigravityDefaults | undefined> {
    try {
      const value = object(
        JSON.parse(await readFile(join(this.directory, "defaults.json"), "utf8")),
      );
      if (typeof value["model"] === "string" && typeof value["reasoningEffort"] === "string")
        return { model: value["model"], reasoningEffort: value["reasoningEffort"] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
    return undefined;
  }

  #nativePaths() {
    const home = this.environment["USERPROFILE"] || this.environment["HOME"] || homedir();
    return {
      settings: join(home, ".gemini", "antigravity-cli", "settings.json"),
      instructions: join(home, ".gemini", "config", "AGENTS.md"),
      geminiInstructions: join(home, ".gemini", "config", "GEMINI.md"),
    };
  }

  async #nativeFiles() {
    const paths = this.#nativePaths();
    const read = async (path: string) => {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    };
    const [settings, agents, gemini] = await Promise.all([
      read(paths.settings),
      read(paths.instructions),
      read(paths.geminiInstructions),
    ]);
    // Preserve a previously edited AGENTS.md; otherwise use the existing GEMINI.md.
    const instructionsPath =
      agents !== "" || gemini === "" ? paths.instructions : paths.geminiInstructions;
    const instructions = instructionsPath === paths.instructions ? agents : gemini;
    const parsed = object(settings.trim() ? JSON.parse(settings) : {});
    const nativeMode = parsed["agentMode"];
    const mode: AntigravityConfig["mode"] =
      nativeMode === ""
        ? "default"
        : nativeMode === "accept-edits" || nativeMode === "auto" || nativeMode === "plan"
          ? nativeMode
          : "inherit";
    const revision = createHash("sha256")
      .update(JSON.stringify([settings, agents, gemini, instructionsPath]))
      .digest("hex");
    return {
      paths: { ...paths, instructions: instructionsPath },
      settings,
      parsed,
      config: { mode, instructions, instructionsPath, revision },
    };
  }

  async #writeNativeConfig(request: AntigravityConfig) {
    const action = this.#configWrite.then(async () => {
      const current = await this.#nativeFiles();
      if (request.revision !== current.config.revision)
        throw new Error("配置已被其他程序修改，请重新加载");
      const modeChanged = request.mode !== current.config.mode;
      const instructionsChanged = request.instructions !== current.config.instructions;
      if (modeChanged && instructionsChanged) throw new Error("请分别保存执行模式和全局指令");
      if (!modeChanged && !instructionsChanged) return current.config;
      const target = modeChanged ? current.paths.settings : current.paths.instructions;
      if (modeChanged) {
        if (request.mode === "inherit") delete current.parsed["agentMode"];
        else current.parsed["agentMode"] = request.mode === "default" ? "" : request.mode;
      }
      const content = modeChanged
        ? JSON.stringify(current.parsed, null, 2) + "\n"
        : request.instructions;
      const temporary = `${target}.${randomUUID()}.tmp`;
      await mkdir(dirname(target), { recursive: true });
      try {
        await writeFile(temporary, content, { flag: "wx" });
        if ((await this.#nativeFiles()).config.revision !== request.revision)
          throw new Error("配置已被其他程序修改，请重新加载");
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      return (await this.#nativeFiles()).config;
    });
    this.#configWrite = action.then(
      () => undefined,
      () => undefined,
    );
    return action;
  }

  async #saveDefaults(defaults: AntigravityDefaults) {
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, "defaults.json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(defaults), { flag: "wx" });
      await rename(temporary, target);
      return defaults;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #readProfile(): Promise<AgentEngineProfile> {
    if (this.#profile && this.#profile.until > Date.now()) return this.#profile.result;
    const result = this.#inspect();
    const entry = { until: Date.now() + 60_000, result };
    this.#profile = entry;
    void result.then((profile) => {
      if (profile.connection.state !== "connected") entry.until = Date.now() + 5_000;
    });
    return result;
  }

  async #inspect(): Promise<AgentEngineProfile> {
    const cwd = join(this.directory, "probe");
    let client: AntigravityAcp | undefined;
    let session: AcpSession | undefined;
    let models: AgentModel[] = [];
    try {
      await mkdir(cwd, { recursive: true });
      client = new AntigravityAcp(cwd, this.environment);
      await client.initialize();
      session = await client.request<AcpSession>("session/new", { cwd, mcpServers: [] });
      models = await listAntigravityModels(client, session);
      await client.request("session/close", { sessionId: session.sessionId }, 3_000);
    } catch (error) {
      // Existing chat history remains readable when the CLI is offline or signed out.
      if (this.environment["CODEXLY_AGY_DEBUG"] === "1" && error instanceof Error)
        console.warn(`Antigravity availability check: ${error.message}`);
    } finally {
      client?.stop();
    }
    return {
      engine,
      capabilities,
      models: {
        nextCursor: null,
        data: models,
      },
      commands: [],
      connection: {
        account: null,
        customBaseUrl: null,
        mode: "official",
        pendingLogin: null,
        state: session?.sessionId ? "connected" : "disconnected",
      },
    };
  }

  service(): AgentEngineService {
    const unsupported = (): never => {
      throw new Error("请在 Antigravity CLI 中管理登录和设置");
    };
    return {
      inspect: (_scope, refresh) => this.inspect(refresh),
      readAntigravityConfig: async () => (await this.#nativeFiles()).config,
      writeAntigravityConfig: (config) => this.#writeNativeConfig(config),
      listAntigravitySessions: (scope, cursor) =>
        listAntigravitySessions(this.environment, scope, this.workspaceRoots, cursor),
      resumeAntigravitySession: (scope, id, taskId) => this.#resumeSession(scope, id, taskId),
      listExtensions: (kind, scope) => this.#extensions.list(kind, scope),
      mutateExtension: (input, scope) => this.#extensions.mutate(input, scope),
      writeAntigravityDefaults: (defaults) => this.#saveDefaults(defaults),
      readSettings: async () => unsupported(),
      writeSettings: async () => unsupported(),
      configure: async () => unsupported(),
      disconnect: async () => unsupported(),
    };
  }
}

class AntigravityProject implements AgentExecutionAdapter {
  readonly #starting = new Set<string>();
  readonly #running = new Map<string, LiveTurn>();
  readonly #listeners = new Set<AgentProviderEventListener>();

  constructor(
    readonly runtime: AntigravityRuntime,
    readonly scope: AgentTaskScope,
  ) {}

  #emit(event: AgentProviderEvent) {
    for (const listener of this.#listeners) listener(event);
  }

  subscribeEvents(listener: AgentProviderEventListener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  release() {
    for (const active of this.#running.values()) {
      active.cancelled = true;
      active.client.stop();
    }
  }

  async #task(id: string) {
    const task = await this.runtime.catalog.catalog("task.read", { id });
    return task?.provider === engine &&
      task.projectId === (this.scope.kind === "temporary" ? null : this.scope.id)
      ? task
      : undefined;
  }

  #directory(id: string) {
    if (!/^task-[\da-f-]{36}$/.test(id)) throw new Error("Invalid Antigravity task ID");
    return join(this.runtime.directory, id);
  }

  async #save(id: string, turn: AgentTurn, dir = this.#directory(id)) {
    await mkdir(dir, { recursive: true });
    const target = join(dir, `${turn.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(turn), { flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async startTask(options: StartAgentTaskOptions = {}) {
    if (options.ephemeral) throw new Error("Antigravity 临时生成不可用");
    return localTaskMetadata(
      await this.runtime.catalog.catalog("task.put", {
        id: `task-${randomUUID()}`,
        provider: engine,
        sessionId: null,
        projectId: this.scope.kind === "temporary" ? null : this.scope.id,
        cwd: options.workspacePath ?? this.scope.rootPath,
        title: "",
        updatedAt: Date.now() / 1000,
        pinned: false,
        archived: false,
        status: "notLoaded",
      }),
    );
  }

  async importSession(
    session: { id: string; cwd: string; title: string; updatedAt: string },
    turns: AgentTurn[],
  ) {
    const id = `task-${randomUUID()}`;
    const date = Date.parse(session.updatedAt);
    try {
      for (const turn of turns) await this.#save(id, turn);
      const first = turns[0]?.items[0];
      const title =
        session.title || (first?.type === "message" ? first.text : "") || "Antigravity 聊天";
      return localTaskMetadata(
        await this.runtime.catalog.catalog("task.put", {
          id,
          provider: engine,
          sessionId: session.id,
          projectId: this.scope.kind === "temporary" ? null : this.scope.id,
          cwd: session.cwd,
          title: title.slice(0, 512),
          updatedAt: Number.isFinite(date) ? date / 1000 : Date.now() / 1000,
          status: "idle",
          archived: false,
          pinned: false,
        }),
      );
    } catch (error) {
      await rm(this.#directory(id), { recursive: true, force: true });
      const existing = (await this.runtime.catalog.catalog("task.bindings", undefined)).find(
        (task) => task.provider === engine && task.sessionId === session.id,
      );
      if (existing) return localTaskMetadata(existing);
      throw error;
    }
  }

  #recoveredDirectory(id: string, sessionId: string) {
    const key = createHash("sha256").update(sessionId).digest("hex");
    return join(this.#directory(id), `recovered-${key}`);
  }

  async repairSession(id: string, sessionId: string) {
    this.#assertIdle(id);
    this.#starting.add(id);
    try {
      const task = await this.#task(id);
      if (!task?.sessionId || task.archived)
        throw new AntigravitySessionRecoveryError("当前聊天没有可修复的会话绑定。");
      const cwd = await antigravityHistoryWorkspace(
        this.scope,
        this.runtime.workspaceRoots,
        task.cwd,
      );
      const load = (nativeId: string) =>
        readAntigravityHistory(this.runtime.environment, cwd, nativeId);
      if (task.sessionId === sessionId) {
        await load(sessionId);
        return localTaskMetadata(task);
      }
      const missing = await load(task.sessionId).then(
        () => false,
        (error: unknown) => {
          if (error instanceof AntigravitySessionMissingError) return true;
          throw error;
        },
      );
      if (!missing)
        throw new AntigravitySessionRecoveryError("当前聊天仍可读取，所选会话可以单独打开。");
      const turns = await load(sessionId);
      const destination = this.#recoveredDirectory(id, sessionId);
      // Publish a complete replay before changing the binding. Until then readers use the old ID.
      const staging = `${destination}.${randomUUID()}.tmp`;
      try {
        await mkdir(staging, { recursive: true });
        for (const [index, turn] of turns.entries()) {
          const replayId = `${String(index).padStart(13, "0")}-${randomUUID()}`;
          await this.#save(id, { ...turn, id: replayId }, staging);
        }
        try {
          await rename(staging, destination);
        } catch (error) {
          if (!(await stat(destination).catch(() => undefined))?.isDirectory()) throw error;
          // A completed replay may already exist if the server stopped before committing the binding.
        }
        const repaired = await this.runtime.catalog.catalog("task.repairAntigravityBinding", {
          id,
          previousSessionId: task.sessionId,
          sessionId,
        });
        if (!repaired)
          throw new AntigravitySessionRecoveryError(
            "聊天状态已变化，或所选 CLI 会话已在 Web 中打开。请刷新后重试或直接打开该副本。",
          );
        return localTaskMetadata(repaired);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    } finally {
      this.#starting.delete(id);
    }
  }

  #turnNames(directory: string): Promise<string[]> {
    return readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  }

  async readTask(id: string, input?: { cursor?: string }) {
    const task = await this.#task(id);
    if (!task) return undefined;
    const dir = this.#directory(id);
    const recovered = task.sessionId ? this.#recoveredDirectory(id, task.sessionId) : undefined;
    const local = await this.#turnNames(dir);
    const replay =
      recovered && local.includes(basename(recovered)) ? await this.#turnNames(recovered) : [];
    const selected = [...local, ...replay]
      .filter(
        (name) =>
          /^\d{13}-[\da-f-]{36}\.json$/.test(name) && (!input?.cursor || name < input.cursor),
      )
      .sort()
      .reverse()
      .slice(0, 21);
    const active = this.#running.get(id);
    const page = selected.slice(0, 20);
    const turns = await Promise.all(
      page.reverse().map(async (name): Promise<AgentTurn> => {
        if (active && name === `${active.turn.id}.json`) return structuredClone(active.turn);
        const source = recovered && replay.includes(name) ? recovered : dir;
        const turn = JSON.parse(await readFile(join(source, name), "utf8")) as AgentTurn;
        if (turn.status !== "running") return turn;
        return { ...turn, status: "interrupted", error: "服务在 Antigravity 回合结束前退出。" };
      }),
    );
    return {
      ...localTaskMetadata(task),
      contextUsage: null,
      goal: null,
      plan: null,
      pendingRequests: active ? [...active.approvals.values()].map(({ request }) => request) : [],
      status: active ? ("running" as const) : ("idle" as const),
      turns: turns.filter((turn) => !isLegacyResumeMarker(turn)),
      turnsNextCursor: selected.length > 20 ? page[0]! : null,
    };
  }

  async getCapabilities() {
    return capabilities;
  }
  async listModels() {
    return (await this.runtime.inspect()).models;
  }
  async listSkills() {
    return emptyPage;
  }
  async listMcpServers() {
    return emptyPage;
  }
  async listBackgroundTerminals() {
    return emptyPage;
  }
  async readGoal() {
    return null;
  }
  async readTaskAttachment() {
    return undefined;
  }
  async search(
    id: string,
    input: SearchOccurrencesQuery,
    signal?: AgentCancellationSignal,
    limit = 30,
  ) {
    const query = searchQuery(input.query);
    let cursor: string | null = null;
    let skip = 0;
    if (input.cursor) {
      const state = object(JSON.parse(input.cursor));
      if (
        state["task"] !== id ||
        state["query"] !== query ||
        typeof state["page"] !== "string" ||
        typeof state["offset"] !== "number" ||
        !Number.isSafeInteger(state["offset"]) ||
        state["offset"] < 0
      )
        throw new Error("Invalid Antigravity search cursor");
      cursor = state["page"];
      skip = state["offset"];
    }
    do {
      checkSearchCancellation(signal);
      const page = await this.readTask(id, cursor ? { cursor } : undefined);
      if (!page) break;
      const anchor = page.turns.at(-1)?.id;
      const data: SearchOccurrence[] = [];
      let offset = 0;
      for (const turn of page.turns.toReversed()) {
        for (const item of turn.items) {
          checkSearchCancellation(signal);
          if (item.type !== "message") continue;
          for (const { start, end } of searchTextMatches(item.text, query)) {
            if (offset++ < skip) continue;
            if (data.length === limit)
              return {
                data,
                nextCursor: JSON.stringify({
                  task: id,
                  query,
                  page: `${anchor}.json~`,
                  offset: offset - 1,
                }),
              };
            data.push({
              itemId: item.id,
              turnId: turn.id,
              turnCursor: `${turn.id}.json~`,
              ...searchTextSnippet(item.text, start, end),
            });
          }
        }
      }
      cursor = page.turnsNextCursor;
      if (data.length)
        return {
          data,
          nextCursor:
            cursor === null ? null : JSON.stringify({ task: id, query, page: cursor, offset: 0 }),
        };
      skip = 0;
    } while (cursor);
    return emptyPage;
  }
  async unsubscribeTask(id: string) {
    return this.#running.has(id) || this.#starting.has(id)
      ? ("busy" as const)
      : ("notSubscribed" as const);
  }

  async #patch(id: string, patch: { pinned?: boolean; title?: string; archived?: boolean }) {
    if (!(await this.#task(id))) throw new Error("Antigravity task not found");
    return localTaskMetadata(await this.runtime.catalog.catalog("task.patch", { id, ...patch }));
  }
  async pinTask(id: string, pinned: boolean) {
    return this.#patch(id, { pinned });
  }
  async renameTask(id: string, title: string) {
    await this.#patch(id, { title });
  }
  async unarchiveTask(id: string) {
    return this.#patch(id, { archived: false });
  }
  async archiveTask(id: string) {
    this.#assertIdle(id);
    await this.#patch(id, { archived: true });
    this.#emit({ taskId: id, type: "task.removed", payload: { reason: "archived" } });
  }

  async deleteTask(id: string) {
    this.#assertIdle(id);
    if (!(await this.#task(id))) return;
    await this.runtime.catalog.catalog("task.remove", { id });
    await rm(this.#directory(id), { recursive: true, force: true });
    this.#emit({ taskId: id, type: "task.removed", payload: { reason: "deleted" } });
  }

  #assertIdle(id: string) {
    if (this.#starting.has(id) || this.#running.has(id))
      throw new AgentTurnNotSubmittedError("此 Antigravity 聊天正在运行");
  }

  async startTurn(id: string, input: AgentProviderTurnInput, options: AgentTurnOptions) {
    this.#assertIdle(id);
    this.#starting.add(id);
    let client: AntigravityAcp | undefined;
    try {
      const task = await this.#task(id);
      if (!task || task.archived) throw new Error("Antigravity 聊天不存在或已归档");
      if (input.files.length || input.skills.length || input.outputSchema)
        throw new Error("Antigravity 目前支持文本、文本附件与图片输入");
      const text = [
        input.text,
        ...input.textAttachments.map(({ name, text }) => `[${name}]\n${text}`),
      ]
        .filter(Boolean)
        .join("\n\n");
      const prompt: AcpObject[] = text ? [{ type: "text", text }] : [];
      for (const image of input.images)
        prompt.push({
          type: "image",
          mimeType: image.mediaType,
          data: (await readFile(image.path)).toString("base64"),
        });
      if (!prompt.length) throw new Error("请输入消息");

      client = new AntigravityAcp(task.cwd, this.runtime.environment);
      await client.initialize();
      const params = { cwd: task.cwd, mcpServers: [] };
      let sessionId = task.sessionId;
      let session: AcpSession;
      if (sessionId) {
        session = await client.request<AcpSession>("session/resume", { ...params, sessionId });
        if (session.sessionId && session.sessionId !== sessionId)
          throw new Error("Antigravity CLI 返回了不同的会话 ID。");
      } else {
        session = await client.request<AcpSession>("session/new", params);
        if (!session.sessionId) throw new Error("Antigravity 未返回会话 ID");
        sessionId = session.sessionId;
        await this.runtime.catalog.catalog("task.patch", { id, sessionId });
      }
      await applyAntigravitySelection(client, sessionId, session.configOptions, options);

      const turnId = `${Date.now()}-${randomUUID()}`;
      const turn: AgentTurn = {
        id: turnId,
        status: "running",
        forkable: false,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        items: [
          {
            id: `${turnId}-user`,
            type: "message",
            role: "user",
            text: text || input.images.map((img) => basename(img.path)).join(", "),
          },
        ],
      };
      if (!task.preview && !task.title)
        await this.runtime.catalog.catalog("task.preview", {
          id,
          preview: (input.text.trim() || "图片任务").slice(0, 120),
        });
      await this.#save(id, turn);
      const active: LiveTurn = { client, sessionId, turn, approvals: new Map(), cancelled: false };
      this.#running.set(id, active);
      client.onMessage = (message) => this.#message(id, active, message);
      this.#emit({ taskId: id, turnId, type: "turn.started", payload: { turn } });
      void this.#execute(id, active, prompt);
      return turn;
    } catch (error) {
      client?.stop();
      throw new AgentTurnNotSubmittedError(
        isMissingAntigravitySession(error)
          ? antigravityMissingSessionHelp
          : error instanceof Error
            ? error.message
            : "Antigravity 启动失败",
      );
    } finally {
      this.#starting.delete(id);
    }
  }

  #putItem(id: string, active: LiveTurn, item: AgentItem, completed: boolean) {
    const { turn } = active;
    const index = turn.items.findIndex((existing) => existing.id === item.id);
    const items = [...turn.items];
    if (index === -1) items.push(item);
    else items[index] = item;
    active.turn = { ...turn, items };
    this.#emit({
      taskId: id,
      turnId: turn.id,
      itemId: item.id,
      type: completed ? "item.completed" : "item.started",
      payload: { item },
    });
  }

  #message(id: string, active: LiveTurn, message: AcpObject) {
    const { params: rawParams, id: rpcId, method } = message;
    const params = object(rawParams);
    if (
      method === "session/request_permission" &&
      (typeof rpcId === "string" || typeof rpcId === "number")
    ) {
      this.#permission(id, active, rpcId, params);
      return;
    }
    if (typeof rpcId === "string" || typeof rpcId === "number") {
      active.client.rejectMethod(rpcId);
      return;
    }
    if (method !== "session/update" || params["sessionId"] !== active.sessionId) return;
    const {
      sessionUpdate,
      content,
      toolCallId,
      status: nativeStatus,
      title,
      rawInput,
      rawOutput,
    } = object(params["update"]);
    if (sessionUpdate === "agent_message_chunk") {
      const delta = string(object(content)["text"]);
      if (!delta) return;
      if (!active.messageId) {
        active.messageId = randomUUID();
        this.#putItem(
          id,
          active,
          { id: active.messageId, type: "message", role: "assistant", text: "" },
          false,
        );
      }
      const { turn, messageId } = active;
      active.turn = {
        ...turn,
        items: turn.items.map((item) =>
          item.id === messageId && item.type === "message"
            ? { ...item, text: item.text + delta }
            : item,
        ),
      };
      this.#emit({
        taskId: id,
        turnId: turn.id,
        itemId: messageId,
        type: "message.delta",
        payload: { delta },
      });
    } else if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
      const toolId = string(toolCallId);
      if (!toolId) return;
      active.messageId = undefined;
      const prior = active.turn.items.find(
        (item): item is Extract<AgentItem, { type: "tool" }> =>
          item.id === toolId && item.type === "tool",
      );
      const status =
        nativeStatus === "completed" || nativeStatus === "failed" ? nativeStatus : "running";
      this.#putItem(
        id,
        active,
        {
          ...prior,
          id: toolId,
          type: "tool",
          name: string(title) || prior?.name || "Antigravity tool",
          status,
          ...(rawInput === undefined ? {} : { input: bounded(rawInput) }),
          ...(rawOutput === undefined && content === undefined
            ? {}
            : { output: bounded(rawOutput ?? content) }),
        },
        status !== "running",
      );
    }
  }

  #permission(id: string, active: LiveTurn, rpcId: string | number, params: AcpObject) {
    const choices = new Map<PendingApprovalDecision, string>();
    const { options, sessionId, toolCall } = params;
    for (const entry of Array.isArray(options) ? options : []) {
      const { kind, optionId } = object(entry);
      const decision =
        kind === "allow_once" ? "allow" : kind === "reject_once" ? "deny" : undefined;
      if (decision && typeof optionId === "string") choices.set(decision, optionId);
    }
    if (active.cancelled || sessionId !== active.sessionId || !choices.size) {
      active.client.reply(rpcId, { outcome: { outcome: "cancelled" } });
      return;
    }
    const { toolCallId, title, rawInput } = object(toolCall);
    const request: Approval = {
      type: "tool_approval",
      status: "pending",
      requestId: randomUUID(),
      itemId: string(toolCallId) || randomUUID(),
      projectId: this.scope.id,
      taskId: id,
      turnId: active.turn.id,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      toolName: string(title) || "Antigravity tool",
      input: bounded(rawInput ?? null),
      reason: null,
      availableDecisions: [...choices.keys()],
    };
    active.approvals.set(request.requestId, { request, rpcId, choices });
    this.#emit({
      taskId: id,
      turnId: request.turnId,
      itemId: request.itemId,
      type: "pending_request.created",
      payload: { request },
    });
  }

  async resolvePendingRequest(input: ResolvePendingRequestInput) {
    const active = this.#running.get(input.taskId);
    const waiting = active?.approvals.get(input.requestId);
    if (!active || !waiting) throw new PendingRequestResolutionError("not_found", "审批已结束");
    const { request, rpcId, choices } = waiting;
    const choice =
      input.type === "tool_approval" ? choices.get(input.resolution.decision) : undefined;
    if (
      !choice ||
      request.projectId !== input.projectId ||
      request.turnId !== input.turnId ||
      request.itemId !== input.itemId
    )
      throw new PendingRequestResolutionError("mismatch", "审批与当前工具请求不匹配");
    active.client.reply(rpcId, { outcome: { outcome: "selected", optionId: choice } });
    active.approvals.delete(request.requestId);
    const resolved = { ...request, status: "resolved" as const };
    this.#emit({
      taskId: request.taskId,
      turnId: request.turnId,
      itemId: request.itemId,
      type: "pending_request.resolved",
      payload: { request: resolved },
    });
    return resolved;
  }

  async interruptTurn(id: string, turnId: string) {
    const active = this.#running.get(id);
    if (!active || active.turn.id !== turnId || active.cancelled) return;
    active.cancelled = true;
    active.forceStop = setTimeout(() => active.client.stop(), 4_000);
    try {
      active.client.notify("session/cancel", { sessionId: active.sessionId });
      for (const { rpcId } of active.approvals.values())
        active.client.reply(rpcId, { outcome: { outcome: "cancelled" } });
    } catch {
      active.client.stop();
    }
  }

  async stopSession(id: string) {
    const active = this.#running.get(id);
    if (active) await this.interruptTurn(id, active.turn.id);
  }

  async #execute(id: string, active: LiveTurn, prompt: AcpObject[]) {
    let status: AgentTurn["status"] = "completed";
    let error: string | null = null;
    try {
      const result = await active.client.request<{ stopReason: string }>(
        "session/prompt",
        { sessionId: active.sessionId, prompt },
        0,
      );
      if (result.stopReason === "cancelled") status = "interrupted";
      else if (result.stopReason !== "end_turn") {
        status = "failed";
        error = `Antigravity 提前结束：${result.stopReason}`;
      }
    } catch (failure) {
      status = "failed";
      error = isMissingAntigravitySession(failure)
        ? antigravityMissingSessionHelp
        : failure instanceof Error
          ? failure.message
          : "Antigravity 执行失败";
    }
    clearTimeout(active.forceStop);
    if (active.cancelled) {
      status = "interrupted";
      error = null;
    }
    for (const { request } of active.approvals.values())
      this.#emit({
        taskId: id,
        turnId: request.turnId,
        itemId: request.itemId,
        type: "pending_request.expired",
        payload: { request: { ...request, status: "expired" } },
      });
    active.approvals.clear();
    const completedAt = new Date().toISOString();
    const items = active.turn.items.map((item): AgentItem =>
      item.type === "tool" && item.status === "running"
        ? { ...item, status: status === "interrupted" ? "interrupted" : "failed" }
        : item,
    );
    let turn: AgentTurn = { ...active.turn, items, completedAt, status, error };
    active.turn = turn;
    try {
      await this.#save(id, turn);
      await this.runtime.catalog.catalog("task.patch", { id, updatedAt: Date.now() / 1000 });
    } catch (failure) {
      turn = {
        ...turn,
        persistence: { status: "failed", error: failure instanceof Error ? failure.message : null },
      };
    }
    this.#running.delete(id);
    this.#emit({ taskId: id, turnId: turn.id, type: "turn.completed", payload: { turn } });
    try {
      await active.client.request("session/close", { sessionId: active.sessionId }, 3_000);
    } catch {
      // Closing an already terminated process does not change the turn result.
    } finally {
      active.client.stop();
    }
  }
}

function isLegacyResumeMarker(turn: AgentTurn) {
  const item = turn.items[0];
  return (
    turn.items.length === 1 &&
    item?.type === "activity" &&
    item.label === "已连接原会话" &&
    item.detail === "Antigravity CLI 未返回此客户端对话的历史消息，可继续发送消息。"
  );
}

function bounded(value: unknown) {
  const encoded = JSON.stringify(value);
  return encoded && encoded.length > 32_768 ? encoded.slice(0, 32_768) + "…" : value;
}
