import assert from "node:assert/strict";
import test from "node:test";

import { horizontalRule } from "../tui/components";
import { TUI_THEME, getNoticeColor } from "../tui/theme";

test("tui theme maps notice tone colors", () => {
  assert.equal(getNoticeColor("info"), "magenta");
  assert.equal(getNoticeColor("success"), "green");
  assert.equal(getNoticeColor("error"), "red");
});

test("horizontalRule uses ascii dash rule", () => {
  const rule = horizontalRule(8);

  assert.equal(rule.length, 8);
  assert.equal(rule, "--------");
});

test("tui theme exposes retro purple accents", () => {
  assert.equal(TUI_THEME.frame, "magenta");
  assert.equal(TUI_THEME.panel, "magenta");
  assert.equal(TUI_THEME.selected, "magenta");
});
