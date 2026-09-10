import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import { readJsonl } from "../fs.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function file(bytes: Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asmgr-zstd-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl.zstd");
  await writeFile(path, bytes);
  return path;
}

const frame = (text: string) => zstdCompressSync(text, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });

describe("Zstandard JSONL", () => {
  it("reads all concatenated checksummed frames and supports header-only sampling", async () => {
    const path = await file(Buffer.concat([frame('{"header":true}\n'), frame('{"text":"你好"}\n'), frame('{"last":true}\n')]));
    await expect(readJsonl(path)).resolves.toEqual([{ header: true }, { text: "你好" }, { last: true }]);
    await expect(readJsonl(path, 1)).resolves.toEqual([{ header: true }]);
  });

  it("reports checksum corruption rather than returning a complete-looking transcript", async () => {
    const bytes = frame('{"header":true}\n');
    bytes[bytes.length - 1] ^= 0xff;
    await expect(readJsonl(await file(bytes))).rejects.toThrow();
  });

  it("reports an incomplete final compressed frame", async () => {
    const bytes = frame('{"last":true}\n');
    const path = await file(Buffer.concat([frame('{"header":true}\n'), bytes.subarray(0, bytes.length - 2)]));
    await expect(readJsonl(path)).rejects.toThrow();
  });

  it("propagates source-open errors through the decoder", async () => {
    await expect(readJsonl(join(tmpdir(), "missing-asmgr-session", "session.jsonl.zstd"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
