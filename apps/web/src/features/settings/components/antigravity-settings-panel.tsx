import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CodexlyClient } from "@codexly/client";
import { resolveAntigravitySelection, type AntigravityDefaults } from "@codexly/protocol";
import { useState } from "react";
import { useTranslation } from "../../../i18n/i18n.js";
import { Button } from "../../../shared/components/core/button.js";
import { ReasoningSelect, SettingsField, SettingsGroup } from "./global-settings-fields.js";
import { ModelMenuOptions } from "../../workbench/components/model-menu-options.js";
import { CompactSelectorTrigger } from "@codexly/ui/core/compact-selector";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../../../shared/components/core/dropdown-menu.js";

export function AntigravitySettingsPanel({
  client,
  section,
}: Readonly<{
  client: Pick<
    CodexlyClient,
    | "getEngineProfile"
    | "updateAntigravityDefaults"
    | "getAntigravityConfig"
    | "updateAntigravityConfig"
  >;
  section: "antigravity-provider" | "antigravity-agent" | "antigravity-personalization";
}>) {
  const { t } = useTranslation("settings");
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ["engine-profile", "antigravity"],
    queryFn: () => client.getEngineProfile("antigravity"),
    staleTime: 30_000,
    retry: false,
  });
  const [draft, setDraft] = useState<AntigravityDefaults>();
  const config = useQuery({
    queryKey: ["antigravity-config"],
    queryFn: () => client.getAntigravityConfig(),
    enabled: section !== "antigravity-provider",
    retry: false,
  });
  const [mode, setMode] = useState<string>();
  const [instructions, setInstructions] = useState<string>();
  const saveConfig = useMutation({
    mutationFn: client.updateAntigravityConfig.bind(client),
    onSuccess: (value) => {
      cache.setQueryData(["antigravity-config"], value);
      setMode(undefined);
      setInstructions(undefined);
    },
  });
  const recheck = useMutation({
    mutationFn: () => client.getEngineProfile("antigravity", undefined, { refresh: true }),
    onSuccess: (profile) => {
      cache.setQueryData(["engine-profile", "antigravity"], profile);
    },
  });
  const save = useMutation({
    mutationFn: (value: AntigravityDefaults) => client.updateAntigravityDefaults(value),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["engine-profile", "antigravity"] });
      setDraft(undefined);
    },
  });
  const saved = query.data?.antigravityDefaults;
  const models = query.data?.models.data ?? [];
  const selection = resolveAntigravitySelection(models, draft ?? saved);
  const model = models.find(({ id }) => id === selection?.model);
  const connected = query.data?.connection.state === "connected";
  const checking = query.isFetching || recheck.isPending;
  const changed =
    draft !== undefined &&
    (selection?.model !== saved?.model || selection?.reasoningEffort !== saved?.reasoningEffort);
  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold">{t(`sections.${section}`)}</h1>
      {section === "antigravity-provider" && (
        <SettingsGroup title={t("antigravity.connection")}>
          <SettingsField label={t("antigravity.status")} description={t("antigravity.usesCli")}>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <span role="status" className="text-body-small">
                {checking
                  ? t("antigravity.checking")
                  : connected
                    ? t("antigravity.connected")
                    : t("antigravity.unavailable")}
              </span>
              <Button
                type="button"
                variant="outline"
                disabled={checking}
                onClick={() => recheck.mutate()}
              >
                {t("antigravity.recheck")}
              </Button>
            </div>
          </SettingsField>
          {!connected && !checking && (
            <SettingsField label={t("antigravity.login")} description={t("antigravity.loginHelp")}>
              <code className="text-body-small">agy acp --login</code>
            </SettingsField>
          )}
        </SettingsGroup>
      )}
      {section === "antigravity-agent" && connected && model && selection && (
        <SettingsGroup title={t("antigravity.defaults")} description={t("antigravity.newChats")}>
          <SettingsField label={t("fields.defaultModel")}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <CompactSelectorTrigger
                  aria-label={t("fields.defaultModel")}
                  disabled={save.isPending}
                >
                  {model.displayName}
                </CompactSelectorTrigger>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" aria-label={t("fields.defaultModel")}>
                <ModelMenuOptions
                  models={models}
                  selection={selection.model}
                  groupPlanners
                  onSelect={(id) => {
                    setDraft(
                      resolveAntigravitySelection(models, { model: id, reasoningEffort: "" }),
                    );
                    save.reset();
                  }}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsField>
          {model.supportedReasoningEfforts.length > 0 && (
            <SettingsField label={t("fields.reasoningEffort")}>
              <ReasoningSelect
                ariaLabel={t("fields.reasoningEffort")}
                disabled={save.isPending}
                model={model}
                value={selection.reasoningEffort}
                onChange={(reasoningEffort) => {
                  setDraft({ model: model.id, reasoningEffort });
                  save.reset();
                }}
              />
            </SettingsField>
          )}
          <div className="flex items-center justify-end gap-3 py-3">
            {save.isError && (
              <p role="alert" className="text-body-small">
                {t("errors.save")}
              </p>
            )}
            {save.isSuccess && (
              <p role="status" className="text-body-small">
                {t("actions.saved")}
              </p>
            )}
            <Button
              type="button"
              disabled={!changed || save.isPending}
              onClick={() => save.mutate(selection)}
            >
              {save.isPending ? t("actions.saving") : t("antigravity.save")}
            </Button>
          </div>
        </SettingsGroup>
      )}
      {section !== "antigravity-provider" && config.isError && (
        <p role="alert">{t("errors.load")}</p>
      )}
      {section === "antigravity-agent" && config.data && (
        <SettingsGroup
          title={t("antigravity.executionMode")}
          description={t("antigravity.modeDescription")}
        >
          <SettingsField label={t("antigravity.executionMode")}>
            <select
              aria-label={t("antigravity.executionMode")}
              value={mode ?? config.data.mode}
              onChange={(event) => setMode(event.currentTarget.value)}
              className="rounded border border-separator bg-control p-2"
            >
              {(["inherit", "default", "accept-edits", "auto", "plan"] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`antigravity.mode.${value}`)}
                </option>
              ))}
            </select>
          </SettingsField>
          <div className="flex justify-end gap-2 py-3">
            {saveConfig.isError && <span role="alert">{saveConfig.error.message}</span>}
            <Button
              type="button"
              disabled={!mode || mode === config.data.mode || saveConfig.isPending}
              onClick={() =>
                saveConfig.mutate({ ...config.data!, mode: mode as typeof config.data.mode })
              }
            >
              {t("antigravity.save")}
            </Button>
          </div>
        </SettingsGroup>
      )}
      {section === "antigravity-personalization" && config.data && (
        <SettingsGroup
          title={t("antigravity.instructions")}
          description={config.data.instructionsPath ?? t("antigravity.instructionsDescription")}
        >
          <textarea
            aria-label={t("antigravity.instructions")}
            className="my-3 min-h-48 w-full rounded border border-separator bg-control p-3 text-body-small"
            value={instructions ?? config.data.instructions}
            onChange={(event) => setInstructions(event.currentTarget.value)}
          />
          <div className="flex justify-end gap-2 py-3">
            {saveConfig.isError && <span role="alert">{saveConfig.error.message}</span>}
            <Button
              type="button"
              disabled={
                instructions === undefined ||
                instructions === config.data.instructions ||
                saveConfig.isPending
              }
              onClick={() => saveConfig.mutate({ ...config.data!, instructions: instructions! })}
            >
              {t("antigravity.save")}
            </Button>
          </div>
        </SettingsGroup>
      )}
    </section>
  );
}
