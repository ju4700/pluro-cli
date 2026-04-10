import React from "react";
import { Box, Text } from "ink";

import { TUI_THEME, type TuiThemeColor } from "./theme";

export function getTerminalColumns(fallback = 120): number {
  const columns = process.stdout.columns;

  if (typeof columns !== "number" || columns <= 0) {
    return fallback;
  }

  return columns;
}

export function horizontalRule(targetWidth: number): string {
  const columns = getTerminalColumns();
  const maxWidth = Math.max(20, columns - 6);
  return "-".repeat(Math.min(targetWidth, maxWidth));
}

export function RetroPanel(props: {
  title: string;
  borderColor?: TuiThemeColor;
  marginTop?: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      marginTop={props.marginTop ?? 1}
      borderStyle="round"
      borderColor={props.borderColor ?? TUI_THEME.panel}
      paddingX={1}
      paddingY={0}
    >
      <Text color={props.borderColor ?? TUI_THEME.panel}>{props.title}</Text>
      {props.children}
    </Box>
  );
}
