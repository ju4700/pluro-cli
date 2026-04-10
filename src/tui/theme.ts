export const TUI_THEME = {
  frame: "magenta",
  panel: "magenta",
  panelMuted: "gray",
  selected: "magenta",
  subtle: "gray",
  info: "magenta",
  success: "green",
  error: "red",
  warning: "yellow"
} as const;

export type TuiThemeColor = (typeof TUI_THEME)[keyof typeof TUI_THEME];

export type NoticeTone = "info" | "success" | "error";

export function getNoticeColor(tone: NoticeTone): "magenta" | "green" | "red" {
  if (tone === "success") {
    return TUI_THEME.success;
  }

  if (tone === "error") {
    return TUI_THEME.error;
  }

  return TUI_THEME.info;
}
