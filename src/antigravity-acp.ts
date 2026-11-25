import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type AcpObject = Record<string, unknown>;
export const object = (value: unknown): AcpObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as AcpObject) : {};

export const string = (value: unknown) => (typeof value === "string" ? value : "");

export interface AcpConfigOption {
  id: string;
  category?: string;
  currentValue: string;
  options?: { value: string; name: string; description?: string }[];
}

export interface AcpSession {
  sessionId: string;
  models?: {
    currentModelId: string;
    availableModels: { modelId: string; name: string; description?: string }[];
  };
  configOptions?: AcpConfigOption[];
}

/** ACP uses one JSON-RPC message per line over stdio. */
export class AntigravityAcp {
  readonly #child;
  readonly #requests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #nextId = 0;
  #failure: Error | undefined;
  onMessage: (message: AcpObject) => void = () => undefined;

  constructor(cwd: string, env: NodeJS.ProcessEnv) {
    this.#child = spawn(env["CODEXLY_AGY_PATH"] || "agy", ["acp"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.#child.on("error", (error: NodeJS.ErrnoException) => {
      this.#fail(
        error.code === "ENOENT"
          ? new Error("找不到 Antigravity CLI。请安装 agy 或设置 CODEXLY_AGY_PATH。")
          : error,
      );
    });
    this.#child.stdin.on("error", (error) => this.#fail(error));
    this.#child.on("exit", () => this.#fail(new Error("Antigravity CLI 已退出")));
    createInterface({ input: this.#child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      try {
        const message = object(JSON.parse(line));
        const { method, id, error, result } = message;
        if (typeof method === "string") {
          this.onMessage(message);
          return;
        }
        if (typeof id !== "number") return;
        const request = this.#requests.get(id);
        if (!request) return;
        this.#requests.delete(id);
        if (error)
          request.reject(new Error(string(object(error)["message"]) || "Antigravity 请求失败"));
        else request.resolve(result);
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error("无效的 Antigravity ACP 消息"));
        this.#child.kill();
      }
    });
  }

  #fail(error: Error) {
    this.#failure ??= error;
    for (const request of this.#requests.values()) request.reject(this.#failure);
    this.#requests.clear();
  }

  #write(message: AcpObject) {
    if (this.#failure) throw this.#failure;
    this.#child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  async request<T>(method: string, params: AcpObject, timeoutMs = 25_000): Promise<T> {
    const id = ++this.#nextId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        this.#requests.set(id, { resolve: (value) => resolve(value as T), reject });
        if (timeoutMs)
          timer = setTimeout(() => reject(new Error(`Antigravity ${method} 超时`)), timeoutMs);
        this.#write({ id, method, params });
      });
    } finally {
      clearTimeout(timer);
      this.#requests.delete(id);
    }
  }

  notify(method: string, params: AcpObject) {
    this.#write({ method, params });
  }

  reply(id: string | number, result: AcpObject) {
    this.#write({ id, result });
  }

  rejectMethod(id: string | number) {
    this.#write({ id, error: { code: -32601, message: "Unsupported ACP client method" } });
  }

  async initialize() {
    const result = await this.request<{ protocolVersion: number }>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    if (result.protocolVersion !== 1) throw new Error("Antigravity ACP 协议版本不兼容");
  }

  stop() {
    this.#fail(new Error("Antigravity CLI 已停止"));
    this.#child.kill();
  }
}
