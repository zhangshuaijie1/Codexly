import {
  AgentEngineProfileSchema,
  AgentTaskSchema,
  AntigravitySessionPageSchema,
  type AgentTask,
  type AntigravitySessionPage,
  AntigravityDefaultsSchema,
  AntigravityConfigSchema,
  type AntigravityConfig,
  type AntigravityDefaults,
  ClaudeSettingsSchema,
  ConfigureCustomProviderResponseSchema,
  AgentProviderConnectionMutationResponseSchema,
  AgentMutationErrorSchema,
  ClaudeExtensionPageSchema,
  type ClaudeExtensionPage,
  type ClaudeExtensionKind,
  type ClaudeExtensionMutation,
  type ClaudeSettings,
  type AgentEngine,
  type AgentEngineProfile,
  type ConfigureCustomProviderRequest,
  type ConfigureCustomProviderResponse,
  type AgentProviderConnectionMutationResponse,
} from "@codexly/protocol";
import { CodexlyTransport } from "./http-client-transport.js";
import type { ReadOptions, MutationOptions } from "./http-client-transport.js";

export class EngineHttpClient extends CodexlyTransport {
  public getAntigravityConfig(): Promise<AntigravityConfig> {
    return this.read("/v1/engines/antigravity/config", AntigravityConfigSchema, {});
  }
  public updateAntigravityConfig(config: AntigravityConfig): Promise<AntigravityConfig> {
    return this.mutation(
      "/v1/engines/antigravity/config",
      config,
      AntigravityConfigSchema,
      {},
      "PUT",
    );
  }
  public listAntigravitySessions(
    projectId: string,
    cursor?: string,
  ): Promise<AntigravitySessionPage> {
    const query = new URLSearchParams({ projectId, ...(cursor ? { cursor } : {}) });
    return this.request(
      `/v1/engines/antigravity/sessions?${query}`,
      AntigravitySessionPageSchema,
      {},
      AgentMutationErrorSchema,
      { timeoutMs: 45_000 },
    );
  }

  public resumeAntigravitySession(
    projectId: string,
    sessionId: string,
    taskId?: string,
  ): Promise<AgentTask> {
    return this.mutation(
      "/v1/engines/antigravity/resume",
      { projectId, sessionId, ...(taskId ? { taskId } : {}) },
      AgentTaskSchema,
      {},
      "POST",
      90_000,
    );
  }

  public listAntigravityExtensions(
    kind: ClaudeExtensionKind,
    projectId?: string,
  ): Promise<ClaudeExtensionPage> {
    const query = new URLSearchParams({ kind, ...(projectId ? { projectId } : {}) });
    return this.request(
      `/v1/engines/antigravity/extensions?${query}`,
      ClaudeExtensionPageSchema,
      {},
      AgentMutationErrorSchema,
      { timeoutMs: 40_000 },
    );
  }

  public mutateAntigravityExtension(
    input: ClaudeExtensionMutation,
    projectId?: string,
  ): Promise<ClaudeExtensionPage> {
    const query = new URLSearchParams(projectId ? { projectId } : {});
    return this.mutation(
      `/v1/engines/antigravity/extensions?${query}`,
      input,
      ClaudeExtensionPageSchema,
      {},
      "POST",
      90_000,
    );
  }
  public listClaudeExtensions(
    kind: ClaudeExtensionKind,
    projectId?: string,
  ): Promise<ClaudeExtensionPage> {
    const query = new URLSearchParams({ kind, ...(projectId ? { projectId } : {}) });
    return this.request(
      `/v1/engines/claude/extensions?${query}`,
      ClaudeExtensionPageSchema,
      {},
      AgentMutationErrorSchema,
      { timeoutMs: 45_000 },
    );
  }
  public mutateClaudeExtension(
    input: ClaudeExtensionMutation,
    projectId?: string,
  ): Promise<ClaudeExtensionPage> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return this.mutation(
      `/v1/engines/claude/extensions${query}`,
      input,
      ClaudeExtensionPageSchema,
      {},
      "POST",
      120_000,
    );
  }
  public getClaudeSettings(options: ReadOptions = {}): Promise<ClaudeSettings> {
    return this.read("/v1/engines/claude/settings", ClaudeSettingsSchema, options);
  }

  public updateClaudeSettings(
    settings: ClaudeSettings,
    options: MutationOptions = {},
  ): Promise<ClaudeSettings> {
    return this.mutation(
      "/v1/engines/claude/settings",
      settings,
      ClaudeSettingsSchema,
      options,
      "PUT",
    );
  }
  public async getEngineProfile(
    engine: AgentEngine,
    projectId?: string,
    options: ReadOptions & { refresh?: true } = {},
  ): Promise<AgentEngineProfile> {
    const query = new URLSearchParams();
    if (projectId) query.set("projectId", projectId);
    if (options.refresh) query.set("refresh", "true");
    const parameters = query.size ? `?${query}` : "";
    return this.read(`/v1/engines/${engine}${parameters}`, AgentEngineProfileSchema, options);
  }

  public updateAntigravityDefaults(
    defaults: AntigravityDefaults,
    options: MutationOptions = {},
  ): Promise<AntigravityDefaults> {
    return this.mutation(
      "/v1/engines/antigravity/defaults",
      defaults,
      AntigravityDefaultsSchema,
      options,
      "PUT",
    );
  }

  public async configureEngine(
    engine: AgentEngine,
    input: ConfigureCustomProviderRequest,
    options: MutationOptions = {},
  ): Promise<ConfigureCustomProviderResponse> {
    return this.mutation(
      `/v1/engines/${engine}/connection`,
      input,
      ConfigureCustomProviderResponseSchema,
      options,
      "PUT",
    );
  }

  public async disconnectEngine(
    engine: AgentEngine,
    options: MutationOptions = {},
  ): Promise<AgentProviderConnectionMutationResponse> {
    return this.mutation(
      `/v1/engines/${engine}/connection`,
      undefined,
      AgentProviderConnectionMutationResponseSchema,
      options,
      "DELETE",
    );
  }
}
