import { useEffect, useState } from "react";
import type { AgentEngine, AgentGlobalSettings, AgentModel } from "@codexly/protocol";
import { CLAUDE_MODEL_OPTIONS } from "@codexly/protocol";
import { useSelectedEngines } from "./engine-selection.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.js";

const defaults = { codex: "gpt-6-luna", claude: "haiku" } as const;
type GenerationEngine = keyof typeof defaults;
const fallbackEngines: readonly GenerationEngine[] = ["codex"];

/** 两端共用应用生成设置；只加载所选引擎的目录，不轮询、不逐模型探测。 */
export function DefaultGenerationSettings({
  settings,
  language,
  getModels,
  onChange,
}: Readonly<{
  settings: Pick<AgentGlobalSettings, "defaultAgent" | "defaultModel">;
  language: string;
  getModels: (engine: GenerationEngine) => Promise<readonly AgentModel[]>;
  onChange: (patch: { defaultAgent: AgentEngine; defaultModel: string }) => void;
}>) {
  const engines =
    useSelectedEngines()?.filter((value) => value !== "antigravity") ?? fallbackEngines;
  const engine =
    engines.find((value) => value === (settings.defaultAgent ?? "codex")) ?? engines[0] ?? "codex";
  const configuredModel =
    (settings.defaultAgent ?? "codex") === engine ? settings.defaultModel : defaults[engine];
  // Claude 的旧自定义值回落 Haiku，防止辅助生成的选择器重新补回已过滤的模型。
  const model =
    engine === "claude" && !CLAUDE_MODEL_OPTIONS.some((option) => option.id === configuredModel)
      ? defaults.claude
      : configuredModel;
  const [catalog, setCatalog] = useState<{ engine: AgentEngine; models: readonly AgentModel[] }>();
  useEffect(() => {
    if (!engines.length) return;
    let active = true;
    void getModels(engine)
      .then((models) => {
        if (active) setCatalog({ engine, models });
      })
      .catch(() => {
        if (active) setCatalog({ engine, models: [] });
      });
    return () => {
      active = false;
    };
  }, [engine, engines.length, getModels]);
  // 单引擎安装自动持久化其默认值，后端生成不再依赖当前聊天的引擎。
  useEffect(() => {
    if (engines.length && (settings.defaultAgent !== engine || settings.defaultModel !== model))
      onChange({ defaultAgent: engine, defaultModel: model });
  }, [engine, engines.length, model, settings.defaultAgent, settings.defaultModel, onChange]);
  if (!engines.length) return null;
  const zh = language.startsWith("zh");
  const models = catalog?.engine === engine ? catalog.models : [];
  const choices =
    engine === "claude"
      ? CLAUDE_MODEL_OPTIONS.filter(
          (option) => models.length === 0 || models.some((entry) => entry.id === option.id),
        )
      : models.some((item) => item.id === model)
        ? models
        : [{ id: model, displayName: model }, ...models];
  // 两端复用项目 Select 的触发器、弹层和键盘交互，仅在此约束设置项的宽度。
  const selectClass = "w-48 max-w-full text-body-small";
  return (
    <div className="divide-y divide-separator rounded-surface border border-separator bg-panel px-4">
      {engines.length > 1 ? (
        <div className="flex items-center justify-between gap-4 py-3">
          <span className="text-body-small font-medium">{zh ? "默认 Agent" : "Default agent"}</span>
          <Select
            value={engine}
            onValueChange={(value) => {
              const defaultAgent = value as GenerationEngine;
              onChange({ defaultAgent, defaultModel: defaults[defaultAgent] });
            }}
          >
            <SelectTrigger
              className={selectClass}
              size="sm"
              aria-label={zh ? "默认 Agent" : "Default agent"}
            >
              <SelectValue>{engine === "codex" ? "Codex" : "Claude"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {engines.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === "codex" ? "Codex" : "Claude"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-4 py-3">
        <span>
          <span className="text-body-small font-medium">{zh ? "默认模型" : "Default model"}</span>
          <span className="mt-1 block text-label text-muted-foreground">
            {zh
              ? "供本应用生成任务标题、Git 提交信息和优化输入提示词。"
              : "Used by this app to generate task titles, Git commit messages, and optimize prompts."}
          </span>
        </span>
        <Select
          value={model}
          onValueChange={(value) => {
            onChange({ defaultAgent: engine, defaultModel: value });
          }}
        >
          <SelectTrigger
            className={selectClass}
            size="sm"
            aria-label={zh ? "默认模型" : "Default model"}
          >
            <SelectValue>
              {choices.find((item) => item.id === model)?.displayName ?? model}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {choices.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
