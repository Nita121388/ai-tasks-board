import { describe, expect, it } from "vitest";

import { normalizeEscapedNewlines } from "./board";

describe("board", () => {
  it("does not change content without escaped newlines", () => {
    const src = "a\nb\nc\n";
    const out = normalizeEscapedNewlines(src);
    expect(out.changed).toBe(false);
    expect(out.next).toBe(src);
  });

  it("converts literal \\\\n sequences into real newlines", () => {
    const src = "a\\nb";
    const out = normalizeEscapedNewlines(src);
    expect(out.changed).toBe(true);
    expect(out.next).toBe("a\nb");
  });

  it("converts literal \\\\r\\\\n into real newlines", () => {
    const src = "a\\r\\nb";
    const out = normalizeEscapedNewlines(src);
    expect(out.changed).toBe(true);
    expect(out.next).toBe("a\nb");
  });
});
