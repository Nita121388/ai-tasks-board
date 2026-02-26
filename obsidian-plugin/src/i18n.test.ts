import { describe, expect, it } from "vitest";

import { resolveLanguage, t } from "./i18n";

describe("i18n", () => {
  it("resolves language based on setting override", () => {
    expect(resolveLanguage("en", "zh-CN")).toBe("en");
    expect(resolveLanguage("zh-CN", "en")).toBe("zh-CN");
  });

  it("resolves language in auto mode from Obsidian language code", () => {
    expect(resolveLanguage("auto", "en")).toBe("en");
    expect(resolveLanguage(undefined, "en")).toBe("en");
    expect(resolveLanguage("auto", "zh")).toBe("zh-CN");
    expect(resolveLanguage("auto", "zh-cn")).toBe("zh-CN");
    expect(resolveLanguage("auto", "zh-CN")).toBe("zh-CN");
  });

  it("formats templates with vars", () => {
    expect(t("notice.runtime.start_failed", "en", { error: "boom" })).toContain("boom");
    expect(t("notice.runtime.start_failed", "zh-CN", { error: "boom" })).toContain("boom");
  });

  it("returns a string for known keys", () => {
    expect(typeof t("settings.board_path.name", "en")).toBe("string");
    expect(typeof t("settings.board_path.name", "zh-CN")).toBe("string");
  });
});

