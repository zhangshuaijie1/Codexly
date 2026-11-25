import { Type } from "@sinclair/typebox";
import { AntigravitySessionRecoveryError } from "@codexly/core";
import {
  AgentEngineSchema,
  AgentEngineProfileSchema,
  AgentTaskSchema,
  AntigravitySessionPageSchema,
  AntigravitySessionIdSchema,
  AntigravityDefaultsSchema,
  AntigravityConfigSchema,
  type AntigravityConfig,
  type AntigravityDefaults,
  ClaudeSettingsSchema,
  AgentProviderConnectionMutationResponseSchema,
  ConfigureCustomProviderRequestSchema,
  ConfigureCustomProviderResponseSchema,
  ClaudeExtensionKindSchema,
  ClaudeExtensionMutationSchema,
  ClaudeExtensionPageSchema,
  type ClaudeExtensionKind,
  type ClaudeExtensionMutation,
  type AgentEngine,
  type ClaudeSettings,
  type ConfigureCustomProviderRequest,
} from "@codexly/protocol";
import type { FastifyPluginCallback } from "fastify";
import { MutationHttpError, type ServerRouteContext } from "./context.js";
import { IdempotencyHeadersSchema } from "./schemas.js";

const Params = Type.Object({ engine: AgentEngineSchema }, { additionalProperties: false });

export const registerEngineRoutes: FastifyPluginCallback<ServerRouteContext> = (
  app,
  context,
  done,
) => {
  const service = (engine: AgentEngine) => {
    const value = context.provider.engines?.[engine];
    if (!value) throw new MutationHttpError("PROVIDER_ERROR", "Engine is unavailable", 503);
    return value;
  };
  const projectQuery = Type.Object(
    { projectId: Type.Optional(Type.String({ minLength: 1 })) },
    { additionalProperties: false },
  );
  app.get(
    "/v1/engines/antigravity/config",
    { schema: { response: { 200: AntigravityConfigSchema } } },
    async () => {
      const read = service("antigravity").readAntigravityConfig;
      if (!read)
        throw new MutationHttpError("PROVIDER_ERROR", "Antigravity configuration unavailable", 503);
      return read();
    },
  );
  app.put<{ Body: AntigravityConfig; Headers: { "idempotency-key": string } }>(
    "/v1/engines/antigravity/config",
    {
      schema: {
        body: AntigravityConfigSchema,
        headers: IdempotencyHeadersSchema,
        response: { 200: AntigravityConfigSchema },
      },
    },
    async (request) => {
      const write = service("antigravity").writeAntigravityConfig;
      if (!write)
        throw new MutationHttpError("PROVIDER_ERROR", "Antigravity configuration unavailable", 503);
      return context.runIdempotent(
        ["antigravity-config"],
        request.headers["idempotency-key"],
        request.body,
        () => write(request.body),
      );
    },
  );
  app.put<{ Body: AntigravityDefaults; Headers: { "idempotency-key": string } }>(
    "/v1/engines/antigravity/defaults",
    {
      schema: {
        headers: IdempotencyHeadersSchema,
        body: AntigravityDefaultsSchema,
        response: { 200: AntigravityDefaultsSchema },
      },
    },
    (request) =>
      context.runIdempotent(
        ["antigravity-defaults"],
        request.headers["idempotency-key"],
        request.body,
        async () => {
          const antigravity = service("antigravity");
          const save = antigravity.writeAntigravityDefaults;
          if (!save)
            throw new MutationHttpError("PROVIDER_ERROR", "Antigravity is unavailable", 503);
          const profile = await antigravity.inspect();
          context.assertValidProjectDefaults(profile.models.data, {
            ...request.body,
            sandboxMode: "workspace-write",
          });
          return save.call(antigravity, request.body);
        },
      ),
  );
  const extensionScope = async (projectId?: string) => {
    if (!projectId) return undefined;
    const project = await context.getProjectContext(projectId);
    if (!project) throw new MutationHttpError("PROJECT_NOT_FOUND", "Project not found", 404);
    return project.scope;
  };
  const recoveryProject = Type.String({ minLength: 1 });
  app.get<{ Querystring: { projectId: string; cursor?: string } }>(
    "/v1/engines/antigravity/sessions",
    {
      schema: {
        querystring: Type.Object({
          projectId: recoveryProject,
          cursor: Type.Optional(Type.String({ maxLength: 8192 })),
        }),
        response: { 200: AntigravitySessionPageSchema },
      },
    },
    async (request) => {
      const engine = service("antigravity");
      const scope = await extensionScope(request.query.projectId);
      if (!scope || !engine.listAntigravitySessions)
        throw new MutationHttpError(
          "PROVIDER_ERROR",
          "Antigravity session listing is unavailable",
          503,
        );
      return engine.listAntigravitySessions(scope, request.query.cursor);
    },
  );
  app.post<{
    Body: { projectId: string; sessionId: string; taskId?: string };
    Headers: { "idempotency-key": string };
  }>(
    "/v1/engines/antigravity/resume",
    {
      schema: {
        body: Type.Object(
          {
            projectId: recoveryProject,
            sessionId: AntigravitySessionIdSchema,
            taskId: Type.Optional(Type.String({ pattern: "^task-[a-f0-9-]{36}$" })),
          },
          { additionalProperties: false },
        ),
        headers: IdempotencyHeadersSchema,
        response: { 200: AgentTaskSchema },
      },
    },
    async (request) => {
      const engine = service("antigravity");
      const scope = await extensionScope(request.body.projectId);
      const resume = engine.resumeAntigravitySession?.bind(engine);
      if (!scope || !resume)
        throw new MutationHttpError(
          "PROVIDER_ERROR",
          "Antigravity session recovery is unavailable",
          503,
        );
      return context.runIdempotent(
        ["antigravity-resume", scope.id],
        request.headers["idempotency-key"],
        request.body,
        async () => {
          try {
            return await resume(scope, request.body.sessionId, request.body.taskId);
          } catch (error) {
            if (error instanceof AntigravitySessionRecoveryError)
              throw new MutationHttpError("PROVIDER_ERROR", error.message, 409);
            throw error;
          }
        },
      );
    },
  );
  const extensionParams = Type.Object({
    engine: Type.Union([Type.Literal("claude"), Type.Literal("antigravity")]),
  });
  app.get<{
    Params: { engine: "claude" | "antigravity" };
    Querystring: { kind: ClaudeExtensionKind; projectId?: string };
  }>(
    "/v1/engines/:engine/extensions",
    {
      schema: {
        params: extensionParams,
        querystring: Type.Object(
          { ...projectQuery.properties, kind: ClaudeExtensionKindSchema },
          { additionalProperties: false },
        ),
        response: { 200: ClaudeExtensionPageSchema },
      },
    },
    async (request) => {
      const engine = service(request.params.engine);
      if (!engine.listExtensions)
        throw new MutationHttpError("PROVIDER_ERROR", "Extension management is unavailable", 503);
      return engine.listExtensions(
        request.query.kind,
        await extensionScope(request.query.projectId),
      );
    },
  );
  app.post<{
    Params: { engine: "claude" | "antigravity" };
    Querystring: { projectId?: string };
    Body: ClaudeExtensionMutation;
    Headers: { "idempotency-key": string };
  }>(
    "/v1/engines/:engine/extensions",
    {
      schema: {
        params: extensionParams,
        querystring: projectQuery,
        body: ClaudeExtensionMutationSchema,
        headers: IdempotencyHeadersSchema,
        response: { 200: ClaudeExtensionPageSchema },
      },
    },
    async (request) => {
      const engine = service(request.params.engine),
        scope = await extensionScope(request.query.projectId);
      const mutateExtension = engine.mutateExtension?.bind(engine);
      if (!mutateExtension)
        throw new MutationHttpError("PROVIDER_ERROR", "Extension management is unavailable", 503);
      return context.runIdempotent(
        [`${request.params.engine}-extension`, scope?.id ?? "user"],
        request.headers["idempotency-key"],
        request.body,
        () => mutateExtension(request.body, scope),
      );
    },
  );
  app.get<{ Params: { engine: AgentEngine } }>(
    "/v1/engines/:engine/settings",
    { schema: { params: Params, response: { 200: ClaudeSettingsSchema } } },
    (request) => service(request.params.engine).readSettings(),
  );
  app.put<{
    Params: { engine: AgentEngine };
    Body: ClaudeSettings;
    Headers: { "idempotency-key": string };
  }>(
    "/v1/engines/:engine/settings",
    {
      schema: {
        params: Params,
        headers: IdempotencyHeadersSchema,
        body: ClaudeSettingsSchema,
        response: { 200: ClaudeSettingsSchema },
      },
    },
    (request) =>
      context.runIdempotent(
        ["engine-settings", request.params.engine],
        request.headers["idempotency-key"],
        request.body,
        () => service(request.params.engine).writeSettings(request.body),
      ),
  );
  app.get<{
    Params: { engine: AgentEngine };
    Querystring: { projectId?: string; refresh?: boolean };
  }>(
    "/v1/engines/:engine",
    {
      schema: {
        params: Params,
        querystring: Type.Object(
          {
            projectId: Type.Optional(Type.String({ minLength: 1 })),
            refresh: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: { 200: AgentEngineProfileSchema },
      },
    },
    async (request) => {
      const scope = request.query.projectId
        ? (await context.getProjectContext(request.query.projectId))?.scope
        : undefined;
      if (request.query.projectId && !scope)
        throw new MutationHttpError("PROJECT_NOT_FOUND", "Project not found", 404);
      if (request.params.engine === "codex")
        return {
          engine: "codex",
          capabilities: context.capabilities,
          models: await context.modelCatalogCache.read(),
          commands: [],
          connection: await context.provider.readProviderConnection(),
        };
      return service(request.params.engine).inspect(scope, request.query.refresh);
    },
  );
  app.put<{
    Params: { engine: AgentEngine };
    Headers: { "idempotency-key": string };
    Body: ConfigureCustomProviderRequest;
  }>(
    "/v1/engines/:engine/connection",
    {
      schema: {
        params: Params,
        headers: IdempotencyHeadersSchema,
        body: ConfigureCustomProviderRequestSchema,
        response: { 200: ConfigureCustomProviderResponseSchema },
      },
    },
    (request) =>
      context.runIdempotent(
        ["configure-engine", request.params.engine],
        request.headers["idempotency-key"],
        request.body,
        () => service(request.params.engine).configure(request.body),
      ),
  );
  app.delete<{ Params: { engine: AgentEngine }; Headers: { "idempotency-key": string } }>(
    "/v1/engines/:engine/connection",
    {
      schema: {
        params: Params,
        headers: IdempotencyHeadersSchema,
        response: { 200: AgentProviderConnectionMutationResponseSchema },
      },
    },
    (request) =>
      context.runIdempotent(
        ["disconnect-engine", request.params.engine],
        request.headers["idempotency-key"],
        {},
        () => service(request.params.engine).disconnect(),
      ),
  );
  done();
};
