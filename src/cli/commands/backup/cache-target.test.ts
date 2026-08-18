import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatGptRoot } from "../../../core/index.js";
import { assertSafeCacheTarget, defaultCacheDir } from "./cache-target.js";

describe("assertSafeCacheTarget", () => {
  it("accepts a dedicated cache directory", () => {
    const target = join(homedir(), ".cache", "asmgr", "restic-cache");
    expect(assertSafeCacheTarget(target)).toBe(target);
  });

  it("rejects the live agent homes and anything inside them", () => {
    for (const name of [".copilot", ".claude", ".codex"]) {
      expect(() => assertSafeCacheTarget(join(homedir(), name))).toThrow(/live or managed/);
      expect(() => assertSafeCacheTarget(join(homedir(), name, "session-state"))).toThrow(/live or managed/);
    }
  });

  it("rejects the managed ChatGPT import directory and anything inside it", () => {
    expect(() => assertSafeCacheTarget(chatGptRoot())).toThrow(/live or managed/);
    expect(() => assertSafeCacheTarget(join(chatGptRoot(), "nested"))).toThrow(/live or managed/);
  });

  it("rejects the home directory itself", () => {
    expect(() => assertSafeCacheTarget(homedir())).toThrow(/home directory/);
  });

  it("defaults the cache dir under ~/.cache", () => {
    expect(defaultCacheDir()).toContain(join(".cache"));
  });
});
