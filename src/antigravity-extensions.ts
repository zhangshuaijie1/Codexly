import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AgentTaskScope } from "@codexly/core";
import type {
  ClaudeExtension,
  ClaudeExtensionKind,
  ClaudeExtensionMutation,
} from "@codexly/protocol";
import { object, string } from "./antigravity-acp.js";

const run = promisify(execFile);
const disabledSkill = "SKILL.md.codexly-disabled";
const digest = (...parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
type Entry = { row: ClaudeExtension; file?: string; nativeName?: string };

async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function regularFile(path: string) {
  return (
    (
      await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      })
    )?.isFile() === true
  );
}

export class AntigravityExtensions {
  readonly #gemini: string;
  #pending = Promise.resolve();

  constructor(readonly environment: NodeJS.ProcessEnv) {
    this.#gemini = join(environment["USERPROFILE"] || environment["HOME"] || homedir(), ".gemini");
  }

  async #native(args: string[], cwd: string) {
    try {
      const result = await run(this.environment["CODEXLY_AGY_PATH"] || "agy", args, {
        cwd,
        env: this.environment,
        windowsHide: true,
        timeout: 25_000,
        maxBuffer: 2_000_000,
      });
      return result.stdout;
    } catch {
      throw new Error("Antigravity CLI 扩展命令执行失败");
    }
  }

  async #skills(scope?: AgentTaskScope): Promise<Entry[]> {
    const result = object(
      JSON.parse(
        await this.#native(
          ["-p", "/skills", "--output-format", "json"],
          scope?.rootPath ?? homedir(),
        ),
      ),
    );
    if (result["command"] === undefined) throw new Error("Antigravity CLI 未返回原生 Skills 列表");
    const active = new Map<string, { name: string; description: string }>();
    let current: { name: string; description: string } | undefined;
    for (const line of string(result["response"]).split(/\r?\n/u)) {
      const separator = line.indexOf("\t");
      if (separator > 0) {
        const name = line.slice(0, separator).trim();
        current = { name, description: line.slice(separator + 1).trim() };
        active.set(name.toLowerCase(), current);
      } else if (current && line.trim()) {
        current.description += " " + line.trim();
      }
    }
    const entries: Entry[] = [];
    const paths = scope
      ? scope.runtimeWorkspaceRoots.map((root) => join(root, ".agents", "skills"))
      : [
          join(this.#gemini, "antigravity-cli", "skills"),
          join(this.#gemini, "skills"),
          join(this.#gemini, "config", "skills"),
          join(this.#gemini, "antigravity", "skills"),
        ];
    const skillScope = scope ? "project" : "user";
    const visited = new Set<string>();
    const scan = async (folder: string, depth: number) => {
      if (
        depth > 5 ||
        visited.has(folder) ||
        !(await lstat(folder).catch(() => undefined))?.isDirectory()
      )
        return;
      visited.add(folder);
      const enabled = await regularFile(join(folder, "SKILL.md"));
      const disabled = await regularFile(join(folder, disabledSkill));
      if (enabled || disabled) {
        const file = join(folder, enabled ? "SKILL.md" : disabledSkill);
        const markdown = ((await readOptional(file)) ?? "").slice(0, 16_384);
        const metadata =
          markdown.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1] ?? "";
        const name =
          metadata.match(/^name:\s*(.*?)\s*$/mu)?.[1]?.replace(/^['"]|['"]$/gu, "") ||
          basename(folder);
        const key = [name.toLowerCase(), basename(folder).toLowerCase()].find((value) =>
          active.has(value),
        );
        const loaded = key ? active.get(key) : undefined;
        if (key) active.delete(key);
        if (!enabled || loaded)
          entries.push({
            file: folder,
            row: {
              id: digest("skill", folder),
              name: loaded?.name ?? name,
              path: file,
              description: loaded?.description ?? "",
              scope: skillScope,
              installed: true,
              mutable: !(enabled && disabled),
              enabled,
            },
          });
        return;
      }
      for (const child of await readdir(folder, { withFileTypes: true }))
        if (child.isDirectory() && !child.name.startsWith("."))
          await scan(join(folder, child.name), depth + 1);
    };
    for (const path of paths) await scan(path, 0);
    const managed: Entry[] = [...active.values()].map(({ name, description }) => ({
      row: {
        id: digest("managed-skill", name),
        name,
        description,
        scope: "managed",
        installed: true,
        mutable: false,
        enabled: true,
      },
    }));
    return [...entries, ...managed];
  }

  async #mcps(scope?: AgentTaskScope): Promise<Entry[]> {
    const files = scope
      ? scope.runtimeWorkspaceRoots.map((root) => join(root, ".agents", "mcp_config.json"))
      : [join(this.#gemini, "config", "mcp_config.json")];
    const entries: Entry[] = [];
    for (const file of new Set(files)) {
      const contents = await readOptional(file);
      if (contents === undefined) continue;
      const servers = object(object(JSON.parse(contents))["mcpServers"]);
      const mutable = await regularFile(file);
      for (const [name, value] of Object.entries(servers)) {
        const server = object(value);
        const transport = typeof server["command"] === "string" ? "stdio" : "HTTP";
        entries.push({
          file,
          nativeName: name,
          row: {
            id: digest("mcp", file, name),
            name,
            description: transport,
            enabled: server["disabled"] !== true,
            installed: true,
            mutable,
            scope: scope ? "project" : "user",
            path: file,
          },
        });
      }
    }
    for (const plugin of await this.#plugins(scope)) {
      for (const name of plugin.mcpServers)
        entries.push({
          row: {
            id: digest("plugin-mcp", plugin.row.name, name),
            name: `${plugin.row.name}_${name}`,
            description: plugin.row.name,
            enabled: plugin.row.enabled,
            installed: true,
            mutable: false,
            scope: "managed",
          },
        });
    }
    return entries;
  }

  async #plugins(scope?: AgentTaskScope): Promise<(Entry & { mcpServers: string[] })[]> {
    const value: unknown = JSON.parse(
      await this.#native(["plugin", "list", "--json"], scope?.rootPath ?? homedir()),
    );
    return (Array.isArray(value) ? value : []).flatMap((value) => {
      const { name, enabled, version, mcpServers } = object(value);
      if (typeof name !== "string" || !name) return [];
      return [
        {
          nativeName: name,
          mcpServers: (Array.isArray(mcpServers) ? mcpServers : []).flatMap((server) => {
            const name = string(server) || string(object(server)["name"]);
            return name ? [name] : [];
          }),
          row: {
            id: digest("plugin", name),
            name,
            description: "Antigravity CLI",
            enabled: enabled === true,
            installed: true,
            mutable: !name.startsWith("-"),
            scope: "user",
            ...(typeof version === "string" && version ? { version } : {}),
          },
        },
      ];
    });
  }

  async #list(kind: ClaudeExtensionKind, scope?: AgentTaskScope) {
    if (kind === "skills") return this.#skills(scope);
    if (kind === "mcp") return this.#mcps(scope);
    return this.#plugins(scope);
  }

  async list(kind: ClaudeExtensionKind, scope?: AgentTaskScope) {
    return { data: (await this.#list(kind, scope)).map(({ row }) => row) };
  }

  mutate(input: ClaudeExtensionMutation, scope?: AgentTaskScope) {
    const transaction = this.#pending.then(async () => {
      if (input.action !== "enable" && input.action !== "disable")
        throw new Error("Antigravity 扩展仅支持启用和停用");
      const entries = await this.#list(input.kind, scope);
      const entry = entries.find(({ row }) => row.id === input.id && row.scope === input.scope);
      if (!entry?.row.mutable) throw new Error("找不到可修改的 Antigravity 扩展");
      const enabled = input.action === "enable";
      if (entry.row.enabled === enabled) return { data: entries.map(({ row }) => row) };
      if (input.kind === "skills" && entry.file) {
        const source = join(entry.file, enabled ? disabledSkill : "SKILL.md");
        const target = join(entry.file, enabled ? "SKILL.md" : disabledSkill);
        if (!(await regularFile(source)) || (await lstat(target).catch(() => undefined)))
          throw new Error("Skill 文件已变化，请刷新后重试");
        await rename(source, target);
      } else if (input.kind === "mcp" && entry.file && entry.nativeName) {
        await this.#setMcp(entry.file, entry.nativeName, enabled);
      } else if (input.kind === "plugins" && entry.nativeName) {
        await this.#native(
          ["plugin", input.action, entry.nativeName],
          scope?.rootPath ?? homedir(),
        );
      }
      return this.list(input.kind, scope);
    });
    this.#pending = transaction.then(
      () => undefined,
      () => undefined,
    );
    return transaction;
  }

  async #setMcp(path: string, name: string, enabled: boolean) {
    const original = await readOptional(path);
    if (original === undefined || !(await regularFile(path))) throw new Error("MCP 配置已变化");
    const config = object(JSON.parse(original));
    const servers = object(config["mcpServers"]);
    if (!Object.hasOwn(servers, name)) throw new Error("找不到 MCP 配置");
    const server = object(servers[name]);
    server["disabled"] = !enabled;
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      if ((await readOptional(path)) !== original || !(await regularFile(path)))
        throw new Error("MCP 配置已被其他程序更改，请刷新后重试");
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
