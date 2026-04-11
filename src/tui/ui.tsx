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
  selectedText: "black",
  info: "cyan",
  success: "green",
  error: "red",
  frame: "gray"
} as const;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

type TextTone = "primary" | "muted" | "accent" | "selected" | "info" | "success" | "error";

const TEXT_TONE_COLOR: Record<TextTone, string> = {
  primary: UI_THEME.primary,
  muted: UI_THEME.muted,
  accent: UI_THEME.accent,
  selected: UI_THEME.selectedText,
  info: UI_THEME.info,
  success: UI_THEME.success,
  error: UI_THEME.error
};

interface NoticeVisual {
  icon: string;
  tone: TextTone;
}

interface TransferListRow {
  key: string;
  primary: string;
  secondary?: string;
  tertiary?: string;
  chipLabel?: string;
  chipTone?: TextTone;
  tone?: TextTone;
}

interface TransferColumnLabels {
  primary: string;
  secondary: string;
  tertiary: string;
}

function AppText(props: {
  children: React.ReactNode;
  tone?: TextTone;
  bold?: boolean;
  inverse?: boolean;
}): React.ReactElement {
  return (
    <Text color={TEXT_TONE_COLOR[props.tone ?? "primary"]} bold={props.bold} inverse={props.inverse}>
      {props.children}
    </Text>
  );
}

function useSpinner(active: boolean): string {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      setFrameIndex(0);
      return;
    }

    const timer = setInterval(() => {
      setFrameIndex((current) => (current + 1) % SPINNER_FRAMES.length);
    }, 80);

    return () => {
      clearInterval(timer);
    };
  }, [active]);

  return SPINNER_FRAMES[frameIndex] ?? SPINNER_FRAMES[0];
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

function transferColumnLabels(step: TransferStepId): TransferColumnLabels {
  if (step === "source-ide" || step === "target-ide") {
    return {
      primary: "IDE",
      secondary: "ROOTS",
      tertiary: "STATUS"
    };
  }

  if (step === "conversation") {
    return {
      primary: "CONVERSATION",
      secondary: "PROJECT",
      tertiary: "ID / CONF"
    };
  }

  if (step === "confirm") {
    return {
      primary: "ACTION",
      secondary: "SCOPE",
      tertiary: "DETAILS"
    };
  }

  return {
    primary: "WORKSPACE",
    secondary: "SOURCE",
    tertiary: "PATH"
  };
}

function compactMetadataLine(row: TransferListRow, width: number): string {
  const segments = [row.secondary, row.tertiary]
    .map((value) => (value ?? "").trim())
    .filter((value) => value.length > 0);

  if (segments.length === 0) {
    return "";
  }

  return truncateCell(segments.join(" · "), width);
}

function transferStepHint(step: TransferStepId): string {
  if (step === "source-ide") {
    return "Pick which IDE the conversations should be scanned from.";
  }

  if (step === "source-workspace") {
    return "Choose a source workspace root to narrow the catalog.";
  }

  if (step === "conversation") {
    return "Select one conversation snapshot to transfer.";
  }

  if (step === "target-ide") {
    return "Choose where the imported snapshot should be exported.";
  }

  if (step === "target-workspace") {
    return "Select the destination workspace/project override path.";
  }

  return "Review policy and tags, then press Enter to execute transfer.";
}

function workspaceSourceChip(source: WorkspaceOption["source"]): {
  label: string;
  tone: TextTone;
} {
  if (source === "machine-workspace" || source === "machine-root") {
    return {
      label: "LOCAL",
      tone: "success"
    };
  }

  if (source === "fallback") {
    return {
      label: "NONE",
      tone: "error"
    };
  }

  return {
    label: "INDEXED",
    tone: "info"
  };
}

function confidenceChip(value: "high" | "medium" | "low" | undefined): {
  label: string;
  tone: TextTone;
} {
  if (value === "high") {
    return {
      label: "HIGH",
      tone: "success"
    };
  }

  if (value === "medium") {
    return {
      label: "MED",
      tone: "accent"
    };
  }

  return {
    label: "LOW",
    tone: "muted"
  };
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

function toneForSelection(selected: boolean, baseTone: TextTone = "primary"): TextTone {
  return selected ? "selected" : baseTone;
}

function SelectionRow(props: {
  selected?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return <Box paddingX={1}>{props.children}</Box>;
}

function NoticeLine(props: { busy?: boolean; notice: ScreenNotice }): React.ReactElement {
  const visual = getNoticeVisual(props.notice.tone);
  const spinner = useSpinner(Boolean(props.busy));

  return (
    <AppText tone={props.busy ? "info" : visual.tone}>
      {props.busy ? `${spinner} Working...` : `${visual.icon} ${props.notice.message}`}
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
  const terminalWidth = process.stdout.columns ?? 120;
  const terminalHeight = process.stdout.rows ?? 40;
  const [activeTabIndex, setActiveTabIndex] = useState(0);

  const activeTab = TABS[activeTabIndex]?.id ?? "dashboard";
  const compactShell = terminalWidth < 120;
  const compactHeight = terminalHeight < 46;

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
      <Box borderStyle="single" borderColor={UI_THEME.frame} paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <AppText tone="accent" bold>
            ◈ Pluro Terminal Console v{props.version}
          </AppText>
          <AppText tone="muted">{shortTimestamp(new Date().toISOString())}</AppText>
        </Box>
        <AppText tone="muted">Data root: {truncateCell(props.dataDir, compactShell ? 56 : 96)}</AppText>
      </Box>

      <Box marginTop={compactHeight ? 0 : 1} borderStyle="single" borderColor={UI_THEME.frame} paddingX={1}>
        {TABS.map((tab, index) => {
          const selected = tab.id === activeTab;
          const label = `${index + 1}:${tab.label}`;

          return (
            <Box key={tab.id} marginRight={2}>
              <AppText tone={selected ? "accent" : "muted"} bold={selected} inverse={selected}>
                {selected ? ` ${label} ` : ` ${label} `}
              </AppText>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={compactHeight ? 0 : 1} flexDirection="column" flexGrow={1}>
        {activeTab === "dashboard" ? (
          <DashboardScreen
            isActive
            service={props.service}
            discovery={props.discovery}
            compactHeight={compactHeight}
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
            compactHeight={compactHeight}
          />
        ) : null}

        {activeTab === "contexts" ? <ContextsScreen isActive service={props.service} compactHeight={compactHeight} /> : null}
      </Box>

      <Box marginTop={compactHeight ? 0 : 1} borderStyle="single" borderColor={UI_THEME.frame} paddingX={1}>
        <AppText tone="muted">Global keys: Tab/Shift+Tab panels | 1/2/3 jump | q quit</AppText>
      </Box>
    </Box>
  );
}

function DashboardScreen(props: {
  isActive: boolean;
  service: ContextService;
  discovery: ConversationDiscoveryService;
  compactHeight: boolean;
  onOpenTab: (tab: TabId) => void;
}): React.ReactElement {
  const terminalWidth = process.stdout.columns ?? 120;
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
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<ScreenNotice>({
    tone: "info",
    message: "Loading dashboard"
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
  const stackedCards = terminalWidth < 132;
  const showWhatsNewPanel = !props.compactHeight;

  return (
    <Box flexDirection="column">
      <Box flexDirection={stackedCards ? "column" : "row"}>
        <Box flexGrow={1} marginRight={stackedCards ? 0 : 1}>
          <Panel title="Session" accent>
            <AppText tone="accent" bold>{`Welcome back, ${operatorName}`}</AppText>
            <AppText tone="muted">Workspaces ready for cross-IDE transfer.</AppText>
            {props.compactHeight ? (
              <AppText tone="muted">
                {`IDEs: Cursor ${summary.byIde.cursor > 0 ? "●" : "○"} | VS Code ${summary.byIde["vscode-copilot"] > 0 ? "●" : "○"} | Antigravity ${summary.byIde.antigravity > 0 ? "●" : "○"}`}
              </AppText>
            ) : (
              <>
                <Box marginTop={1}>
                  <AppText tone="muted">Agentic IDEs</AppText>
                </Box>
                <AppText>{`Cursor ${summary.byIde.cursor > 0 ? "●" : "○"}`}</AppText>
                <AppText>{`VS Code Copilot ${summary.byIde["vscode-copilot"] > 0 ? "●" : "○"}`}</AppText>
                <AppText>{`Antigravity ${summary.byIde.antigravity > 0 ? "●" : "○"}`}</AppText>
              </>
            )}
          </Panel>
        </Box>

        <Box flexGrow={1} marginTop={stackedCards ? 1 : 0}>
          <Panel title="Recent Activity">
            <AppText>{`Indexed conversations: ${summary.discoveredCount}`}</AppText>
            <AppText>{`Recent contexts cached: ${summary.recentContextCount}`}</AppText>
            <AppText>{`Confidence: high=${summary.confidence.high} medium=${summary.confidence.medium} low=${summary.confidence.low}`}</AppText>
            <AppText tone="muted">Last scan: {shortTimestamp(summary.lastScannedAt)}</AppText>
            <AppText tone="muted">Press r to refresh telemetry.</AppText>
          </Panel>
        </Box>
      </Box>

      {showWhatsNewPanel ? (
        <Box marginTop={1}>
          <Panel title="What Is New">
            <AppText tone="accent">/transfer panel now supports source+target workspace selection</AppText>
            <AppText>/scan a selected source workspace directly before transfer</AppText>
            <AppText>/inject with policy, scope, skip mode, and tag controls</AppText>
            <AppText tone="muted">Shortcuts: 2 transfer panel, 3 contexts panel, q quit</AppText>
          </Panel>
        </Box>
      ) : null}

      <Box marginTop={props.compactHeight ? 0 : 1}>
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
  compactHeight: boolean;
}): React.ReactElement {
  const terminalWidth = process.stdout.columns ?? 120;
  const terminalHeight = process.stdout.rows ?? 40;
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

  const activeRows = useMemo<TransferListRow[]>(() => {
    if (activeStep === "source-ide") {
      return ideAvailability.map((item) => {
        const statusChip = item.available
          ? {
              label: "READY",
              tone: "success" as const
            }
          : {
              label: "OFFLINE",
              tone: "error" as const
            };

        return {
          key: `source-ide:${item.ide}`,
          primary: item.ide,
          secondary: `roots ${item.knownRoots.length}`,
          tertiary: `indexed ${item.discoveredCount}`,
          chipLabel: statusChip.label,
          chipTone: statusChip.tone,
          tone: item.available ? "primary" : "muted"
        };
      });
    }

    if (activeStep === "source-workspace") {
      return sourceWorkspaces.map((item) => ({
        key: `source-workspace:${item.id}`,
        primary: item.label,
        secondary: item.workspaceId ? `workspace ${item.workspaceId}` : item.source,
        tertiary:
          item.scanRoots.length > 0
            ? truncateCell(item.scanRoots[0] ?? "", 56)
            : "no scan roots",
        chipLabel: workspaceSourceChip(item.source).label,
        chipTone: workspaceSourceChip(item.source).tone
      }));
    }

    if (activeStep === "conversation") {
      return conversations.map((item) => {
        const confidence = confidenceChip(item.projectConfidence);

        return {
          key: `conversation:${item.id}`,
          primary: item.title,
          secondary: item.projectPath ?? item.projectGroup ?? "unknown project",
          tertiary: `${item.id.slice(0, 12)} conf ${item.projectConfidence ?? "low"}`,
          chipLabel: confidence.label,
          chipTone: confidence.tone,
          tone: confidence.tone
        };
      });
    }

    if (activeStep === "target-ide") {
      return IDE_OPTIONS.map((item) => ({
        key: `target-ide:${item}`,
        primary: item,
        chipLabel: "TARGET",
        chipTone: "info"
      }));
    }

    if (activeStep === "target-workspace") {
      return targetWorkspaces.map((item) => ({
        key: `target-workspace:${item.id}`,
        primary: item.label,
        secondary: item.workspaceId ? `workspace ${item.workspaceId}` : item.source,
        tertiary:
          item.scanRoots.length > 0
            ? truncateCell(item.scanRoots[0] ?? "", 56)
            : "no scan roots",
        chipLabel: workspaceSourceChip(item.source).label,
        chipTone: workspaceSourceChip(item.source).tone
      }));
    }

    return [
      {
        key: "confirm:config",
        primary: `Policy ${injectPolicy}`,
        secondary: `Scope ${injectScope}`,
        tertiary: `Skip ${injectSkipUnchanged ? "yes" : "no"} · Tags ${injectTags.length > 0 ? injectTags.join(",") : "none"}`,
        chipLabel: "REVIEW",
        chipTone: "accent"
      },
      {
        key: "confirm:cta",
        primary: "Press Enter to inject selected conversation into selected target IDE workspace",
        tone: "muted"
      }
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
    () => toSelectedWindow(activeRows, activeListIndex, props.compactHeight ? Math.max(4, terminalHeight - 35) : 10),
    [activeRows, activeListIndex, props.compactHeight, terminalHeight]
  );

  const selectedFlowSummary = {
    source: `${sourceIde} / ${selectedSourceWorkspace?.label ?? "not-selected"}`,
    conversation: selectedConversation
      ? `${selectedConversation.id.slice(0, 12)} · ${truncateCell(selectedConversation.title, 42)}`
      : "not-selected",
    target: `${targetIde} / ${selectedTargetWorkspace?.label ?? "not-selected"}`
  };

  const showSplitLayout = terminalWidth >= 132;
  const compactTransferRows = terminalWidth < 116;
  const labels = transferColumnLabels(activeStep);
  const stepHint = transferStepHint(activeStep);

  const transferFlowPanel = (
    <Panel title="Transfer Flow" accent>
      <AppText tone="muted">source IDE to source workspace to conversation to target IDE to target workspace to inject</AppText>
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
  );

  const transferOptionsPanel = (
    <Panel title="Transfer Options">
      <AppText>{`Policy: ${injectPolicy}`}</AppText>
      <AppText>{`Scope: ${injectScope}`}</AppText>
      <AppText>{`Skip unchanged: ${injectSkipUnchanged ? "yes" : "no"}`}</AppText>
      <AppText>{`Tags: ${injectTags.length > 0 ? injectTags.join(",") : "none"}`}</AppText>
      <Box marginTop={1}>
        <AppText tone="muted">Shortcuts: p policy | g scope | u skip | t tags</AppText>
      </Box>
    </Panel>
  );

  const activeStepPanel = (
    <Panel
      title={`Step ${activeStepIndex + 1}/${TRANSFER_STEPS.length} · ${TRANSFER_STEPS[activeStepIndex]?.label ?? "Unknown"}`}
      accent
    >
      <AppText tone="muted">{horizontalRule(showSplitLayout ? 80 : 64)}</AppText>
      <AppText tone="info">{stepHint}</AppText>

      {activeWindow.view.length === 0 ? (
        <AppText tone="muted">No options available for this step.</AppText>
      ) : (
        <>
          {compactTransferRows ? (
            <SelectionRow>
              <Box width={4}>
                <AppText tone="muted">#</AppText>
              </Box>
              <Box flexGrow={1}>
                <AppText tone="muted">{labels.primary}</AppText>
              </Box>
            </SelectionRow>
          ) : (
            <SelectionRow>
              <Box width={4}>
                <AppText tone="muted">#</AppText>
              </Box>
              <Box flexGrow={1}>
                <AppText tone="muted">{labels.primary}</AppText>
              </Box>
              <Box width={showSplitLayout ? 25 : 18}>
                <AppText tone="muted">{labels.secondary}</AppText>
              </Box>
              <Box width={showSplitLayout ? 33 : 24}>
                <AppText tone="muted">{labels.tertiary}</AppText>
              </Box>
            </SelectionRow>
          )}
          <AppText tone="muted">{horizontalRule(showSplitLayout ? 80 : 64)}</AppText>

          {activeWindow.view.map((row, offset) => {
            const absoluteIndex = activeWindow.start + offset;
            const selected = absoluteIndex === activeListIndex;
            const primaryTone = toneForSelection(selected, row.tone ?? "primary");
            const metadataTone = toneForSelection(selected, "muted");
            const chipTone = toneForSelection(selected, row.chipTone ?? "info");
            const chipWidth = row.chipLabel ? row.chipLabel.length + 4 : 0;

            if (compactTransferRows) {
              const compactMeta = compactMetadataLine(row, Math.max(20, terminalWidth - 18));

              return (
                <SelectionRow key={row.key} selected={selected}>
                  <Box flexDirection="column" flexGrow={1}>
                    <Box>
                      <Box width={4}>
                        <AppText tone={primaryTone} inverse={selected}>{`${absoluteIndex + 1}.`}</AppText>
                      </Box>
                      <Box flexGrow={1}>
                        <Box>
                          <AppText tone={primaryTone} inverse={selected}>{truncateCell(row.primary, Math.max(16, terminalWidth - 16 - chipWidth))}</AppText>
                          {row.chipLabel ? (
                            <Box marginLeft={1}>
                              <AppText tone={chipTone} inverse={selected}>{`[${row.chipLabel}]`}</AppText>
                            </Box>
                          ) : null}
                        </Box>
                      </Box>
                    </Box>
                    {compactMeta.length > 0 ? (
                      <Box marginLeft={4}>
                        <AppText tone={metadataTone} inverse={selected}>{compactMeta}</AppText>
                      </Box>
                    ) : null}
                  </Box>
                </SelectionRow>
              );
            }

            return (
              <SelectionRow key={row.key} selected={selected}>
                <Box width={4}>
                  <AppText tone={primaryTone} inverse={selected}>{`${absoluteIndex + 1}.`}</AppText>
                </Box>
                <Box flexGrow={1}>
                  <Box>
                    <AppText tone={primaryTone} inverse={selected}>{truncateCell(row.primary, Math.max(12, (showSplitLayout ? 40 : 30) - chipWidth))}</AppText>
                    {row.chipLabel ? (
                      <Box marginLeft={1}>
                        <AppText tone={chipTone} inverse={selected}>{`[${row.chipLabel}]`}</AppText>
                      </Box>
                    ) : null}
                  </Box>
                </Box>
                <Box width={showSplitLayout ? 25 : 18}>
                  <AppText tone={metadataTone} inverse={selected}>{truncateCell(row.secondary ?? "", showSplitLayout ? 23 : 16)}</AppText>
                </Box>
                <Box width={showSplitLayout ? 33 : 24}>
                  <AppText tone={metadataTone} inverse={selected}>{truncateCell(row.tertiary ?? "", showSplitLayout ? 31 : 22)}</AppText>
                </Box>
              </SelectionRow>
            );
          })}
        </>
      )}
    </Panel>
  );

  const tagEditorPanel =
    inputMode === "inject-tags" ? (
      <Panel title="Tag Editor">
        <AppText tone="accent">{`Tags: ${injectTagsDraft}`}</AppText>
        <AppText tone="muted">Enter to apply, Esc to cancel</AppText>
      </Panel>
    ) : null;

  const summaryPanel = (
    <Panel title="Transfer Summary">
      {props.compactHeight ? (
        <>
          <AppText>{`Source: ${sourceIde} -> Target: ${targetIde}`}</AppText>
          <AppText tone="muted">{`Conversation: ${selectedConversation ? selectedConversation.id.slice(0, 12) : "not-selected"}`}</AppText>
        </>
      ) : (
        <>
          <AppText>{`Source: ${selectedFlowSummary.source}`}</AppText>
          <AppText>{`Conversation: ${selectedFlowSummary.conversation}`}</AppText>
          <AppText>{`Target: ${selectedFlowSummary.target}`}</AppText>
          <AppText tone="muted">{`Target project override: ${workspaceProjectOverride(selectedTargetWorkspace) ?? "n/a"}`}</AppText>
          <AppText tone="muted">{`Source file: ${selectedConversation ? truncateCell(selectedConversation.sourceFile, 90) : "n/a"}`}</AppText>
        </>
      )}
    </Panel>
  );

  return (
    <Box flexDirection="column">
      {showSplitLayout ? (
        <Box>
          <Box width={52} marginRight={1} flexDirection="column">
            {transferFlowPanel}
            <Box marginTop={1}>{transferOptionsPanel}</Box>
          </Box>

          <Box flexGrow={1} flexDirection="column">
            {activeStepPanel}
            {tagEditorPanel ? <Box marginTop={1}>{tagEditorPanel}</Box> : null}
            <Box marginTop={1}>{summaryPanel}</Box>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {transferFlowPanel}
          <Box marginTop={1}>{transferOptionsPanel}</Box>
          <Box marginTop={1}>{activeStepPanel}</Box>
          {tagEditorPanel ? <Box marginTop={1}>{tagEditorPanel}</Box> : null}
          <Box marginTop={1}>{summaryPanel}</Box>
        </Box>
      )}

      <Box marginTop={props.compactHeight ? 0 : 1}>
        <AppText tone="muted">
          {props.compactHeight
            ? "Keys: ↑/↓ choose | Enter confirm | b/n step | s scan | r refresh | p/g/u/t options"
            : "Keys: ↑/↓ choose | Enter confirm step | b/n prev/next step | s scan selected source workspace | r refresh | p policy | g scope | u skip unchanged | t tags"}
        </AppText>
      </Box>

      <Box marginTop={props.compactHeight ? 0 : 1}>
        <NoticeLine busy={busy} notice={notice} />
      </Box>
    </Box>
  );
}

function ContextsScreen(props: {
  isActive: boolean;
  service: ContextService;
  compactHeight: boolean;
}): React.ReactElement {
  const terminalWidth = process.stdout.columns ?? 120;
  const terminalHeight = process.stdout.rows ?? 40;
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

  const rowWindow = useMemo(
    () => toSelectedWindow(rows, selectedIndex, props.compactHeight ? Math.max(4, terminalHeight - 30) : 10),
    [rows, selectedIndex, props.compactHeight, terminalHeight]
  );
  const contentColumnWidth = Math.max(24, terminalWidth - 58);

  return (
    <Box flexDirection="column">
      <Panel title="Context Index" accent>
        <AppText>{`Scope filter: ${scopeFilter}`}</AppText>
        <AppText tone="muted">Keys: g scope | r refresh | up/down select | d delete | y/n confirm</AppText>

        <Box marginTop={1} flexDirection="column">
          <SelectionRow>
            <Box width={12}>
              <AppText tone="muted">ID</AppText>
            </Box>
            <Box width={18}>
              <AppText tone="muted">SOURCE</AppText>
            </Box>
            <Box width={10}>
              <AppText tone="muted">SCOPE</AppText>
            </Box>
            <Box width={contentColumnWidth}>
              <AppText tone="muted">CONTENT</AppText>
            </Box>
          </SelectionRow>
          <AppText tone="muted">{horizontalRule(Math.max(40, terminalWidth - 16))}</AppText>

          {rowWindow.view.length === 0 ? (
            <AppText tone="muted">No context entries for current scope filter.</AppText>
          ) : (
            rowWindow.view.map((entry, offset) => {
              const absoluteIndex = rowWindow.start + offset;
              const selected = absoluteIndex === selectedIndex;

              return (
                <SelectionRow key={entry.id} selected={selected}>
                  <Box width={12}>
                    <AppText tone={toneForSelection(selected)} inverse={selected}>{entry.id.slice(0, 10)}</AppText>
                  </Box>
                  <Box width={18}>
                    <AppText tone={toneForSelection(selected)} inverse={selected}>{truncateCell(entry.sourceTool, 16)}</AppText>
                  </Box>
                  <Box width={10}>
                    <AppText tone={toneForSelection(selected)} inverse={selected}>{entry.scope}</AppText>
                  </Box>
                  <Box width={contentColumnWidth}>
                    <AppText tone={toneForSelection(selected)} inverse={selected}>{truncateCell(entry.content, contentColumnWidth - 2)}</AppText>
                  </Box>
                </SelectionRow>
              );
            })
          )}
        </Box>
      </Panel>

      <Box marginTop={props.compactHeight ? 0 : 1}>
        <Panel title="Selected Context">
          {props.compactHeight ? (
            <>
              <AppText>
                Selected: {selectedEntry ? `${selectedEntry.id.slice(0, 12)} encrypted=${selectedEntry.encrypted ? "yes" : "no"}` : "none"}
              </AppText>
              <AppText tone="muted">Updated: {shortTimestamp(selectedEntry?.updatedAt)}</AppText>
            </>
          ) : (
            <>
              <AppText>
                Selected: {selectedEntry ? `${selectedEntry.id.slice(0, 12)} encrypted=${selectedEntry.encrypted ? "yes" : "no"}` : "none"}
              </AppText>
              <AppText>
                Tags: {selectedEntry && selectedEntry.tags.length > 0 ? selectedEntry.tags.join(",") : "none"}
              </AppText>
              <AppText tone="muted">Updated: {shortTimestamp(selectedEntry?.updatedAt)}</AppText>
            </>
          )}
        </Panel>
      </Box>

      <Box marginTop={props.compactHeight ? 0 : 1} flexDirection="column">
        <NoticeLine busy={busy} notice={notice} />
      </Box>
    </Box>
  );
}
