import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import type { ContextService } from "../core/context-service";
import type { ConversationDiscoveryService } from "../core/conversation-discovery";
import type { ContextEntry, ContextScope, DiscoveredConversation, SupportedIde } from "../core/types";
import {
  buildIdeAvailability,
  buildWorkspaceOptions,
  conversationMatchesWorkspace,
  exportSnapshotToTargetIde,
  type IdeAvailability,
  type WorkspaceOption
} from "./workflow";

type TabId = "dashboard" | "conversations" | "contexts";
type ScopeFilter = "all" | ContextScope;
type InjectPolicy = "lww" | "keep-both";
type InjectScope = "global" | "project" | "session";
type ConversationInputMode = "none" | "inject-tags";
type TransferStepId =
  | "source-ide"
  | "source-workspace"
  | "conversation"
  | "target-ide"
  | "target-workspace"
  | "confirm";

interface ScreenNotice {
  tone: "info" | "success" | "error";
  message: string;
}

interface PluroTuiAppProps {
  service: ContextService;
  discovery: ConversationDiscoveryService;
  defaultIde: SupportedIde;
  dataDir: string;
  version: string;
}

interface DashboardSummary {
  recentContextCount: number;
  discoveredCount: number;
  byIde: Record<SupportedIde, number>;
  confidence: Record<"high" | "medium" | "low", number>;
  lastScannedAt?: string;
}

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "conversations", label: "Transfer" },
  { id: "contexts", label: "Contexts" }
];

const TRANSFER_STEPS: ReadonlyArray<{ id: TransferStepId; label: string }> = [
  { id: "source-ide", label: "Source IDE" },
  { id: "source-workspace", label: "Source Workspace" },
  { id: "conversation", label: "Conversation" },
  { id: "target-ide", label: "Target IDE" },
  { id: "target-workspace", label: "Target Workspace" },
  { id: "confirm", label: "Inject" }
];

const IDE_OPTIONS: ReadonlyArray<SupportedIde> = ["cursor", "vscode-copilot", "antigravity"];
const SCOPE_FILTERS: ReadonlyArray<ScopeFilter> = ["all", "global", "project", "session"];
const INJECT_POLICIES: ReadonlyArray<InjectPolicy> = ["keep-both", "lww"];
const INJECT_SCOPES: ReadonlyArray<InjectScope> = ["project", "session", "global"];

const UI_THEME = {
  primary: "white",
  muted: "gray",
  accent: "yellow",
  info: "cyan",
  success: "green",
  error: "red",
  frame: "gray"
} as const;

type TextTone = "primary" | "muted" | "accent" | "info" | "success" | "error";

const TEXT_TONE_COLOR: Record<TextTone, string> = {
  primary: UI_THEME.primary,
  muted: UI_THEME.muted,
  accent: UI_THEME.accent,
  info: UI_THEME.info,
  success: UI_THEME.success,
  error: UI_THEME.error
};

interface NoticeVisual {
  icon: string;
  tone: TextTone;
}

function AppText(props: {
  children: React.ReactNode;
  tone?: TextTone;
  bold?: boolean;
}): React.ReactElement {
  return (
    <Text color={TEXT_TONE_COLOR[props.tone ?? "primary"]} bold={props.bold}>
      {props.children}
    </Text>
  );
}

function cycleValue<T>(values: readonly T[], current: T): T {
  const index = values.indexOf(current);

  if (index < 0) {
    return values[0] as T;
  }

  return values[(index + 1) % values.length] as T;
}

function cycleByDelta<T>(values: readonly T[], current: T, delta: number): T {
  const index = values.indexOf(current);
  if (index < 0) {
    return values[0] as T;
  }

  const size = values.length;
  const normalized = ((index + delta) % size + size) % size;
  return values[normalized] as T;
}

function truncateCell(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  if (width <= 1) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 1)}…`;
}

function padCell(value: string, width: number): string {
  return truncateCell(value, width).padEnd(width, " ");
}

function clampIndex(value: number, size: number): number {
  if (size <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(value, size - 1));
}

function getNoticeVisual(tone: ScreenNotice["tone"]): NoticeVisual {
  if (tone === "success") {
    return {
      icon: "✓",
      tone: "success"
    };
  }

  if (tone === "error") {
    return {
      icon: "✕",
      tone: "error"
    };
  }

  return {
    icon: "ℹ",
    tone: "info"
  };
}

function toSelectedWindow<T>(rows: T[], selectedIndex: number, windowSize: number): {
  start: number;
  view: T[];
} {
  if (rows.length <= windowSize) {
    return {
      start: 0,
      view: rows
    };
  }

  const half = Math.floor(windowSize / 2);
  const start = Math.max(0, Math.min(selectedIndex - half, rows.length - windowSize));

  return {
    start,
    view: rows.slice(start, start + windowSize)
  };
}

function shortTimestamp(value: string | undefined): string {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function parseTagInput(value: string): string[] {
  const tags = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return [...new Set(tags)];
}

function horizontalRule(width: number): string {
  return "─".repeat(Math.max(8, width));
}

function Panel(props: {
  title?: string;
  accent?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box
      borderStyle="round"
      borderColor={props.accent ? UI_THEME.accent : UI_THEME.frame}
      paddingX={1}
      flexDirection="column"
    >
      {props.title ? <AppText tone={props.accent ? "accent" : "muted"}>{props.title}</AppText> : null}
      {props.title ? <AppText tone="muted">{horizontalRule(52)}</AppText> : null}
      {props.children}
    </Box>
  );
}

function NoticeLine(props: { busy?: boolean; notice: ScreenNotice }): React.ReactElement {
  const visual = getNoticeVisual(props.notice.tone);

  return (
    <AppText tone={visual.tone}>
      {`${visual.icon} ${props.busy ? "Working..." : props.notice.message}`}
    </AppText>
  );
}

function workspaceProjectOverride(workspace: WorkspaceOption | undefined): string | undefined {
  if (!workspace) {
    return undefined;
  }

  if (workspace.projectPath) {
    return workspace.projectPath;
  }

  if (workspace.scanRoots.length > 0) {
    return workspace.scanRoots[0];
  }

  return undefined;
}

export function PluroTuiApp(props: PluroTuiAppProps): React.ReactElement {
  const { exit } = useApp();
  const [activeTabIndex, setActiveTabIndex] = useState(0);

  const activeTab = TABS[activeTabIndex]?.id ?? "dashboard";

  useInput((input, key) => {
    if (input.toLowerCase() === "q" || (key.ctrl && input.toLowerCase() === "c")) {
      exit();
      return;
    }

    if (key.tab && key.shift) {
      setActiveTabIndex((current) => (current - 1 + TABS.length) % TABS.length);
      return;
    }

    if (key.tab) {
      setActiveTabIndex((current) => (current + 1) % TABS.length);
      return;
    }

    if (input === "1" || input === "2" || input === "3") {
      const next = Number.parseInt(input, 10) - 1;
      if (!Number.isNaN(next) && next >= 0 && next < TABS.length) {
        setActiveTabIndex(next);
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={UI_THEME.frame} paddingX={1} paddingY={0}>
      <Box justifyContent="space-between">
        <AppText tone="accent" bold>
          ◈ Pluro Terminal Console v{props.version}
        </AppText>
        <AppText tone="muted">{shortTimestamp(new Date().toISOString())}</AppText>
      </Box>
      <AppText tone="muted">Data root: {props.dataDir}</AppText>

      <Box marginTop={1} borderStyle="single" borderColor={UI_THEME.frame} paddingX={1}>
        {TABS.map((tab, index) => {
          const selected = tab.id === activeTab;
          const label = `${index + 1}:${tab.label}`;

          return (
            <Box key={tab.id} marginRight={2}>
              <AppText tone={selected ? "accent" : "muted"} bold={selected}>
                {selected ? `◆ ${label}` : `◇ ${label}`}
              </AppText>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1} flexDirection="column" minHeight={22}>
        {activeTab === "dashboard" ? (
          <DashboardScreen
            isActive
            service={props.service}
            discovery={props.discovery}
            onOpenTab={(tabId) => setActiveTabIndex(TABS.findIndex((tab) => tab.id === tabId))}
          />
        ) : null}

        {activeTab === "conversations" ? (
          <ConversationsScreen
            isActive
            service={props.service}
            discovery={props.discovery}
            defaultIde={props.defaultIde}
            dataDir={props.dataDir}
          />
        ) : null}

        {activeTab === "contexts" ? <ContextsScreen isActive service={props.service} /> : null}
      </Box>

      <Box marginTop={1}>
        <AppText tone="muted">Global keys: Tab/Shift+Tab panels | 1/2/3 jump | q quit</AppText>
      </Box>
    </Box>
  );
}

function DashboardScreen(props: {
  isActive: boolean;
  service: ContextService;
  discovery: ConversationDiscoveryService;
  onOpenTab: (tab: TabId) => void;
}): React.ReactElement {
  const [summary, setSummary] = useState<DashboardSummary>({
    recentContextCount: 0,
    discoveredCount: 0,
    byIde: {
      cursor: 0,
      "vscode-copilot": 0,
      antigravity: 0
    },
    confidence: {
      high: 0,
      medium: 0,
      low: 0
    }
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ScreenNotice>({
    tone: "info",
    message: "Press r to refresh dashboard"
  });

  const refresh = useCallback(async () => {
    setBusy(true);

    try {
      const recentContextPage = await props.service.listContextsPage({ limit: 20 });
      const conversations = props.discovery.list({ limit: 5000 });

      const byIde: DashboardSummary["byIde"] = {
        cursor: 0,
        "vscode-copilot": 0,
        antigravity: 0
      };
      const confidence: DashboardSummary["confidence"] = {
        high: 0,
        medium: 0,
        low: 0
      };

      for (const conversation of conversations) {
        byIde[conversation.ide] += 1;

        if (conversation.projectConfidence === "high") {
          confidence.high += 1;
        } else if (conversation.projectConfidence === "medium") {
          confidence.medium += 1;
        } else {
          confidence.low += 1;
        }
      }

      setSummary({
        recentContextCount: recentContextPage.entries.length,
        discoveredCount: conversations.length,
        byIde,
        confidence,
        lastScannedAt: conversations[0]?.scannedAt
      });
      setNotice({
        tone: "success",
        message: `Dashboard refreshed: contexts=${recentContextPage.entries.length} conversations=${conversations.length}`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice({
        tone: "error",
        message: `Dashboard refresh failed: ${message}`
      });
    } finally {
      setBusy(false);
    }
  }, [props.discovery, props.service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useInput(
    (input) => {
      if (input === "r") {
        void refresh();
        return;
      }

      if (input === "2") {
        props.onOpenTab("conversations");
        return;
      }

      if (input === "3") {
        props.onOpenTab("contexts");
      }
    },
    { isActive: props.isActive }
  );

  const operatorName = process.env.USERNAME ?? process.env.USER ?? "operator";

  return (
    <Box flexDirection="column">
      <Box>
        <Box flexGrow={1} marginRight={1}>
          <Panel title="Session" accent>
            <AppText tone="accent" bold>{`Welcome back, ${operatorName}`}</AppText>
            <AppText tone="muted">Workspaces ready for cross-IDE transfer.</AppText>
            <Box marginTop={1}>
              <AppText tone="muted">Agentic IDEs</AppText>
            </Box>
            <AppText>{`Cursor ${summary.byIde.cursor > 0 ? "●" : "○"}`}</AppText>
            <AppText>{`VS Code Copilot ${summary.byIde["vscode-copilot"] > 0 ? "●" : "○"}`}</AppText>
            <AppText>{`Antigravity ${summary.byIde.antigravity > 0 ? "●" : "○"}`}</AppText>
          </Panel>
        </Box>

        <Box flexGrow={1}>
          <Panel title="Recent Activity">
            <AppText>{`Indexed conversations: ${summary.discoveredCount}`}</AppText>
            <AppText>{`Recent contexts cached: ${summary.recentContextCount}`}</AppText>
            <AppText>{`Confidence: high=${summary.confidence.high} medium=${summary.confidence.medium} low=${summary.confidence.low}`}</AppText>
            <AppText tone="muted">Last scan: {shortTimestamp(summary.lastScannedAt)}</AppText>
            <Box marginTop={1}>
              <AppText tone="muted">Press r to refresh telemetry.</AppText>
            </Box>
          </Panel>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Panel title="What Is New">
          <AppText tone="accent">/transfer panel now supports source+target workspace selection</AppText>
          <AppText>/scan a selected source workspace directly before transfer</AppText>
          <AppText>/inject with policy, scope, skip mode, and tag controls</AppText>
          <AppText tone="muted">Shortcuts: 2 transfer panel, 3 contexts panel, q quit</AppText>
        </Panel>
      </Box>

      <Box marginTop={1}>
        <NoticeLine busy={busy} notice={notice} />
      </Box>
    </Box>
  );
}

function ConversationsScreen(props: {
  isActive: boolean;
  service: ContextService;
  discovery: ConversationDiscoveryService;
  defaultIde: SupportedIde;
  dataDir: string;
}): React.ReactElement {
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [sourceIde, setSourceIde] = useState<SupportedIde>(props.defaultIde);
  const [targetIde, setTargetIde] = useState<SupportedIde>(
    props.defaultIde === "vscode-copilot" ? "cursor" : "vscode-copilot"
  );
  const [sourceWorkspaces, setSourceWorkspaces] = useState<WorkspaceOption[]>([]);
  const [targetWorkspaces, setTargetWorkspaces] = useState<WorkspaceOption[]>([]);
  const [sourceWorkspaceIndex, setSourceWorkspaceIndex] = useState(0);
  const [targetWorkspaceIndex, setTargetWorkspaceIndex] = useState(0);
  const [conversations, setConversations] = useState<DiscoveredConversation[]>([]);
  const [conversationIndex, setConversationIndex] = useState(0);
  const [ideAvailability, setIdeAvailability] = useState<IdeAvailability[]>([]);
  const [inputMode, setInputMode] = useState<ConversationInputMode>("none");
  const [injectPolicy, setInjectPolicy] = useState<InjectPolicy>("keep-both");
  const [injectScope, setInjectScope] = useState<InjectScope>("project");
  const [injectSkipUnchanged, setInjectSkipUnchanged] = useState(true);
  const [injectTags, setInjectTags] = useState<string[]>([]);
  const [injectTagsDraft, setInjectTagsDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ScreenNotice>({
    tone: "info",
    message: "Use Enter to confirm each step. Use ↑/↓ to choose options."
  });

  const activeStep = TRANSFER_STEPS[activeStepIndex]?.id ?? "source-ide";
  const selectedSourceWorkspace = sourceWorkspaces[sourceWorkspaceIndex];
  const selectedTargetWorkspace = targetWorkspaces[targetWorkspaceIndex];
  const selectedConversation = conversations[conversationIndex];

  const refreshCatalog = useCallback(async () => {
    const discoveredByIde = {
      cursor: props.discovery.list({ ide: "cursor", limit: 5000 }),
      "vscode-copilot": props.discovery.list({ ide: "vscode-copilot", limit: 5000 }),
      antigravity: props.discovery.list({ ide: "antigravity", limit: 5000 })
    } satisfies Record<SupportedIde, DiscoveredConversation[]>;

    const availability = IDE_OPTIONS.map((ide) =>
      buildIdeAvailability(ide, props.discovery.resolveKnownRoots(ide), discoveredByIde[ide].length)
    );

    setIdeAvailability(availability);

    const sourceRoots = availability.find((item) => item.ide === sourceIde)?.knownRoots ?? [];
    const nextSourceWorkspaces = buildWorkspaceOptions(sourceRoots, discoveredByIde[sourceIde]);
    setSourceWorkspaces(nextSourceWorkspaces);
    setSourceWorkspaceIndex((current) => clampIndex(current, nextSourceWorkspaces.length));

    const targetRoots = availability.find((item) => item.ide === targetIde)?.knownRoots ?? [];
    const nextTargetWorkspaces = buildWorkspaceOptions(targetRoots, discoveredByIde[targetIde]);
    setTargetWorkspaces(nextTargetWorkspaces);
    setTargetWorkspaceIndex((current) => clampIndex(current, nextTargetWorkspaces.length));
  }, [props.discovery, sourceIde, targetIde]);

  const refreshConversations = useCallback(async () => {
    const indexed = props.discovery.list({ ide: sourceIde, limit: 5000 });
    const filtered = selectedSourceWorkspace
      ? indexed.filter((conversation) => conversationMatchesWorkspace(conversation, selectedSourceWorkspace))
      : indexed;

    const visibleRows = filtered.slice(0, 300);
    setConversations(visibleRows);
    setConversationIndex((current) => clampIndex(current, visibleRows.length));
  }, [props.discovery, selectedSourceWorkspace, sourceIde]);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  const scanSourceWorkspace = useCallback(async () => {
    const fallbackRoots = ideAvailability.find((item) => item.ide === sourceIde)?.knownRoots ?? [];
    const roots = selectedSourceWorkspace?.scanRoots?.length
      ? selectedSourceWorkspace.scanRoots
      : fallbackRoots;

    setBusy(true);

    try {
      const result = await props.discovery.scan({
        ide: sourceIde,
        roots: roots.length > 0 ? roots : undefined
      });

      setNotice({
        tone: result.errors.length > 0 ? "error" : "success",
        message: `Scan ${sourceIde}: discovered=${result.discovered} skipped=${result.skipped} errors=${result.errors.length}`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice({
        tone: "error",
        message: `Scan failed: ${message}`
      });
    } finally {
      setBusy(false);
    }

    await refreshCatalog();
    await refreshConversations();
  }, [ideAvailability, props.discovery, refreshCatalog, refreshConversations, selectedSourceWorkspace, sourceIde]);

  const transferSelectedConversation = useCallback(async () => {
    if (!selectedConversation) {
      setNotice({
        tone: "error",
        message: "Select a conversation before transfer"
      });
      return;
    }

    if (!selectedTargetWorkspace || selectedTargetWorkspace.source === "fallback") {
      setNotice({
        tone: "error",
        message: "Select a concrete target workspace before transfer"
      });
      return;
    }

    setBusy(true);

    try {
      const injectResult = await props.discovery.injectConversation({
        conversationId: selectedConversation.id,
        policy: injectPolicy,
        scope: injectScope,
        tags: injectTags,
        skipUnchanged: injectSkipUnchanged,
        projectPath: workspaceProjectOverride(selectedTargetWorkspace)
      });

      const exportResult = await exportSnapshotToTargetIde(props.service, props.dataDir, targetIde);

      if (injectResult.skipped) {
        setNotice({
          tone: "info",
          message: `Inject skipped (${injectResult.reason ?? "unchanged"}) and exported ${exportResult.entries} entries to ${targetIde}`
        });
      } else {
        setNotice({
          tone: "success",
          message: `Transferred ${selectedConversation.id.slice(0, 8)} to ${targetIde} (${exportResult.entries} entries)`
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice({
        tone: "error",
        message: `Transfer failed: ${message}`
      });
    } finally {
      setBusy(false);
    }
  }, [
    injectPolicy,
    injectScope,
    injectSkipUnchanged,
    injectTags,
    props.dataDir,
    props.discovery,
    props.service,
    selectedConversation,
    selectedTargetWorkspace,
    targetIde
  ]);

  const moveStep = useCallback((delta: number) => {
    setActiveStepIndex((current) => clampIndex(current + delta, TRANSFER_STEPS.length));
  }, []);

  const moveActiveSelection = useCallback(
    (delta: number) => {
      if (activeStep === "source-ide") {
        setSourceIde((current) => cycleByDelta(IDE_OPTIONS, current, delta));
        setSourceWorkspaceIndex(0);
        setConversationIndex(0);
        return;
      }

      if (activeStep === "source-workspace") {
        setSourceWorkspaceIndex((current) => clampIndex(current + delta, sourceWorkspaces.length));
        setConversationIndex(0);
        return;
      }

      if (activeStep === "conversation") {
        setConversationIndex((current) => clampIndex(current + delta, conversations.length));
        return;
      }

      if (activeStep === "target-ide") {
        setTargetIde((current) => cycleByDelta(IDE_OPTIONS, current, delta));
        setTargetWorkspaceIndex(0);
        return;
      }

      if (activeStep === "target-workspace") {
        setTargetWorkspaceIndex((current) => clampIndex(current + delta, targetWorkspaces.length));
      }
    },
    [activeStep, conversations.length, sourceWorkspaces.length, targetWorkspaces.length]
  );

  useInput(
    (input, key) => {
      if (busy) {
        return;
      }

      if (inputMode === "inject-tags") {
        if (key.escape) {
          setInputMode("none");
          setNotice({
            tone: "info",
            message: "Tag input canceled"
          });
          return;
        }

        if (key.return) {
          const tags = parseTagInput(injectTagsDraft);
          setInjectTags(tags);
          setInputMode("none");
          setNotice({
            tone: "success",
            message: `Transfer tags set: ${tags.length > 0 ? tags.join(",") : "none"}`
          });
          return;
        }

        if (key.backspace || key.delete) {
          setInjectTagsDraft((current) => current.slice(0, -1));
          return;
        }

        if (input && !key.ctrl && !key.meta && input !== "\u0003") {
          setInjectTagsDraft((current) => `${current}${input}`);
        }

        return;
      }

      if (key.leftArrow || input === "b") {
        moveStep(-1);
        return;
      }

      if (key.rightArrow || input === "n") {
        moveStep(1);
        return;
      }

      if (key.upArrow) {
        moveActiveSelection(-1);
        return;
      }

      if (key.downArrow) {
        moveActiveSelection(1);
        return;
      }

      if (input === "s") {
        void scanSourceWorkspace();
        return;
      }

      if (input === "r") {
        void refreshCatalog();
        void refreshConversations();
        setNotice({
          tone: "info",
          message: "Refreshed IDE, workspace, and conversation catalog"
        });
        return;
      }

      if (input === "p") {
        setInjectPolicy((current) => cycleValue(INJECT_POLICIES, current));
        return;
      }

      if (input === "g") {
        setInjectScope((current) => cycleValue(INJECT_SCOPES, current));
        return;
      }

      if (input === "u") {
        setInjectSkipUnchanged((current) => !current);
        return;
      }

      if (input === "t") {
        setInjectTagsDraft(injectTags.join(","));
        setInputMode("inject-tags");
        setNotice({
          tone: "info",
          message: "Editing tags. Type comma-separated values and press Enter."
        });
        return;
      }

      if (!key.return) {
        return;
      }

      if (activeStep === "source-ide") {
        setActiveStepIndex(1);
        setNotice({
          tone: "success",
          message: `Source IDE selected: ${sourceIde}`
        });
        return;
      }

      if (activeStep === "source-workspace") {
        if (!selectedSourceWorkspace || selectedSourceWorkspace.source === "fallback") {
          setNotice({
            tone: "error",
            message: "Select a source workspace with real scan roots"
          });
          return;
        }

        setActiveStepIndex(2);
        void refreshConversations();
        setNotice({
          tone: "success",
          message: `Source workspace selected: ${selectedSourceWorkspace.label}`
        });
        return;
      }

      if (activeStep === "conversation") {
        if (!selectedConversation) {
          setNotice({
            tone: "error",
            message: "Select one conversation to continue"
          });
          return;
        }

        setActiveStepIndex(3);
        setNotice({
          tone: "success",
          message: `Conversation selected: ${selectedConversation.id.slice(0, 12)}`
        });
        return;
      }

      if (activeStep === "target-ide") {
        setActiveStepIndex(4);
        setNotice({
          tone: "success",
          message: `Target IDE selected: ${targetIde}`
        });
        return;
      }

      if (activeStep === "target-workspace") {
        if (!selectedTargetWorkspace || selectedTargetWorkspace.source === "fallback") {
          setNotice({
            tone: "error",
            message: "Select a concrete target workspace"
          });
          return;
        }

        setActiveStepIndex(5);
        setNotice({
          tone: "success",
          message: `Target workspace selected: ${selectedTargetWorkspace.label}`
        });
        return;
      }

      void transferSelectedConversation();
    },
    { isActive: props.isActive }
  );

  const activeList = useMemo(() => {
    if (activeStep === "source-ide") {
      return ideAvailability.map((item) => {
        const status = item.available ? "available" : "not-detected";
        return `${item.ide} · roots=${item.knownRoots.length} indexed=${item.discoveredCount} · ${status}`;
      });
    }

    if (activeStep === "source-workspace") {
      return sourceWorkspaces.map((item) => item.label);
    }

    if (activeStep === "conversation") {
      return conversations.map(
        (item) =>
          `${item.id.slice(0, 12)} · ${item.projectPath ?? item.projectGroup ?? "unknown"} · ${item.title}`
      );
    }

    if (activeStep === "target-ide") {
      return IDE_OPTIONS.map((item) => item);
    }

    if (activeStep === "target-workspace") {
      return targetWorkspaces.map((item) => item.label);
    }

    return [
      `Policy=${injectPolicy} Scope=${injectScope} SkipUnchanged=${injectSkipUnchanged ? "yes" : "no"} Tags=${injectTags.length > 0 ? injectTags.join(",") : "none"}`,
      "Press Enter to inject selected conversation into selected target IDE/workspace"
    ];
  }, [
    activeStep,
    conversations,
    ideAvailability,
    injectPolicy,
    injectScope,
    injectSkipUnchanged,
    injectTags,
    sourceWorkspaces,
    targetWorkspaces
  ]);

  const activeListIndex =
    activeStep === "source-ide"
      ? IDE_OPTIONS.indexOf(sourceIde)
      : activeStep === "source-workspace"
        ? sourceWorkspaceIndex
        : activeStep === "conversation"
          ? conversationIndex
          : activeStep === "target-ide"
            ? IDE_OPTIONS.indexOf(targetIde)
            : activeStep === "target-workspace"
              ? targetWorkspaceIndex
              : 0;

  const activeWindow = useMemo(
    () => toSelectedWindow(activeList, activeListIndex, 10),
    [activeList, activeListIndex]
  );

  const selectedFlowSummary = {
    source: `${sourceIde} / ${selectedSourceWorkspace?.label ?? "not-selected"}`,
    conversation: selectedConversation
      ? `${selectedConversation.id.slice(0, 12)} · ${truncateCell(selectedConversation.title, 42)}`
      : "not-selected",
    target: `${targetIde} / ${selectedTargetWorkspace?.label ?? "not-selected"}`
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Box flexGrow={1} marginRight={1}>
          <Panel title="Transfer Flow" accent>
            <AppText tone="muted">source IDE → source workspace → conversation → target IDE → target workspace → inject</AppText>
            {TRANSFER_STEPS.map((step, index) => {
              const isActiveStep = index === activeStepIndex;
              const isCompleteStep = index < activeStepIndex;
              const marker = isActiveStep ? "◉" : isCompleteStep ? "●" : "○";
              const value =
                step.id === "source-ide"
                  ? sourceIde
                  : step.id === "source-workspace"
                    ? selectedSourceWorkspace?.label ?? "not-selected"
                    : step.id === "conversation"
                      ? selectedConversation?.id.slice(0, 12) ?? "not-selected"
                      : step.id === "target-ide"
                        ? targetIde
                        : step.id === "target-workspace"
                          ? selectedTargetWorkspace?.label ?? "not-selected"
                          : "ready";

              return (
                <AppText key={step.id} tone={isActiveStep ? "accent" : isCompleteStep ? "success" : "primary"}>
                  {`${marker} ${step.label}: ${value}`}
                </AppText>
              );
            })}
          </Panel>
        </Box>

        <Box flexGrow={1}>
          <Panel title="Transfer Options">
            <AppText>{`Policy: ${injectPolicy}`}</AppText>
            <AppText>{`Scope: ${injectScope}`}</AppText>
            <AppText>{`Skip unchanged: ${injectSkipUnchanged ? "yes" : "no"}`}</AppText>
            <AppText>{`Tags: ${injectTags.length > 0 ? injectTags.join(",") : "none"}`}</AppText>
            <Box marginTop={1}>
              <AppText tone="muted">Shortcuts: p policy | g scope | u skip | t tags</AppText>
            </Box>
          </Panel>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Panel title={`Step ${activeStepIndex + 1}/${TRANSFER_STEPS.length} · ${TRANSFER_STEPS[activeStepIndex]?.label ?? "Unknown"}`} accent>
          <AppText tone="muted">{horizontalRule(72)}</AppText>

          {activeWindow.view.length === 0 ? (
            <AppText tone="muted">No options available for this step.</AppText>
          ) : (
            activeWindow.view.map((item, offset) => {
              const absoluteIndex = activeWindow.start + offset;
              const selected = absoluteIndex === activeListIndex;

              return (
                <AppText key={`${activeStep}:${absoluteIndex}`} tone={selected ? "accent" : "primary"}>
                  {`${selected ? "▶" : "·"} ${item}`}
                </AppText>
              );
            })
          )}
        </Panel>
      </Box>

      {inputMode === "inject-tags" ? (
        <Box marginTop={1}>
          <Panel title="Tag Editor">
            <AppText tone="accent">{`Tags: ${injectTagsDraft}`}</AppText>
            <AppText tone="muted">Enter to apply, Esc to cancel</AppText>
          </Panel>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Panel title="Transfer Summary">
          <AppText>{`Source: ${selectedFlowSummary.source}`}</AppText>
          <AppText>{`Conversation: ${selectedFlowSummary.conversation}`}</AppText>
          <AppText>{`Target: ${selectedFlowSummary.target}`}</AppText>
          <AppText tone="muted">{`Target project override: ${workspaceProjectOverride(selectedTargetWorkspace) ?? "n/a"}`}</AppText>
          <AppText tone="muted">{`Source file: ${selectedConversation ? truncateCell(selectedConversation.sourceFile, 90) : "n/a"}`}</AppText>
        </Panel>
      </Box>

      <Box marginTop={1}>
        <AppText tone="muted">
          Keys: ↑/↓ choose | Enter confirm step | b/n prev/next step | s scan selected source workspace | r refresh | p policy | g scope | u skip unchanged | t tags
        </AppText>
      </Box>

      <Box marginTop={1}>
        <NoticeLine busy={busy} notice={notice} />
      </Box>
    </Box>
  );
}

function ContextsScreen(props: {
  isActive: boolean;
  service: ContextService;
}): React.ReactElement {
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [rows, setRows] = useState<ContextEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<ScreenNotice>({
    tone: "info",
    message: "Press g to cycle scope, r to refresh, d to delete selected"
  });

  const refreshRows = useCallback(async () => {
    setBusy(true);

    try {
      const page = await props.service.listContextsPage({
        scope: scopeFilter === "all" ? undefined : scopeFilter,
        limit: 50
      });

      setRows(page.entries);
      setSelectedIndex((current) => clampIndex(current, page.entries.length));
      setNotice({
        tone: "success",
        message: `Loaded ${page.entries.length} context entr${page.entries.length === 1 ? "y" : "ies"}`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice({
        tone: "error",
        message: `Context load failed: ${message}`
      });
    } finally {
      setBusy(false);
    }
  }, [props.service, scopeFilter]);

  useEffect(() => {
    void refreshRows();
  }, [refreshRows]);

  const selectedEntry = rows[selectedIndex];

  const deleteSelected = useCallback(async () => {
    if (!selectedEntry) {
      setNotice({
        tone: "error",
        message: "No context entry selected"
      });
      setConfirmDelete(false);
      return;
    }

    setBusy(true);

    try {
      const deleted = await props.service.deleteContext(selectedEntry.id);
      setNotice({
        tone: deleted ? "success" : "error",
        message: deleted
          ? `Deleted context ${selectedEntry.id.slice(0, 8)}`
          : `Delete failed for ${selectedEntry.id.slice(0, 8)}`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice({
        tone: "error",
        message: `Delete failed: ${message}`
      });
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }

    await refreshRows();
  }, [props.service, refreshRows, selectedEntry]);

  useInput(
    (input, key) => {
      if (busy) {
        return;
      }

      if (confirmDelete) {
        if (input.toLowerCase() === "y") {
          void deleteSelected();
          return;
        }

        if (input.toLowerCase() === "n" || key.escape) {
          setConfirmDelete(false);
          setNotice({
            tone: "info",
            message: "Delete canceled"
          });
        }

        return;
      }

      if (key.upArrow) {
        setSelectedIndex((current) => clampIndex(current - 1, rows.length));
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((current) => clampIndex(current + 1, rows.length));
        return;
      }

      if (input === "g") {
        setScopeFilter((current) => cycleValue(SCOPE_FILTERS, current));
        setSelectedIndex(0);
        return;
      }

      if (input === "r") {
        void refreshRows();
        return;
      }

      if (input === "d") {
        if (!selectedEntry) {
          setNotice({
            tone: "error",
            message: "No context entry selected"
          });
          return;
        }

        setConfirmDelete(true);
        setNotice({
          tone: "info",
          message: `Confirm delete ${selectedEntry.id.slice(0, 8)} with y, cancel with n`
        });
      }
    },
    { isActive: props.isActive }
  );

  const rowWindow = useMemo(() => toSelectedWindow(rows, selectedIndex, 10), [rows, selectedIndex]);

  return (
    <Box flexDirection="column">
      <Panel title="Context Index" accent>
        <AppText>{`Scope filter: ${scopeFilter}`}</AppText>
        <AppText tone="muted">Keys: g scope | r refresh | up/down select | d delete | y/n confirm</AppText>

        <Box marginTop={1} flexDirection="column">
          <AppText tone="muted">{[padCell("ID", 10), padCell("SOURCE", 16), padCell("SCOPE", 8), "CONTENT"].join(" ")}</AppText>
          <AppText tone="muted">{["─".repeat(10), "─".repeat(16), "─".repeat(8), "─".repeat(44)].join(" ")}</AppText>

          {rowWindow.view.length === 0 ? (
            <AppText tone="muted">No context entries for current scope filter.</AppText>
          ) : (
            rowWindow.view.map((entry, offset) => {
              const absoluteIndex = rowWindow.start + offset;
              const selected = absoluteIndex === selectedIndex;

              return (
                <AppText key={entry.id} tone={selected ? "accent" : "primary"}>
                  {selected ? "▶" : "·"} {padCell(entry.id.slice(0, 10), 10)} {padCell(entry.sourceTool, 16)} {padCell(entry.scope, 8)} {truncateCell(entry.content, 44)}
                </AppText>
              );
            })
          )}
        </Box>
      </Panel>

      <Box marginTop={1}>
        <Panel title="Selected Context">
          <AppText>
            Selected: {selectedEntry ? `${selectedEntry.id.slice(0, 12)} encrypted=${selectedEntry.encrypted ? "yes" : "no"}` : "none"}
          </AppText>
          <AppText>
            Tags: {selectedEntry && selectedEntry.tags.length > 0 ? selectedEntry.tags.join(",") : "none"}
          </AppText>
          <AppText tone="muted">Updated: {shortTimestamp(selectedEntry?.updatedAt)}</AppText>
        </Panel>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <NoticeLine busy={busy} notice={notice} />
      </Box>
    </Box>
  );
}
