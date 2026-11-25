import type { AgentModel } from "@codexly/protocol";
import { useTranslation } from "../../../i18n/i18n.js";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../../../shared/components/core/dropdown-menu.js";

function plannerName(model: AgentModel) {
  return /^Orchestrator\s*\((.+)\)$/i.exec(model.displayName)?.[1];
}

export function ModelMenuOptions({
  models,
  selection,
  groupPlanners,
  onSelect,
}: Readonly<{
  models: readonly AgentModel[];
  selection: string;
  groupPlanners: boolean;
  onSelect: (modelId: string) => void;
}>) {
  const { t } = useTranslation("settings");
  const planners = groupPlanners ? models.filter((model) => plannerName(model)) : [];
  const selectedPlanner = planners.find((model) => model.id === selection);
  const item = (model: AgentModel, label: string) => (
    <DropdownMenuRadioItem key={model.id} indicator="check" value={model.id}>
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
    </DropdownMenuRadioItem>
  );
  return (
    <DropdownMenuRadioGroup value={selection} onValueChange={(id) => onSelect(id)}>
      {models.map((model) => {
        if (!groupPlanners || !plannerName(model)) return item(model, model.displayName);
        if (model !== planners[0]) return null;
        return (
          <DropdownMenuSub key="orchestrator-planners">
            <DropdownMenuSubTrigger>
              Orchestrator
              {selectedPlanner && (
                <span className="text-muted-foreground">{plannerName(selectedPlanner)}</span>
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent aria-label={t("antigravity.planner")}>
              <DropdownMenuLabel>{t("antigravity.planner")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={selection} onValueChange={(id) => onSelect(id)}>
                {planners.map((planner) => item(planner, plannerName(planner)!))}
              </DropdownMenuRadioGroup>
              {planners.every((planner) => !planner.supportedReasoningEfforts.length) && (
                <DropdownMenuLabel>{t("antigravity.fixedEffort")}</DropdownMenuLabel>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      })}
    </DropdownMenuRadioGroup>
  );
}
