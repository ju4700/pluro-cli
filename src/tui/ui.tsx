import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import type { ContextService } from "../core/context-service";
import type { ConversationDiscoveryService } from "../core/conversation-discovery";
import type { ContextEntry, ContextScope, DiscoveredConversation, SupportedIde } from "../core/types";

type TabId = "dashboard" | "conversations" | "contexts";
type IdeFilter = "all" | SupportedIde;
type ConfidenceFilter = "all" | "high" | "medium" | "low";
type ScopeFilter = "all" | ContextScope;
type InjectPolicy = "lww" | "keep-both";
type InjectScope = "global" | "project" | "session";
type ConversationInputMode = "none" | "project-query" | "source-query" | "inject-tags";

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
  { id: "conversations", label: "Conversations" },
  { id: "contexts", label: "Contexts" }
];

const IDE_FILTERS: ReadonlyArray<IdeFilter> = ["all", "cursor", "vscode-copilot", "antigravity"];
const SCAN_IDE_OPTIONS: ReadonlyArray<SupportedIde> = ["cursor", "vscode-copilot", "antigravity"];
const CONFIDENCE_FILTERS: ReadonlyArray<ConfidenceFilter> = ["all", "high", "medium", "low"];
const SCOPE_FILTERS: ReadonlyArray<ScopeFilter> = ["all", "global", "project", "session"];
const INJECT_POLICIES: ReadonlyArray<InjectPolicy> = ["keep-both", "lww"];
const INJECT_SCOPES: ReadonlyArray<InjectScope> = ["project", "session", "global"];

function cycleValue<T>(values: readonly T[], current: T): T {
  const index = values.indexOf(current);

  if (index < 0) {
    return values[0] as T;
  }

  return values[(index + 1) % values.length] as T;
}

function truncateCell(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  if (width <= 1) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 1)}~`;
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

function getNoticeColor(tone: ScreenNotice["tone"]): "blue" | "green" | "red" {
  if (tone === "success") {
    return "green";
  }

  if (tone === "error") {
    return "red";
  }

  return "blue";
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
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0}>
      <Text color="cyan">Pluro Terminal UI v{props.version}</Text>
      <Text color="gray">Data: {props.dataDir}</Text>
      <Box marginTop={1}>
        {TABS.map((tab, index) => {
          const selected = tab.id === activeTab;
          const label = `${index + 1}:${tab.label}`;

          return (
            <Box key={tab.id} marginRight={2}>
              <Text color={selected ? "green" : "gray"}>{selected ? `[${label}]` : label}</Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1} flexDirection="column" minHeight={20}>
        {activeTab === "dashboard" ? (
          <DashboardScreen
            isActive
            service={props.service}
            discovery={props.discovery}
            onOpenTab={(tabId) => setActiveTabIndex(TABS.findIndex((tab) => tab.id === tabId))}
          />
        ) : null}

        {activeTab === "conversations" ? (
          <ConversationsScreen isActive service={props.service} discovery={props.discovery} defaultIde={props.defaultIde} />
        ) : null}

        {activeTab === "contexts" ? (
          <ContextsScreen isActive service={props.service} />
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Text color="gray">Global keys: Tab/Shift+Tab switch panels | 1/2/3 jump | q quit</Text>
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
        message: `Dashboard refreshed: contexts=${recentContextPage.entries.length}, conversations=${conversations.length}`
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

  return (
    <Box flexDirection="column">
      <Text color="yellow">Conversation workflow is primary: scan, filter, and inject from the Conversations panel.</Text>
      <Text>Recent contexts cached: {summary.recentContextCount}</Text>
      <Text>
        Discovered conversations: {summary.discoveredCount} (cursor:{summary.byIde.cursor}, vscode:{summary.byIde["vscode-copilot"]}, antigravity:{summary.byIde.antigravity})
      </Text>
      <Text>
        Confidence distribution: high={summary.confidence.high} medium={summary.confidence.medium} low={summary.confidence.low}
      </Text>
      <Text>Last scan timestamp: {shortTimestamp(summary.lastScannedAt)}</Text>
      <Box marginTop={1}>
        <Text color="gray">Panel keys: r refresh | 2 conversations | 3 contexts</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={getNoticeColor(notice.tone)}>{busy ? "Working..." : notice.message}</Text>
      </Box>
    </Box>
  );
}

function ConversationsScreen(props: {
  isActive: boolean;
  service: ContextService;
  discovery: ConversationDiscoveryService;
  defaultIde: SupportedIde;
}): React.ReactElement {
  const [ideFilter, setIdeFilter] = useState<IdeFilter>("all");
  const [scanIde, setScanIde] = useState<SupportedIde>(props.defaultIde);
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [projectQuery, setProjectQuery] = useState("");
  const [projectQueryDraft, setProjectQueryDraft] = useState("");
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceQueryDraft, setSourceQueryDraft] = useState("");
  const [inputMode, setInputMode] = useState<ConversationInputMode>("none");
  const [showInjectModal, setShowInjectModal] = useState(false);
  const [injectPolicy, setInjectPolicy] = useState<InjectPolicy>("keep-both");
  const [injectScope, setInjectScope] = useState<InjectScope>("project");
  const [injectSkipUnchanged, setInjectSkipUnchanged] = useState(true);
  const [injectTags, setInjectTags] = useState<string[]>([]);
  const [injectTagsDraft, setInjectTagsDraft] = useState("");
  const [sourceOptions, setSourceOptions] = useState<string[]>(["all"]);
  const [rows, setRows] = useState<DiscoveredConversation[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ScreenNotice>({
    tone: "info",
    message: "Press s to scan, i/c/o to cycle filters, / and f for text filters, Enter for inject options"
  });

  const refreshRows = useCallback(async () => {
    setBusy(true);

    try {
      const baseRows = props.discovery.list({
        ide: ideFilter === "all" ? undefined : ideFilter,
        projectConfidence: confidenceFilter === "all" ? undefined : confidenceFilter,
        limit: 5000
      });

      const discoveredSources = [...new Set(baseRows.map((row) => row.projectSource ?? "unknown"))].sort();
      const nextSourceOptions = ["all", ...discoveredSources];
      const normalizedSource = nextSourceOptions.includes(sourceFilter) ? sourceFilter : "all";

      const filteredRows =
        normalizedSource === "all"
          ? baseRows
          : baseRows.filter((row) => (row.projectSource ?? "unknown") === normalizedSource);

      const projectNeedle = projectQuery.trim().toLowerCase();
      const sourceNeedle = sourceQuery.trim().toLowerCase();

      const textFilteredRows = filteredRows.filter((row) => {
        const projectValue = (row.projectPath ?? row.projectGroup ?? "unknown").toLowerCase();
        const sourceValue = (row.projectSource ?? "unknown").toLowerCase();
        const titleValue = row.title.toLowerCase();
        const fileValue = row.sourceFile.toLowerCase();

        const projectMatch =
          projectNeedle.length === 0 || projectValue.includes(projectNeedle) || titleValue.includes(projectNeedle);
        const sourceMatch =
          sourceNeedle.length === 0 || sourceValue.includes(sourceNeedle) || fileValue.includes(sourceNeedle);

        return projectMatch && sourceMatch;
      });

      setSourceOptions(nextSourceOptions);
      if (normalizedSource !== sourceFilter) {
        setSourceFilter(normalizedSource);
      }

      const visibleRows = textFilteredRows.slice(0, 200);

      setRows(visibleRows);
      setSelectedIndex((current) => clampIndex(current, visibleRows.length));
      setNotice({
        tone: "success",
        message: `Loaded ${visibleRows.length} conversation(s) from local index`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice({
        tone: "error",
        message: `Conversation load failed: ${message}`
      });
    } finally {
      setBusy(false);
    }
  }, [confidenceFilter, ideFilter, projectQuery, props.discovery, sourceFilter, sourceQuery]);

  useEffect(() => {
    void refreshRows();
  }, [refreshRows]);

  const selectedConversation = rows[selectedIndex];

  const runScan = useCallback(async () => {
    const targetIde = ideFilter === "all" ? scanIde : ideFilter;

    setBusy(true);

    try {
      const result = await props.discovery.scan({
        ide: targetIde
      });

      setNotice({
        tone: result.errors.length > 0 ? "error" : "success",
        message: `Scan ${targetIde}: discovered=${result.discovered} skipped=${result.skipped} errors=${result.errors.length}`
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

    await refreshRows();
  }, [ideFilter, props.discovery, refreshRows, scanIde]);

  const injectSelected = useCallback(async () => {
    if (!selectedConversation) {
      setNotice({
        tone: "error",
        message: "No conversation selected to inject"
      });
      return;
    }

    setBusy(true);

    try {
      const result = await props.discovery.injectConversation({
        conversationId: selectedConversation.id,
        policy: injectPolicy,
        scope: injectScope,
        tags: injectTags,
        skipUnchanged: injectSkipUnchanged
      });

      if (result.skipped) {
        setNotice({
          tone: "info",
          message: `Inject skipped (${result.reason ?? "no-change"}) for ${selectedConversation.id.slice(0, 8)}`
        });
      } else {
        setNotice({
          tone: "success",
          message: `Injected ${selectedConversation.id.slice(0, 8)} imported=${result.result?.imported ?? 0}`
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice({
        tone: "error",
        message: `Inject failed: ${message}`
      });
    } finally {
      setBusy(false);
    }
  }, [injectPolicy, injectScope, injectSkipUnchanged, injectTags, props.discovery, selectedConversation]);

  useInput(
    (input, key) => {
      if (busy) {
        return;
      }

      if (inputMode !== "none") {
        if (key.escape) {
          setInputMode("none");
          setNotice({
            tone: "info",
            message: "Text input canceled"
          });
          return;
        }

        if (key.return) {
          if (inputMode === "project-query") {
            setProjectQuery(projectQueryDraft.trim());
            setSelectedIndex(0);
            setNotice({
              tone: "success",
              message: `Applied project query: ${projectQueryDraft.trim() || "(none)"}`
            });
          } else if (inputMode === "source-query") {
            setSourceQuery(sourceQueryDraft.trim());
            setSelectedIndex(0);
            setNotice({
              tone: "success",
              message: `Applied source query: ${sourceQueryDraft.trim() || "(none)"}`
            });
          } else if (inputMode === "inject-tags") {
            const tags = parseTagInput(injectTagsDraft);
            setInjectTags(tags);
            setNotice({
              tone: "success",
              message: `Inject tags set: ${tags.length > 0 ? tags.join(",") : "none"}`
            });
          }

          setInputMode("none");
          return;
        }

        if (key.backspace || key.delete) {
          if (inputMode === "project-query") {
            setProjectQueryDraft((current) => current.slice(0, -1));
          } else if (inputMode === "source-query") {
            setSourceQueryDraft((current) => current.slice(0, -1));
          } else if (inputMode === "inject-tags") {
            setInjectTagsDraft((current) => current.slice(0, -1));
          }

          return;
        }

        if (input && !key.ctrl && !key.meta && input !== "\u0003") {
          if (inputMode === "project-query") {
            setProjectQueryDraft((current) => `${current}${input}`);
          } else if (inputMode === "source-query") {
            setSourceQueryDraft((current) => `${current}${input}`);
          } else if (inputMode === "inject-tags") {
            setInjectTagsDraft((current) => `${current}${input}`);
          }
        }

        return;
      }

      if (showInjectModal) {
        if (key.escape) {
          setShowInjectModal(false);
          setNotice({
            tone: "info",
            message: "Inject canceled"
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
          setInputMode("inject-tags");
          setInjectTagsDraft(injectTags.join(","));
          setNotice({
            tone: "info",
            message: "Editing inject tags. Type comma-separated tags and press Enter."
          });
          return;
        }

        if (key.return) {
          setShowInjectModal(false);
          void injectSelected();
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

      if (input === "i") {
        setIdeFilter((current) => cycleValue(IDE_FILTERS, current));
        setSelectedIndex(0);
        return;
      }

      if (input === "x") {
        setScanIde((current) => cycleValue(SCAN_IDE_OPTIONS, current));
        return;
      }

      if (input === "c") {
        setConfidenceFilter((current) => cycleValue(CONFIDENCE_FILTERS, current));
        setSelectedIndex(0);
        return;
      }

      if (input === "o") {
        setSourceFilter((current) => cycleValue(sourceOptions, current));
        setSelectedIndex(0);
        return;
      }

      if (input === "/") {
        setInputMode("project-query");
        setProjectQueryDraft(projectQuery);
        setNotice({
          tone: "info",
          message: "Editing project query. Type text and press Enter; Esc cancels."
        });
        return;
      }

      if (input === "f") {
        setInputMode("source-query");
        setSourceQueryDraft(sourceQuery);
        setNotice({
          tone: "info",
          message: "Editing source query. Type text and press Enter; Esc cancels."
        });
        return;
      }

      if (input === "e") {
        setProjectQuery("");
        setSourceQuery("");
        setSelectedIndex(0);
        setNotice({
          tone: "success",
          message: "Cleared text filters"
        });
        return;
      }

      if (input === "r") {
        void refreshRows();
        return;
      }

      if (input === "s") {
        void runScan();
        return;
      }

      if (key.return) {
        if (!selectedConversation) {
          setNotice({
            tone: "error",
            message: "No conversation selected to inject"
          });
          return;
        }

        setShowInjectModal(true);
        setNotice({
          tone: "info",
          message: "Inject options open. Press Enter to confirm, Esc to cancel."
        });
      }
    },
    { isActive: props.isActive }
  );

  const rowWindow = useMemo(() => toSelectedWindow(rows, selectedIndex, 12), [rows, selectedIndex]);

  return (
    <Box flexDirection="column">
      <Text>
        Filters: ide={ideFilter} confidence={confidenceFilter} source={sourceFilter} projectQuery={projectQuery || "-"} sourceQuery={sourceQuery || "-"} | scanTarget={ideFilter === "all" ? scanIde : ideFilter}
      </Text>
      <Text color="gray">Keys: s scan | i ide | c confidence | o source | / project-query | f source-query | e clear-query | r refresh | up/down select | Enter inject-modal</Text>

      {inputMode !== "none" ? (
        <Box marginTop={1}>
          <Text color="yellow">
            {inputMode === "project-query" ? "project query" : inputMode === "source-query" ? "source query" : "inject tags"}
            {": "}
            {inputMode === "project-query"
              ? projectQueryDraft
              : inputMode === "source-query"
                ? sourceQueryDraft
                : injectTagsDraft}
            <Text color="gray"> (Enter apply, Esc cancel)</Text>
          </Text>
        </Box>
      ) : null}

      {showInjectModal ? (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="magenta" paddingX={1}>
          <Text color="magenta">Inject Options</Text>
          <Text>policy={injectPolicy} scope={injectScope} skipUnchanged={injectSkipUnchanged ? "yes" : "no"}</Text>
          <Text>tags={injectTags.length > 0 ? injectTags.join(",") : "none"}</Text>
          <Text color="gray">Modal keys: p policy | g scope | u toggle-skip | t edit-tags | Enter confirm | Esc cancel</Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text>{[padCell("IDE", 14), padCell("PROJECT", 26), padCell("CONF", 6), "TITLE"].join(" ")}</Text>
        <Text color="gray">{["-".repeat(14), "-".repeat(26), "-".repeat(6), "-".repeat(40)].join(" ")}</Text>

        {rowWindow.view.length === 0 ? (
          <Text color="yellow">No discovered conversations. Press s to scan a local IDE root.</Text>
        ) : (
          rowWindow.view.map((conversation, offset) => {
            const absoluteIndex = rowWindow.start + offset;
            const selected = absoluteIndex === selectedIndex;
            const project = conversation.projectPath ?? conversation.projectGroup ?? "unknown";
            const confidence = conversation.projectConfidence ?? "low";

            return (
              <Text key={conversation.id} color={selected ? "green" : undefined}>
                {selected ? ">" : " "} {padCell(conversation.ide, 14)} {padCell(project, 26)} {padCell(confidence, 6)} {truncateCell(conversation.title, 40)}
              </Text>
            );
          })
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text>
          Selected: {selectedConversation ? `${selectedConversation.id.slice(0, 12)} project=${selectedConversation.projectPath ?? selectedConversation.projectGroup ?? "unknown"}` : "none"}
        </Text>
        <Text color="gray">
          Source file: {selectedConversation ? truncateCell(selectedConversation.sourceFile, 90) : "n/a"}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color={getNoticeColor(notice.tone)}>{busy ? "Working..." : notice.message}</Text>
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
      <Text>Scope filter: {scopeFilter}</Text>
      <Text color="gray">Keys: g scope | r refresh | up/down select | d delete | y/n confirm</Text>

      <Box marginTop={1} flexDirection="column">
        <Text>{[padCell("ID", 10), padCell("SOURCE", 16), padCell("SCOPE", 8), "CONTENT"].join(" ")}</Text>
        <Text color="gray">{["-".repeat(10), "-".repeat(16), "-".repeat(8), "-".repeat(44)].join(" ")}</Text>

        {rowWindow.view.length === 0 ? (
          <Text color="yellow">No context entries for current scope filter.</Text>
        ) : (
          rowWindow.view.map((entry, offset) => {
            const absoluteIndex = rowWindow.start + offset;
            const selected = absoluteIndex === selectedIndex;

            return (
              <Text key={entry.id} color={selected ? "green" : undefined}>
                {selected ? ">" : " "} {padCell(entry.id.slice(0, 10), 10)} {padCell(entry.sourceTool, 16)} {padCell(entry.scope, 8)} {truncateCell(entry.content, 44)}
              </Text>
            );
          })
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text>
          Selected: {selectedEntry ? `${selectedEntry.id.slice(0, 12)} encrypted=${selectedEntry.encrypted ? "yes" : "no"}` : "none"}
        </Text>
        <Text color="gray">
          Tags: {selectedEntry && selectedEntry.tags.length > 0 ? selectedEntry.tags.join(",") : "none"}
        </Text>
        <Text color="gray">Updated: {shortTimestamp(selectedEntry?.updatedAt)}</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={getNoticeColor(notice.tone)}>{busy ? "Working..." : notice.message}</Text>
      </Box>
    </Box>
  );
}
