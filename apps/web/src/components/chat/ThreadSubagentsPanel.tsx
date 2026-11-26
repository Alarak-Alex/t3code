import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import {
  formatSubagentDisplayTitle,
  resolveSubagentMetadata,
} from "@t3tools/client-runtime/state/subagent-display";
import { readSelectedEffortValue } from "@t3tools/client-runtime/state/thread-execution";
import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  isParentThreadRelationship,
  orderWebThreadLineageRows,
  threadRelationshipRowStatus,
} from "@t3tools/client-runtime/state/thread-relationships";
import {
  isOrchestrationV2WorkActive,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2RemoteTaskChild,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItemStatus,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ScopedThreadRef,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { deriveSubagentElapsedMs } from "@t3tools/shared/orchestrationTiming";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { T, useGT, useMessages, Var } from "gt-react";
import { ArrowLeftIcon, ArrowUpRightIcon, BotIcon, SquareIcon } from "lucide-react";
import { useState } from "react";

import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { linkedThreadSurface } from "../../linkedThreadSurface";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  hasInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import type { MessageResolver } from "../../i18n/messages";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  useAnyEnvironmentHiding,
  useHiddenThreadKeys,
  useQuietThreadProjection,
  useQuietThreadShell,
  useThreadRelationshipShells,
} from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "~/lib/utils";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { AgentElapsed } from "./AgentElapsed";
import { LinkedThreadPane } from "./LinkedThreadPane";
import SideThreadPane from "./SideThreadPane";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";

const SUBAGENTS_INITIAL_COUNT = 10;
const SUBAGENTS_PAGE_COUNT = 20;

interface SubagentListEntry {
  readonly entryId: string;
  readonly subagentId: NodeId | null;
  readonly childThreadId: ThreadId | null;
  readonly remoteChild: OrchestrationV2RemoteTaskChild | undefined;
  readonly title: string;
  readonly status: OrchestrationV2TurnItemStatus;
  readonly active: boolean;
  readonly driver: ProviderDriverKind | undefined;
  readonly providerInstanceId: ProviderInstanceId | undefined;
  readonly provider: ServerProvider | undefined;
  readonly model: string | null;
  readonly modelSelection: ModelSelection | undefined;
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly timestamp: string | null;
  readonly sortEpochMs: number;
  readonly progress: string | null;
  readonly prompt: string;
  readonly result: string | null;
  readonly canStop: boolean;
  readonly stopThreadId: ThreadId | null;
}

function isActiveStatus(status: string | null | undefined): boolean {
  return (
    status === "running" ||
    status === "in_progress" ||
    status === "pending" ||
    status === "queued" ||
    status === "waiting" ||
    status === "blocked" ||
    status === "preparing" ||
    status === "starting"
  );
}

function normalizeStatus(status: string | null | undefined): OrchestrationV2TurnItemStatus {
  switch (status) {
    case "pending":
    case "queued":
    case "preparing":
    case "starting":
      return "pending";
    case "running":
    case "in_progress":
      return "running";
    case "waiting":
    case "blocked":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
    case "rolled_back":
      return "interrupted";
    case "idle":
      return "idle";
    default:
      return "completed";
  }
}

function formatUtcIso(value: DateTime.Utc | null | undefined): string | null {
  return value ? DateTime.formatIso(value) : null;
}

function parseEpochMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function canStopSubagent(agent: OrchestrationV2Subagent | undefined): boolean {
  if (!agent || !isOrchestrationV2WorkActive(agent.status)) return false;
  if (agent.origin === "app_owned") return agent.startedAt !== null;
  return (
    (agent.driver === "claudeAgent" || agent.driver === "ompRpc") &&
    agent.runId !== null &&
    agent.startedAt !== null &&
    agent.nativeTaskRef?.strength === "strong" &&
    agent.nativeTaskRef.nativeId !== null
  );
}

function resolveModelEffortBadge(input: {
  readonly entry: SubagentListEntry;
  readonly resolve: MessageResolver;
}): string | null {
  const { entry, resolve } = input;
  const { modelLabel, modelSlug } = resolveSubagentMetadata(
    {
      model: entry.model,
      modelSelection: entry.modelSelection,
      provider: entry.provider,
    },
    resolve,
  );
  if (!entry.model && !entry.modelSelection?.model) return null;
  const providerModel = entry.provider?.models.find((candidate) => candidate.slug === modelSlug);
  const selectedModel = entry.provider
    ? (resolveSelectableModel(
        entry.provider.driver,
        entry.modelSelection?.model,
        entry.provider.models,
      ) ?? entry.modelSelection?.model.trim())
    : entry.modelSelection?.model.trim();
  const matchingSelection =
    selectedModel === modelSlug &&
    (entry.providerInstanceId === undefined ||
      entry.modelSelection?.instanceId === entry.providerInstanceId)
      ? entry.modelSelection
      : undefined;
  const effort = readSelectedEffortValue(
    matchingSelection,
    providerModel?.capabilities?.optionDescriptors,
  );
  return effort ? `${modelLabel} · ${effort}` : modelLabel;
}

function NativeSubagentDetailBody(props: { readonly entry: SubagentListEntry }) {
  const { entry } = props;
  const gt = useGT();
  const m = useMessages();
  const statusLabel = threadRelationshipStatusLabel(entry.status, m);
  return (
    <ScrollArea scrollFade className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 p-4">
        {entry.prompt ? (
          <div className="ml-auto max-w-[85%] rounded-2xl bg-muted/70 px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words text-foreground">
            {entry.prompt}
          </div>
        ) : null}
        {entry.active && entry.progress ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner aria-hidden size="xs" />
            <span className="min-w-0 truncate">{entry.progress}</span>
          </div>
        ) : null}
        {entry.result ? (
          <div className="text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground/90">
            {entry.result}
          </div>
        ) : !entry.active ? (
          <p className="text-xs text-muted-foreground">
            {gt("Status: {status}", { status: statusLabel })}
          </p>
        ) : null}
      </div>
    </ScrollArea>
  );
}

function SubagentDetailView(props: {
  readonly threadRef: ScopedThreadRef;
  readonly entry: SubagentListEntry;
  readonly providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly visible: boolean;
  readonly sideChatParentPanel: SideChatParentPanel;
  readonly stoppingId: string | null;
  readonly onBack: () => void;
  readonly onStop: (entry: SubagentListEntry) => void;
  readonly onOpenInMainView: (threadId: ThreadId) => void;
}) {
  const { entry } = props;
  const gt = useGT();
  const m = useMessages();
  const modelEffort = resolveModelEffortBadge({ entry, resolve: m });
  const childThreadId = entry.childThreadId;
  const remoteChild = entry.remoteChild;

  return (
    <div data-testid="subagent-detail-view" className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={gt("Back to subagents")}
          onClick={props.onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <ThreadRelationshipIcon
          driver={entry.driver}
          provider={entry.provider}
          providerEntries={props.providerEntries}
          fallbackIcon={BotIcon}
          status={entry.status}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {entry.title}
        </span>
        {modelEffort ? (
          <span className="shrink-0 truncate text-xs text-muted-foreground">{modelEffort}</span>
        ) : null}
        {entry.canStop ? (
          <SharedTooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={gt("Stop subagent {threadTitle}", { threadTitle: entry.title })}
                disabled={props.stoppingId !== null}
                onClick={() => props.onStop(entry)}
              />
            }
            label={gt("Stop subagent")}
          >
            {props.stoppingId === entry.entryId ? (
              <Spinner aria-hidden size="xs" />
            ) : (
              <SquareIcon aria-hidden className="size-3 fill-current text-destructive" />
            )}
          </SharedTooltipTrigger>
        ) : null}
        {childThreadId !== null ? (
          <SharedTooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={gt("Open subagent in main view")}
                onClick={() => props.onOpenInMainView(childThreadId)}
              />
            }
            label={gt("Open in main view")}
          >
            <ArrowUpRightIcon />
          </SharedTooltipTrigger>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {childThreadId !== null ? (
          <SideThreadPane
            key={childThreadId}
            parentRef={props.threadRef}
            surface={{ id: `thread:${childThreadId}`, kind: "thread", threadId: childThreadId }}
            parentPanel={props.sideChatParentPanel}
            onClose={props.onBack}
          />
        ) : remoteChild !== undefined ? (
          <LinkedThreadPane
            key={`${remoteChild.environmentId}:${remoteChild.threadId}`}
            panelRef={props.threadRef}
            surface={linkedThreadSurface({
              viaEnvironmentId: props.threadRef.environmentId,
              environmentId: remoteChild.environmentId,
              threadId: remoteChild.threadId,
              label: remoteChild.label,
              title: entry.title,
            })}
            visible={props.visible}
          />
        ) : (
          <NativeSubagentDetailBody entry={entry} />
        )}
      </div>
    </div>
  );
}

function SubagentRow(props: {
  readonly entry: SubagentListEntry;
  readonly providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly anyInstanceBadge: boolean;
  readonly stoppingId: string | null;
  readonly onSelect: (entryId: string) => void;
  readonly onStop: (entry: SubagentListEntry) => void;
}) {
  const { entry } = props;
  const gt = useGT();
  const m = useMessages();
  const failed = entry.status === "failed";
  const showElapsed =
    entry.active &&
    deriveSubagentElapsedMs(
      { status: entry.status, startedAt: entry.startedAt, completedAt: entry.completedAt },
      0,
    ) !== null;

  return (
    <li className="group relative flex items-center rounded-lg">
      <button
        type="button"
        onClick={() => props.onSelect(entry.entryId)}
        className={cn(
          "flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          entry.canStop && "pr-8",
        )}
      >
        <ThreadRelationshipIcon
          driver={entry.driver}
          provider={entry.provider}
          providerEntries={props.providerEntries}
          anyInstanceBadge={props.anyInstanceBadge}
          fallbackIcon={BotIcon}
          status={entry.status}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-5 text-foreground/90">
            {entry.title}
          </span>
          {entry.active && entry.progress ? (
            <span className="block truncate text-xs text-muted-foreground">{entry.progress}</span>
          ) : null}
        </span>
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {entry.active ? (
            showElapsed ? (
              <AgentElapsed
                agent={{
                  status: entry.status,
                  startedAt: entry.startedAt,
                  completedAt: entry.completedAt,
                }}
              />
            ) : (
              threadRelationshipStatusLabel(entry.status, m)
            )
          ) : entry.timestamp ? (
            <RelativeTime timestamp={entry.timestamp} />
          ) : (
            threadRelationshipStatusLabel(entry.status, m)
          )}
        </span>
      </button>
      {entry.canStop ? (
        <div className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <SharedTooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={gt("Stop subagent {threadTitle}", { threadTitle: entry.title })}
                disabled={props.stoppingId !== null}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onStop(entry);
                }}
              />
            }
            label={gt("Stop subagent")}
          >
            {props.stoppingId === entry.entryId ? (
              <Spinner aria-hidden size="xs" />
            ) : (
              <SquareIcon aria-hidden className="size-3 fill-current text-destructive" />
            )}
          </SharedTooltipTrigger>
        </div>
      ) : null}
    </li>
  );
}

export function ThreadSubagentsPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly selectedSubagentId?: string | undefined;
  readonly visible: boolean;
  readonly sideChatParentPanel: SideChatParentPanel;
}) {
  const { threadRef } = props;
  const gt = useGT();
  const navigate = useNavigate();
  const [visibleCompletedCount, setVisibleCompletedCount] = useState(SUBAGENTS_INITIAL_COUNT);
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  const currentThread = useQuietThreadShell(threadRef);
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  const relationshipShells = useThreadRelationshipShells(threadRef);
  const archived = useArchivedThreadSnapshots([threadRef.environmentId]);
  const archivedShells = archived.snapshots.find(
    (entry) => entry.environmentId === threadRef.environmentId,
  )?.snapshot.threads;
  const providersByEnvironment = useEnvironmentProviders();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(threadRef.environmentId));
  const hiddenKeys = useHiddenThreadKeys();
  const hidingAnywhere = useAnyEnvironmentHiding();
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);

  const providers = providersByEnvironment.get(threadRef.environmentId);
  const derivedProviderEntries = deriveProviderInstanceEntries(providers ?? []);
  const providerEntries = settings
    ? applyProviderInstanceSettings(
        derivedProviderEntries,
        settings,
        currentThread?.projectId ?? null,
      )
    : derivedProviderEntries;
  const anyInstanceBadge = hasInstanceBadge(providerEntries);

  const projected = projection?.subagents ?? [];
  const subagentsByThreadId = new Map<ThreadId, OrchestrationV2Subagent>();
  for (const agent of projected) {
    if (agent.childThreadId !== null) subagentsByThreadId.set(agent.childThreadId, agent);
  }

  const shells: ReadonlyArray<OrchestrationV2ThreadShell> = [
    ...relationshipShells,
    ...(archivedShells ?? []),
  ];
  const graph = deriveThreadRelationshipGraph({ threads: shells, projection });
  const isHiddenRelation = (threadId: ThreadId) =>
    hiddenKeys.has(threadKey({ environmentId: threadRef.environmentId, threadId }));
  const isHiddenUnloadedRelation = (threadId: ThreadId) =>
    hidingAnywhere && graph.nodes.get(threadId)?.missing === true;

  const childSubagentRows = orderWebThreadLineageRows({
    graph,
    rows: immediateThreadRelationships(graph, threadRef.threadId),
    currentThreadId: threadRef.threadId,
    mergeTargetThreadId: null,
  }).filter(
    ({ threadId, edge }) =>
      edge.kind === "subagent" &&
      !isParentThreadRelationship(edge, threadRef.threadId) &&
      !isHiddenRelation(threadId) &&
      !isHiddenUnloadedRelation(threadId),
  );

  const unlistedThreadIds = childSubagentRows
    .filter(
      ({ threadId }) =>
        !relationshipShells.some((thread) => thread.id === threadId) &&
        !subagentsByThreadId.get(threadId)?.title,
    )
    .map(({ threadId }) => threadId);
  const threadTitles = useEnvironmentQuery(
    unlistedThreadIds.length === 0
      ? null
      : orchestrationEnvironment.threadTitles({
          environmentId: threadRef.environmentId,
          input: { threadIds: unlistedThreadIds },
        }),
  );
  const resolvedThreadTitles = threadTitles.data ?? {};

  const entries: SubagentListEntry[] = [];
  const seenThreadIds = new Set<ThreadId>();

  for (const row of childSubagentRows) {
    const { threadId } = row;
    seenThreadIds.add(threadId);
    const node = graph.nodes.get(threadId);
    const agent = subagentsByThreadId.get(threadId);
    const rowStatus = threadRelationshipRowStatus(graph, row);
    const status = normalizeStatus(rowStatus ?? agent?.status);
    const active = isActiveStatus(rowStatus ?? agent?.status);
    const rawTitle =
      node?.thread?.title ?? resolvedThreadTitles[threadId] ?? agent?.title ?? gt("Subagent");
    const title = formatSubagentDisplayTitle(rawTitle) || gt("Subagent");
    const providerInstanceId = agent?.providerInstanceId ?? node?.thread?.providerInstanceId;
    const provider = providers?.find((candidate) => candidate.instanceId === providerInstanceId);
    const driver = agent?.driver ?? provider?.driver;
    const startedAt =
      formatUtcIso(agent?.startedAt) ??
      formatUtcIso(node?.thread?.activityRunStartedAt ?? node?.thread?.latestRunStartedAt) ??
      formatUtcIso(node?.thread?.createdAt);
    const completedAt =
      formatUtcIso(agent?.completedAt) ?? formatUtcIso(node?.thread?.latestRunCompletedAt);
    const updatedAt = formatUtcIso(agent?.updatedAt) ?? formatUtcIso(node?.thread?.updatedAt);
    const timestamp = active ? startedAt : (completedAt ?? updatedAt ?? startedAt);

    entries.push({
      entryId: threadId,
      subagentId: agent?.id ?? null,
      childThreadId: threadId,
      remoteChild: undefined,
      title,
      status,
      active,
      driver,
      providerInstanceId,
      provider,
      model: agent?.model ?? node?.thread?.modelSelection.model ?? null,
      modelSelection: agent?.modelSelection ?? node?.thread?.modelSelection,
      origin: agent?.origin ?? "provider_native",
      startedAt,
      completedAt,
      timestamp,
      sortEpochMs: parseEpochMs(timestamp ?? updatedAt ?? startedAt),
      progress: agent?.progress?.trim() || null,
      prompt: agent?.promptOmitted === true ? "" : (agent?.prompt.trim() ?? ""),
      result: agent?.resultOmitted === true ? null : agent?.result?.trim() || null,
      canStop: canStopSubagent(agent),
      stopThreadId: agent?.threadId ?? null,
    });
  }

  for (const agent of projected) {
    if (agent.childThreadId !== null && seenThreadIds.has(agent.childThreadId)) continue;
    const active = isActiveStatus(agent.status);
    const rawTitle =
      agent.title && agent.title !== "task"
        ? agent.title
        : agent.prompt || agent.title || gt("Subagent");
    const title = formatSubagentDisplayTitle(rawTitle) || gt("Subagent");
    const providerEnvId = agent.remoteChild?.environmentId ?? threadRef.environmentId;
    const provider = providersByEnvironment
      .get(providerEnvId)
      ?.find((candidate) => candidate.instanceId === agent.providerInstanceId);
    const startedAt = formatUtcIso(agent.startedAt);
    const completedAt = formatUtcIso(agent.completedAt);
    const updatedAt = formatUtcIso(agent.updatedAt);
    const timestamp = active ? startedAt : (completedAt ?? updatedAt ?? startedAt);

    entries.push({
      entryId: agent.childThreadId ?? agent.id,
      subagentId: agent.id,
      childThreadId: agent.childThreadId,
      remoteChild: agent.remoteChild,
      title,
      status: agent.status,
      active,
      driver: provider?.driver ?? (agent.remoteChild ? undefined : agent.driver),
      providerInstanceId: agent.providerInstanceId,
      provider,
      model: agent.model,
      modelSelection: agent.modelSelection,
      origin: agent.origin,
      startedAt,
      completedAt,
      timestamp,
      sortEpochMs: parseEpochMs(timestamp ?? updatedAt ?? startedAt),
      progress: agent.progress?.trim() || null,
      prompt: agent.promptOmitted === true ? "" : agent.prompt.trim(),
      result: agent.resultOmitted === true ? null : agent.result?.trim() || null,
      canStop: canStopSubagent(agent),
      stopThreadId: agent.threadId,
    });
  }

  const activeEntries = entries
    .filter((entry) => entry.active)
    .toSorted((left, right) => right.sortEpochMs - left.sortEpochMs);
  const completedEntries = entries
    .filter((entry) => !entry.active)
    .toSorted((left, right) => right.sortEpochMs - left.sortEpochMs);

  const selectedEntry = props.selectedSubagentId
    ? (entries.find(
        (entry) =>
          entry.entryId === props.selectedSubagentId ||
          entry.subagentId === props.selectedSubagentId ||
          entry.childThreadId === props.selectedSubagentId,
      ) ?? null)
    : null;

  const stopEntry = async (entry: SubagentListEntry) => {
    if (stoppingId !== null || entry.subagentId === null || entry.stopThreadId === null) return;
    setStoppingId(entry.entryId);
    const result = await interruptTurn({
      environmentId: threadRef.environmentId,
      input: { threadId: entry.stopThreadId, subagentId: entry.subagentId },
    });
    setStoppingId(null);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: gt("Could not stop subagent") });
    }
  };

  const selectEntry = (entryId: string) => {
    useRightPanelStore.getState().openSubagents(threadRef, entryId);
  };

  const goBackToList = () => {
    useRightPanelStore.getState().openSubagents(threadRef);
  };

  const openInMainView = (childThreadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(threadRef.environmentId, childThreadId)),
    });
  };

  if (selectedEntry !== null) {
    return (
      <SubagentDetailView
        threadRef={threadRef}
        entry={selectedEntry}
        providerEntries={providerEntries}
        visible={props.visible}
        sideChatParentPanel={props.sideChatParentPanel}
        stoppingId={stoppingId}
        onBack={goBackToList}
        onStop={(entry) => void stopEntry(entry)}
        onOpenInMainView={openInMainView}
      />
    );
  }

  const visibleCompleted = completedEntries.slice(0, visibleCompletedCount);
  const hiddenCompletedCount = Math.max(0, completedEntries.length - visibleCompleted.length);

  return (
    <ScrollArea scrollFade className="min-h-0 flex-1" data-testid="subagents-list-panel">
      <div className="flex flex-col gap-5 p-3">
        <section aria-labelledby="subagents-active-heading" className="flex flex-col gap-1">
          <h3
            id="subagents-active-heading"
            className="px-2.5 text-xs font-medium text-muted-foreground"
          >
            {gt("Active · {count}", { count: activeEntries.length })}
          </h3>
          {activeEntries.length === 0 ? (
            <p className="px-2.5 py-1 text-xs text-muted-foreground/75">
              <T>No active subagents</T>
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {activeEntries.map((entry) => (
                <SubagentRow
                  key={entry.entryId}
                  entry={entry}
                  providerEntries={providerEntries}
                  anyInstanceBadge={anyInstanceBadge}
                  stoppingId={stoppingId}
                  onSelect={selectEntry}
                  onStop={(item) => void stopEntry(item)}
                />
              ))}
            </ul>
          )}
        </section>

        {completedEntries.length > 0 ? (
          <section aria-labelledby="subagents-completed-heading" className="flex flex-col gap-1">
            <h3
              id="subagents-completed-heading"
              className="px-2.5 text-xs font-medium text-muted-foreground"
            >
              {gt("Completed · {count}", { count: completedEntries.length })}
            </h3>
            <ul className="flex flex-col gap-0.5">
              {visibleCompleted.map((entry) => (
                <SubagentRow
                  key={entry.entryId}
                  entry={entry}
                  providerEntries={providerEntries}
                  anyInstanceBadge={anyInstanceBadge}
                  stoppingId={stoppingId}
                  onSelect={selectEntry}
                  onStop={(item) => void stopEntry(item)}
                />
              ))}
            </ul>
            {hiddenCompletedCount > 0 ? (
              <div className="px-1 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setVisibleCompletedCount((current) => current + SUBAGENTS_PAGE_COUNT)
                  }
                >
                  <T>
                    Show <Var>{hiddenCompletedCount}</Var> more
                  </T>
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </ScrollArea>
  );
}
