import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadStream, type ReadStream } from "node:fs";
import { Readable } from "node:stream";
import { readJsonl } from "../fs.js";

vi.mock("node:fs", () => ({ createReadStream: vi.fn() }));

function useStream(input: Readable): void {
  input.setEncoding("utf8");
  vi.mocked(createReadStream).mockReturnValueOnce(input as ReadStream);
}

afterEach(() => vi.clearAllMocks());

describe("JSONL stream lifecycle", () => {
  it("keeps records and CRLF delimiters intact across chunks", async () => {
    useStream(Readable.from(['{"type":\r', '"kept"}\r', '\n{"last":', 'true}']));
    await expect(readJsonl("unused.jsonl")).resolves.toEqual([{ type: "kept" }, { last: true }]);
  });

  it("propagates a stream read failure", async () => {
    const error = Object.assign(new Error("read failed"), { code: "EIO" });
    useStream(new Readable({ read() { this.destroy(error); } }));
    await expect(readJsonl("unused.jsonl")).rejects.toBe(error);
  });

  it("propagates a close failure at EOF instead of emitting an uncaught error", async () => {
    const error = Object.assign(new Error("close failed"), { code: "EIO" });
    useStream(new Readable({
      read() {
        this.push('{"first":true}\n');
        this.push(null);
      },
      destroy(_error, callback) { callback(error); },
    }));
    await expect(readJsonl("unused.jsonl")).rejects.toBe(error);
  });

  it("destroys the stream when the sample limit is reached", async () => {
    const input = new Readable({
      read() { this.push('{"first":true}\n{"second":true}\n'); },
    });
    useStream(input);
    await expect(readJsonl("unused.jsonl", 1)).resolves.toEqual([{ first: true }]);
    expect(input.destroyed).toBe(true);
    expect(input.closed).toBe(true);
  });

  it("keeps late close errors handled when sampling cancels the remaining read", async () => {
    const input = new Readable({
      read() { this.push('{"first":true}\n{"second":true}\n'); },
      destroy(_error, callback) { callback(new Error("late close failed")); },
    });
    useStream(input);
    // Node's async iterator suppresses cancellation-time close failures, but
    // must keep an error listener until closure so the process does not crash.
    await expect(readJsonl("unused.jsonl", 1)).resolves.toEqual([{ first: true }]);
    expect(input.destroyed).toBe(true);
    expect(input.closed).toBe(true);
  });
});
