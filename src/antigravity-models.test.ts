import { resolveAntigravitySelection } from "@codexly/protocol";
import { expect, it, vi } from "vitest";
import type { AntigravityAcp, AcpSession } from "./antigravity-acp.js";
import { applyAntigravitySelection, listAntigravityModels } from "./antigravity-models.js";

const session: AcpSession = {
  sessionId: "session",
  configOptions: [
    {
      id: "model",
      currentValue: "gemini-4-neon",
      options: [
        { value: "gemini-4-neon", name: "Gemini 4 Neon" },
        { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
      ],
    },
    {
      id: "thought_level",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ],
  models: {
    currentModelId: "gemini-4-neon-high",
    availableModels: [
      { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
      { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
      { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ],
  },
};

it("uses the native model list and keeps legacy choices and fixed model IDs", async () => {
  const request = vi.fn(async () => ({ configOptions: [session.configOptions![0]] }));
  const client = { request } as unknown as AntigravityAcp;
  const models = await listAntigravityModels(client, session);
  expect(models.map(({ id }) => id)).toEqual(["gemini-4-neon", "gpt-oss-120b-medium"]);
  expect(models[1]?.supportedReasoningEfforts).toEqual([]);
  expect(
    resolveAntigravitySelection(models, { model: "gemini-4-neon-low", reasoningEffort: "" }),
  ).toEqual({ model: "gemini-4-neon", reasoningEffort: "low" });
  expect(
    resolveAntigravitySelection(models, { model: "gpt-oss-120b-medium", reasoningEffort: "" }),
  ).toEqual({ model: "gpt-oss-120b-medium", reasoningEffort: "" });
});

it("applies the model before sending its selected thinking level", async () => {
  const request = vi.fn(async () => ({ configOptions: session.configOptions }));
  const client = { request } as unknown as AntigravityAcp;
  await applyAntigravitySelection(
    client,
    session.sessionId,
    [{ ...session.configOptions![0]!, currentValue: "gpt-oss-120b-medium" }],
    { model: "gemini-4-neon", reasoningEffort: "low" },
  );
  expect(request.mock.calls).toEqual([
    [
      "session/set_config_option",
      { sessionId: "session", configId: "model", value: "gemini-4-neon" },
    ],
    [
      "session/set_config_option",
      { sessionId: "session", configId: "thought_level", value: "low" },
    ],
  ]);
});
