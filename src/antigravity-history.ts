import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AntigravitySessionRecoveryError, type AgentTaskScope } from "@codexly/core";
import type { AgentTurn, AntigravitySessionPage } from "@codexly/protocol";
import { AntigravityAcp, object, string, type AcpSession } from "./antigravity-acp.js";

export const antigravityMissingSessionHelp =
  "Antigravity CLI 找不到该会话。请先在 agy 的 /resume 中导入客户端会话，再在网页的 /resume 中选择 CLI 副本。";

export class AntigravitySessionMissingError extends AntigravitySessionRecoveryError {
  constructor() {
    super(antigravityMissingSessionHelp);
  }
}

export function isMissingAntigravitySession(error: unknown) {
  return (
    error instanceof Error && /(?:^Session not found:|\btrajectory not found:)/i.test(error.message)
  );
}

type NativePage = {
  sessions: { sessionId: string; cwd: string; title?: string; updatedAt?: string }[];
  nextCursor?: string;
};

function within(root: string, cwd: string) {
  const path = relative(root, cwd);
  return path === "" || (!isAbsolute(path) && !/^\.\.(?:[\\/]|$)/.test(path));
}

export function antigravitySessionPath(path: string, windows = process.platform === "win32") {
  // agy 1.5 emits escaped URI paths such as /D:/hello%20world on Windows.
  try {
    if (path.startsWith("file:")) return fileURLToPath(path, { windows });
    if (windows && /^\/[A-Za-z]%3a\//i.test(path))
      return fileURLToPath(`file:///${path.slice(1).replace(/^([A-Za-z])%3a/i, "$1:")}`, {
        windows: true,
      });
    if (windows && /^\/[A-Za-z]:\//.test(path))
      return fileURLToPath(`file://${path}`, { windows: true });
    return path;
  } catch {
    return "";
  }
}

export async function listAntigravitySessions(
  environment: NodeJS.ProcessEnv,
  scope: AgentTaskScope,
  workspaceRoots: readonly string[],
  cursor?: string,
): Promise<AntigravitySessionPage> {
  const client = new AntigravityAcp(scope.rootPath, environment);
  try {
    await client.initialize();
    const page = await client.request<NativePage>("session/list", {
      cwd: scope.rootPath,
      ...(cursor ? { cursor } : {}),
    });
    return {
      data: page.sessions.flatMap((session) => {
        const { sessionId } = session;
        const cwd = antigravitySessionPath(session.cwd || "");
        if (!sessionId || !cwd || !isAbsolute(cwd)) return [];
        if (workspaceRoots.length && !workspaceRoots.some((root) => within(root, cwd))) return [];
        if (
          scope.kind === "project" &&
          !scope.runtimeWorkspaceRoots.some((root) => within(root, cwd))
        )
          return [];
        return [
          {
            id: sessionId,
            cwd,
            title: session.title?.trim() || "",
            updatedAt: session.updatedAt ?? "",
          },
        ];
      }),
      nextCursor: page.nextCursor ?? null,
    };
  } finally {
    client.stop();
  }
}

export async function antigravityHistoryWorkspace(
  scope: AgentTaskScope,
  workspaceRoots: readonly string[],
  cwd: string,
): Promise<string> {
  const actual = await realpath(cwd);
  if (!(await stat(actual)).isDirectory()) throw new Error("Antigravity workspace is unavailable");
  const assertRoots = async (roots: readonly string[]) => {
    const paths = await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)));
    if (roots.length && !paths.some((root) => root && within(root, actual)))
      throw new Error("Antigravity workspace is outside the selected scope");
  };
  await assertRoots(workspaceRoots);
  if (scope.kind === "project") await assertRoots(scope.runtimeWorkspaceRoots);
  return actual;
}

export async function readAntigravityHistory(
  environment: NodeJS.ProcessEnv,
  actual: string,
  sessionId: string,
): Promise<AgentTurn[]> {
  const client = new AntigravityAcp(actual, environment);
  const turns: AgentTurn[] = [];
  const base = Date.now();
  try {
    await client.initialize();
    client.onMessage = (message) => {
      const { method, params: rawParams, id } = message;
      if (typeof id === "number" || typeof id === "string") {
        client.rejectMethod(id);
        return;
      }
      const { sessionId: eventSession, update: rawUpdate } = object(rawParams);
      if (method !== "session/update" || eventSession !== sessionId) return;
      const { sessionUpdate, content } = object(rawUpdate);
      const role =
        sessionUpdate === "user_message_chunk"
          ? "user"
          : sessionUpdate === "agent_message_chunk"
            ? "assistant"
            : undefined;
      const text = string(object(content)["text"]);
      if (!role || !text) return;
      let turn = turns.at(-1);
      let prior = turn?.items.at(-1);
      if (!turn || (role === "user" && prior?.type === "message" && prior.role === "assistant")) {
        turn = {
          id: `${base + turns.length}-${randomUUID()}`,
          items: [],
          status: "completed",
          error: null,
          startedAt: null,
          completedAt: null,
          forkable: false,
        };
        turns.push(turn);
        prior = undefined;
      }
      if (prior?.type === "message" && prior.role === role) prior.text += text;
      else turn.items.push({ id: randomUUID(), role, text, type: "message" });
    };
    try {
      const loaded = await client.request<AcpSession>("session/load", {
        cwd: actual,
        sessionId,
        mcpServers: [],
      });
      // session/load may omit the session ID in a standard ACP response.
      if (loaded.sessionId && loaded.sessionId !== sessionId)
        throw new AntigravitySessionRecoveryError("Antigravity CLI 返回了不同的会话 ID。");
    } catch (error) {
      if (isMissingAntigravitySession(error)) throw new AntigravitySessionMissingError();
      throw error;
    }
    return turns;
  } finally {
    client.stop();
  }
}
