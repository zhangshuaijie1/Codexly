import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import type { CodexlyClient } from "@codexly/client";
import type { AgentTask } from "@codexly/protocol";
import { useState } from "react";
import { useTranslation } from "../../../i18n/i18n.js";
import { Button } from "../../../shared/components/core/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../../shared/components/core/dialog.js";
import { Input } from "../../../shared/components/core/input.js";

export function AntigravityResumeDialog({
  client,
  projectId,
  taskId,
  onClose,
  onResume,
}: Readonly<{
  client: Pick<CodexlyClient, "listAntigravitySessions" | "resumeAntigravitySession">;
  projectId: string;
  taskId: string | undefined;
  onClose: () => void;
  onResume: (task: AgentTask) => void;
}>) {
  const { t } = useTranslation("workbench");
  const [search, setSearch] = useState("");
  const [repair, setRepair] = useState(false);
  const sessions = useInfiniteQuery({
    queryKey: ["antigravity-sessions", projectId],
    initialPageParam: "" as string,
    queryFn: ({ pageParam }) => client.listAntigravitySessions(projectId, pageParam || undefined),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 0,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (id: string) =>
      client.resumeAntigravitySession(projectId, id, repair ? taskId : undefined),
    onSuccess: (task) => {
      onClose();
      onResume(task);
    },
  });
  const rows = (sessions.data?.pages.flatMap((page) => page.data) ?? []).filter((row) =>
    `${row.title} ${row.cwd} ${row.id}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const error = mutation.error ?? sessions.error;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
    >
      <DialogContent aria-busy={mutation.isPending} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("antigravityResume.title")}</DialogTitle>
          <DialogDescription>
            {t(projectId === "temporary" ? "antigravityResume.all" : "antigravityResume.project")}
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label={t("antigravityResume.search")}
          placeholder={t("antigravityResume.search")}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
        {taskId && (
          <label className="flex items-center gap-2 text-body-small">
            <input
              type="checkbox"
              checked={repair}
              disabled={mutation.isPending}
              onChange={(event) => {
                setRepair(event.currentTarget.checked);
                mutation.reset();
              }}
            />
            {t("antigravityResume.repair")}
          </label>
        )}
        {error && (
          <p role="alert" className="text-body-small">
            {error.message}
          </p>
        )}
        {sessions.isPending ? (
          <p role="status">{t("antigravityResume.loading")}</p>
        ) : !error && rows.length === 0 ? (
          <p role="status">{t("antigravityResume.empty")}</p>
        ) : null}
        {mutation.isPending && <p role="status">{t("antigravityResume.importing")}</p>}
        <div className="max-h-[50dvh] space-y-1 overflow-y-auto">
          {rows.map((session) => (
            <Button
              key={session.id}
              type="button"
              variant="ghost"
              disabled={mutation.isPending}
              className="h-auto w-full justify-start px-3 py-2 text-left"
              onClick={() => mutation.mutate(session.id)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate" title={session.title || session.id}>
                  {session.title || session.id}
                </span>
                <span
                  className="block truncate text-meta text-muted-foreground"
                  title={session.cwd}
                >
                  {session.cwd}
                </span>
              </span>
              <span className="shrink-0 text-right text-meta text-muted-foreground">
                {session.updatedAt && !Number.isNaN(Date.parse(session.updatedAt)) && (
                  <time className="block" dateTime={session.updatedAt}>
                    {new Date(session.updatedAt).toLocaleString()}
                  </time>
                )}
                <span title={session.id}>{session.id.slice(0, 8)}</span>
              </span>
            </Button>
          ))}
        </div>
        {sessions.hasNextPage && (
          <Button
            variant="outline"
            type="button"
            disabled={sessions.isFetchingNextPage}
            onClick={() => {
              void sessions.fetchNextPage();
            }}
          >
            {t("antigravityResume.more")}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
