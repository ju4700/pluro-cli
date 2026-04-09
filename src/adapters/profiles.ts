export type AdapterSyncMode = "file-sync" | "mcp";

export type AdapterConflictPolicy = "lww" | "keep-both";

export type AdapterToolKind =
  | "generic"
  | "cursor"
  | "vscode-copilot"
  | "antigravity"
  | "terminal"
  | "mcp";

export interface AdapterProfile {
  id: string;
  name: string;
  description: string;
  tool: AdapterToolKind;
  syncMode: AdapterSyncMode;
  suggestedPath: string;
  inboundFileName?: string;
  outboundFileName?: string;
  defaultConflictPolicy?: AdapterConflictPolicy;
  aliases?: string[];
  notes: string[];
}

export const PRIMARY_IDE_TOOLS: ReadonlyArray<AdapterToolKind> = [
  "cursor",
  "vscode-copilot",
  "antigravity"
];

export const BUILTIN_ADAPTER_PROFILES: AdapterProfile[] = [
  {
    id: "generic-file",
    name: "Generic File Adapter",
    description: "Drop snapshot files in a shared folder for tools that can read and write JSON.",
    tool: "generic",
    syncMode: "file-sync",
    suggestedPath: "context/generic",
    inboundFileName: "from-tool.snapshot.json",
    outboundFileName: "to-tool.snapshot.json",
    defaultConflictPolicy: "lww",
    notes: [
      "Use outbound snapshot for pluro -> tool sync.",
      "Use inbound snapshot for tool -> pluro sync.",
      "Automate with 'pluro connector watch <adapter>' in bidirectional mode."
    ]
  },
  {
    id: "cursor-file",
    name: "Cursor File Adapter",
    description: "Use a workspace file contract for Cursor scripts and automations.",
    tool: "cursor",
    syncMode: "file-sync",
    suggestedPath: "context/cursor",
    inboundFileName: "cursor-to-pluro.snapshot.json",
    outboundFileName: "pluro-to-cursor.snapshot.json",
    defaultConflictPolicy: "keep-both",
    notes: [
      "Point Cursor automation to the outbound snapshot file as read-only input.",
      "Write Cursor-produced context payloads to inbound snapshot file.",
      "Use keep-both policy to preserve parallel context branches."
    ]
  },
  {
    id: "vscode-copilot-file",
    name: "VS Code Copilot File Adapter",
    description: "Use a shared file contract for VS Code tasks and Copilot-related automation.",
    tool: "vscode-copilot",
    syncMode: "file-sync",
    suggestedPath: "context/vscode-copilot",
    inboundFileName: "vscode-copilot-to-pluro.snapshot.json",
    outboundFileName: "pluro-to-vscode-copilot.snapshot.json",
    defaultConflictPolicy: "keep-both",
    aliases: ["vscode-file", "copilot-file"],
    notes: [
      "Use outbound snapshot for VS Code scripts that need shared agent memory.",
      "Write VS Code/Copilot generated memory into inbound snapshot file.",
      "Use keep-both policy to avoid losing concurrent branches from multiple agents."
    ]
  },
  {
    id: "antigravity-file",
    name: "Antigravity File Adapter",
    description: "Publish context snapshots for Antigravity local automations.",
    tool: "antigravity",
    syncMode: "file-sync",
    suggestedPath: "context/antigravity",
    inboundFileName: "antigravity-to-pluro.snapshot.json",
    outboundFileName: "pluro-to-antigravity.snapshot.json",
    defaultConflictPolicy: "keep-both",
    notes: [
      "Route Antigravity export output into inbound snapshot file.",
      "Consume outbound snapshot from Antigravity tasks requiring shared memory.",
      "Use watch mode for continuous local synchronization."
    ]
  },
  {
    id: "cursor-mcp",
    name: "Cursor MCP Adapter",
    description: "Register pluro as an MCP stdio server inside Cursor.",
    tool: "cursor",
    syncMode: "mcp",
    suggestedPath: "context/cursor-mcp",
    notes: [
      "Register command 'pluro daemon mcp' in Cursor MCP settings.",
      "Use MCP tools for low-latency context create/list/get/delete operations."
    ]
  },
  {
    id: "vscode-copilot-mcp",
    name: "VS Code Copilot MCP Adapter",
    description: "Register pluro as an MCP stdio server in VS Code GitHub Copilot Chat.",
    tool: "vscode-copilot",
    syncMode: "mcp",
    suggestedPath: "context/vscode-copilot-mcp",
    aliases: ["vscode-mcp", "copilot-mcp"],
    notes: [
      "Register command 'pluro daemon mcp' in VS Code MCP server settings.",
      "Prefer MCP mode in VS Code for tool-native context access and lower sync lag."
    ]
  },
  {
    id: "antigravity-mcp",
    name: "Antigravity MCP Adapter",
    description: "Register pluro as an MCP stdio server in Antigravity.",
    tool: "antigravity",
    syncMode: "mcp",
    suggestedPath: "context/antigravity-mcp",
    notes: [
      "Register command 'pluro daemon mcp' in Antigravity MCP configuration.",
      "Use MCP mode to reduce file churn in high-frequency agent loops."
    ]
  },
  {
    id: "terminal-agent-file",
    name: "Terminal Agent Adapter",
    description: "Use snapshots in terminal-based agent workflows.",
    tool: "terminal",
    syncMode: "file-sync",
    suggestedPath: "context/terminal-agents",
    inboundFileName: "terminal-to-pluro.snapshot.json",
    outboundFileName: "pluro-to-terminal.snapshot.json",
    defaultConflictPolicy: "lww",
    notes: [
      "Use this profile for shell scripts and non-IDE agents.",
      "Bidirectional watch mode is safe for iterative local workflows."
    ]
  },
  {
    id: "mcp-client",
    name: "MCP Client Adapter",
    description: "Connect tools to the pluro daemon via MCP-compatible transport.",
    tool: "mcp",
    syncMode: "mcp",
    suggestedPath: "context/mcp",
    notes: [
      "Run 'pluro daemon mcp' and register this command as an MCP stdio server.",
      "Use MCP tools instead of file-sync for low-latency context operations."
    ]
  }
];

function normalizeProfileKey(value: string): string {
  return value.trim().toLowerCase();
}

export function findAdapterProfileById(profileId: string): AdapterProfile | undefined {
  const normalized = normalizeProfileKey(profileId);

  return BUILTIN_ADAPTER_PROFILES.find((profile) => {
    if (normalizeProfileKey(profile.id) === normalized) {
      return true;
    }

    return (profile.aliases ?? []).some((alias) => normalizeProfileKey(alias) === normalized);
  });
}

export function listPrimaryIdeProfiles(syncMode?: AdapterSyncMode): AdapterProfile[] {
  return BUILTIN_ADAPTER_PROFILES.filter((profile) => {
    if (!PRIMARY_IDE_TOOLS.includes(profile.tool)) {
      return false;
    }

    if (syncMode && profile.syncMode !== syncMode) {
      return false;
    }

    return true;
  });
}
