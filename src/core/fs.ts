import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function walkFiles(root: string, predicate: (path: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  if (!(await pathExists(root))) return out;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && predicate(path)) {
        out.push(path);
      }
    }
  }

  await walk(root);
  return out.sort();
}

function parseJsonlLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "parse_error", text: line };
  }
}

export async function* iterateJsonl(path: string): AsyncGenerator<unknown> {
  const input = createReadStream(path, { encoding: "utf8" });
  let fragments: string[] = [];
  try {
    for await (const chunk of input) {
      const text = chunk as string;
      let start = 0;
      let end = text.indexOf("\n");
      while (end !== -1) {
        fragments.push(text.slice(start, end));
        const rawLine = fragments.join("");
        fragments = [];
        // Match the original /\r?\n/ framing: a bare CR is JSON whitespace,
        // not a record boundary. Only strip CR immediately before LF.
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.trim()) yield parseJsonlLine(line);
        start = end + 1;
        end = text.indexOf("\n", start);
      }
      // Retain only the unfinished record, not all previous events. Joining
      // fragments once per record also avoids rescanning a growing long line.
      if (start < text.length) fragments.push(text.slice(start));
    }
    const tail = fragments.join("");
    if (tail.trim()) yield parseJsonlLine(tail);
  } finally {
    input.destroy();
  }
}

export async function readJsonl(path: string, limit = Infinity): Promise<unknown[]> {
  const rows: unknown[] = [];
  if (limit <= 0) return rows;
  for await (const row of iterateJsonl(path)) {
    rows.push(row);
    if (rows.length >= limit) break;
  }
  return rows;
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export function fileStem(path: string): string {
  return basename(path).replace(/\.jsonl$/, "");
}

export function parentName(path: string): string {
  return basename(dirname(path));
}
