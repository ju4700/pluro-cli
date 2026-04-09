export type AdapterSyncMode = "file-sync" | "mcp";

export type AdapterConflictPolicy = "lww" | "keep-both";

export type AdapterToolKind =
  | "generic"
  | "cursor"
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
  notes: string[];
}

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
