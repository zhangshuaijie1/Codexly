import type { AgentModel, AntigravityDefaults } from "@codexly/protocol";
import type { AntigravityAcp, AcpConfigOption, AcpSession } from "./antigravity-acp.js";

export async function listAntigravityModels(client: AntigravityAcp, session: AcpSession) {
  const modelOption = session.configOptions?.find((option) => option.id === "model");
  if (!modelOption?.options?.length) {
    return (
      session.models?.availableModels.map((model): AgentModel => ({
        id: model.modelId,
        displayName: model.name || model.modelId,
        description: model.description ?? "",
        isDefault: model.modelId === session.models?.currentModelId,
        defaultReasoningEffort: "",
        supportedReasoningEfforts: [],
        inputModalities: ["text", "image"],
      })) ?? []
    );
  }
  const models: AgentModel[] = [];
  const initialEffort = session.configOptions?.find(
    (option) => option.id === "thought_level",
  )?.currentValue;
  for (const model of modelOption.options) {
    const isDefault = model.value === modelOption.currentValue;
    const config = isDefault
      ? session
      : await client.request<AcpSession>(
          "session/set_config_option",
          {
            sessionId: session.sessionId,
            configId: modelOption.id,
            value: model.value,
          },
          4_000,
        );
    const thought = config.configOptions?.find((option) => option.id === "thought_level");
    const supportedReasoningEfforts =
      thought?.options?.map((option) => ({
        id: option.value,
        description: option.description ?? option.name,
      })) ?? [];
    models.push({
      id: model.value,
      displayName: model.name,
      description: model.description ?? "",
      isDefault,
      defaultReasoningEffort: supportedReasoningEfforts.some(({ id }) => id === initialEffort)
        ? initialEffort!
        : (thought?.currentValue ?? ""),
      supportedReasoningEfforts,
      inputModalities: ["text", "image"],
    });
  }
  return models;
}

export async function applyAntigravitySelection(
  client: AntigravityAcp,
  sessionId: string,
  configOptions: AcpConfigOption[] | undefined,
  selection: AntigravityDefaults,
) {
  if (!selection.model || selection.model === "default") return;
  const model = configOptions?.find((option) => option.id === "model");
  if (!model?.options?.some((option) => option.value === selection.model)) {
    await client.request("session/set_model", { sessionId, modelId: selection.model });
    return;
  }
  const config =
    model.currentValue === selection.model
      ? { configOptions }
      : await client.request<AcpSession>("session/set_config_option", {
          sessionId,
          configId: model.id,
          value: selection.model,
        });
  const effort = config.configOptions?.find((option) => option.id === "thought_level");
  if (selection.reasoningEffort && effort?.currentValue !== selection.reasoningEffort) {
    if (!effort?.options?.some((option) => option.value === selection.reasoningEffort))
      throw new Error("当前 Antigravity 模型不支持所选思考程度");
    await client.request("session/set_config_option", {
      sessionId,
      configId: effort.id,
      value: selection.reasoningEffort,
    });
  }
}
