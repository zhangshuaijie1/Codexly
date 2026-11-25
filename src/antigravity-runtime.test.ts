import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AgentProviderEvent, LocalCatalogStore, LocalTask } from "@codexly/core";
import { AntigravityRuntime } from "./antigravity-runtime.js";

const acp = vi.hoisted(() => ({
  message: (_event: Record<string, unknown>) => {},
  reply: vi.fn(),
  cancel: vi.fn(),
  history: vi.fn(),
}));

vi.mock("./antigravity-acp.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./antigravity-acp.js")>();
  return {
    ...original,
    AntigravityAcp: class {
      onMessage = acp.message;
      #finish?: (result: unknown) => void;

      async initialize() {}
      async request(method: string, params: Record<string, unknown>) {
        if (method === "session/new") return { sessionId: "native-session" };
        if (["session/list", "session/load", "session/resume"].includes(method))
          return acp.history(method, params, this.onMessage);
        if (method === "session/prompt")
          return new Promise((resolve) => {
            this.#finish = resolve;
            acp.message = (message) => this.onMessage(message);
          });
        return {};
      }
      reply = acp.reply;
      notify(method: string, params: unknown) {
        acp.cancel(method, params);
        this.#finish?.({ stopReason: "cancelled" });
      }
      stop() {}
    },
  };
});

it("rejects an App-only ID and restores a readable CLI copy in the existing chat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codexly-antigravity-history-"));
  const id = "task-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const scope = {
    id: "temporary",
    kind: "temporary" as const,
    rootPath: directory,
    runtimeWorkspaceRoots: [directory],
  };
  let task: LocalTask = {
    id,
    projectId: null,
    provider: "antigravity",
    sessionId: "app-id",
    status: "idle",
    pinned: true,
    archived: false,
    updatedAt: 1,
    title: "Existing title",
    cwd: directory,
  };
  const catalog = vi.fn(async (operation: string, input: { sessionId: string }) => {
    if (operation === "task.bindings") return [task];
    if (operation === "task.repairAntigravityBinding")
      task = { ...task, sessionId: input.sessionId };
    return task;
  });
  acp.history.mockImplementation((method, { sessionId }, onMessage) => {
    if (method === "session/list")
      return { sessions: ["app-id", "cli-id"].map((id) => ({ sessionId: id, cwd: directory })) };
    if (method === "session/load" && sessionId === "app-id")
      throw new Error("Session not found: app-id");
    if (method === "session/load") {
      onMessage({
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "user_message_chunk", content: { text: "Original prompt" } },
        },
      });
    }
    return { sessionId };
  });
  try {
    const runtime = new AntigravityRuntime(
      directory,
      { catalog } as unknown as LocalCatalogStore,
      {},
    );
    const resume = runtime.service().resumeAntigravitySession!;
    await expect(resume(scope, "app-id")).rejects.toThrow("CLI 找不到该会话");
    expect(acp.history.mock.calls.some(([method]) => method === "session/resume")).toBe(false);
    expect(await resume(scope, "cli-id", id)).toMatchObject({
      id,
      title: "Existing title",
      pinned: true,
    });
    expect(await runtime.forScope(scope).readTask(id)).toMatchObject({
      turns: [{ items: [{ role: "user", text: "Original prompt" }] }],
    });
    await expect(resume(scope, "cli-id", id)).resolves.toMatchObject({ id });
    expect(
      catalog.mock.calls.filter(([operation]) => operation === "task.repairAntigravityBinding"),
    ).toHaveLength(1);
  } finally {
    acp.history.mockReset();
    await rm(directory, { recursive: true, force: true });
  }
});

it("routes a specific tool decision to ACP and persists an interrupted turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codexly-antigravity-"));
  try {
    let task: LocalTask | undefined;
    const store = {
      catalog: vi.fn(async (operation: string, input: LocalTask) => {
        if (operation === "task.put") task = input;
        if ((operation === "task.patch" || operation === "task.preview") && task)
          task = { ...task, ...input };
        return task;
      }),
    } as unknown as LocalCatalogStore;
    const project = new AntigravityRuntime(directory, store, {}).forScope({
      id: "project",
      kind: "project",
      rootPath: directory,
      runtimeWorkspaceRoots: [directory],
    });
    const events: AgentProviderEvent[] = [];
    project.subscribeEvents((event) => events.push(event));
    const { id } = await project.startTask();
    const turn = await project.startTurn(
      id,
      { files: [], images: [], skills: [], text: "Check permissions", textAttachments: [] },
      {
        model: "default",
        reasoningEffort: "",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxMode: "workspace-write",
        engineOptions: { engine: "antigravity" },
      },
    );
    acp.message({
      method: "session/request_permission",
      id: 17,
      params: {
        sessionId: "native-session",
        toolCall: { toolCallId: "native-tool", title: "Edit file" },
        options: [
          { kind: "allow_once", optionId: "approve-native" },
          { kind: "reject_once", optionId: "deny-native" },
          { kind: "allow_always", optionId: "persist-native" },
        ],
      },
    });
    const request = (await project.readTask(id))?.pendingRequests[0];
    expect(request?.availableDecisions).toEqual(["allow", "deny"]);
    if (!request) throw new Error("Missing approval");
    const decision = { ...request, resolution: { decision: "deny" as const } };
    await expect(
      project.resolvePendingRequest({ ...decision, itemId: "another-tool" }),
    ).rejects.toThrow();
    expect(acp.reply).not.toHaveBeenCalled();
    await project.resolvePendingRequest(decision);
    expect(acp.reply).toHaveBeenCalledWith(17, {
      outcome: { outcome: "selected", optionId: "deny-native" },
    });
    await project.interruptTurn(id, turn.id);
    expect(acp.cancel).toHaveBeenCalledWith("session/cancel", { sessionId: "native-session" });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("turn.completed"));
    expect((await project.readTask(id))?.turns[0]?.status).toBe("interrupted");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
