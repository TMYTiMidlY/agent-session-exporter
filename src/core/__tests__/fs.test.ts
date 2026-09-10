import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { iterateJsonl, readJsonl } from "../fs.js";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("JSONL reading", () => {
  it("streams rows and preserves parse errors", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "asmgr-jsonl-"));
    scratchDirectories.push(scratch);
    const path = join(scratch, "events.jsonl");
    await writeFile(path, '{"type":"first"}\nnot-json\n{"type":"last"}\n', "utf8");

    const rows = [];
    for await (const row of iterateJsonl(path)) rows.push(row);

    expect(rows).toEqual([
      { type: "first" },
      { type: "parse_error", text: "not-json" },
      { type: "last" },
    ]);
  });

  it.each([
    '{"type":\r"user.message","data":{"content":"kept"}}\n',
    '\n \t\r\n{"first":1}\r\nnot-json\r\n{"last":2}',
    'bad\rrecord\nlast\r',
    '{"text":"' + "界".repeat(70_000) + '"}\r\n{"last":true}\n',
    '"' + "a".repeat(65_533) + '"\r\n{"last":true}',
  ])("preserves the previous LF/CRLF parsing semantics (%#)", async (text) => {
    const scratch = await mkdtemp(join(tmpdir(), "asmgr-jsonl-"));
    scratchDirectories.push(scratch);
    const path = join(scratch, "events.jsonl");
    await writeFile(path, text, "utf8");
    const expected = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
      try { return JSON.parse(line); }
      catch { return { type: "parse_error", text: line }; }
    });

    await expect(readJsonl(path)).resolves.toEqual(expected);
  });

  it("propagates file-open errors", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "asmgr-jsonl-"));
    scratchDirectories.push(scratch);
    await expect(readJsonl(join(scratch, "missing.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not open a file when no rows are requested", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "asmgr-jsonl-"));
    scratchDirectories.push(scratch);
    await expect(readJsonl(join(scratch, "missing.jsonl"), 0)).resolves.toEqual([]);
  });

  it("stops after the requested sample size", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "asmgr-jsonl-"));
    scratchDirectories.push(scratch);
    const path = join(scratch, "events.jsonl");
    await writeFile(path, '{"index":1}\n{"index":2}\n{"index":3}\n', "utf8");

    await expect(readJsonl(path, 2)).resolves.toEqual([{ index: 1 }, { index: 2 }]);
  });
});
