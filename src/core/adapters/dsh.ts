import { basename, dirname, join } from "node:path";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import { parseSessionFormatLogFilename, type SessionFormatArtifact, type SessionFormatRestore } from "@deepseek-ai/dsh-session-format";
import { KNOWN_SESSION_EVENT_TYPES, type SessionEvent } from "@deepseek-ai/dsh-session";
import { deriveEventMessage, isAppendSurfaceEvent, isReplacementSurfaceEvent } from "@deepseek-ai/dsh-session/surface";
import type { ParsedSession, SessionRef, TimelineEntry } from "../types.js";
import { expandHome, iterateJsonl, readJsonl, walkFiles } from "../fs.js";

/** Official codec and transcript semantics pinned to dsh-v0.1.5-rc.1 (format v3). */
export function isDshHeader(value: unknown): boolean {
  const row = record(value);
  return row.type === "session" && typeof row.version === "number" && typeof row.id === "string";
}

export function dshLogVersion(path: string): number | undefined {
  return parseSessionFormatLogFilename(basename(path).replace(/\.zstd$/, ""));
}

/** Like DSH, directory discovery selects the highest generation, never a fallback predecessor. */
export function selectDshGenerations(paths: string[]): string[] {
  const selected = new Map<string, string>();
  const other: string[] = [];
  for (const path of paths) {
    const version = dshLogVersion(path);
    if (version === undefined) { other.push(path); continue; }
    const dir = dirname(path);
    const previous = selected.get(dir);
    if (!previous || version > dshLogVersion(previous)!) selected.set(dir, path);
    else if (version === dshLogVersion(previous) && path !== previous) {
      throw new Error(`DSH 同一代会话同时存在两种编码，无法选择：${previous} / ${path}`);
    }
  }
  return [...other, ...selected.values()].sort();
}

function headerRef(path: string, header: unknown): SessionRef {
  const result = sessionFormatCatalog.readHeader(header);
  if (result.status === "unsupported" || result.status === "malformed") throw new Error(result.reason);
  const namedVersion = dshLogVersion(path);
  if (namedVersion !== undefined && namedVersion !== result.storedVersion) {
    throw new Error(`DSH 文件名版本 v${namedVersion} 与文件头 v${result.storedVersion} 不符`);
  }
  return {
    agent: "dsh", id: result.header.id, path,
    cwd: result.header.cwd,
    startedAt: new Date(result.header.createdAt).toISOString(),
    source: { kind: "events", path, lossy: false },
  };
}

export async function refFromDshFile(path: string): Promise<SessionRef> {
  try {
    return headerRef(path, (await readJsonl(path, 1))[0]);
  } catch (error) {
    throw new Error(`无法读取 DSH 会话 ${path}：${errorMessage(error)}`, { cause: error });
  }
}

export async function discoverDsh(root?: string): Promise<SessionRef[]> {
  const directory = expandHome(root ?? join(process.env.DSH_HOME || "~/.dsh", "sessions"));
  const files = selectDshGenerations(await walkFiles(directory, (path) => dshLogVersion(path) !== undefined));
  const refs: SessionRef[] = [];
  for (const path of files) refs.push(await refFromDshFile(path));
  return refs;
}

export async function parseDsh(ref: SessionRef): Promise<ParsedSession> {
  try {
    let restore: SessionFormatRestore | undefined;
    let source = ref;
    for await (const row of iterateJsonl(ref.path)) {
      if (!restore) {
        source = headerRef(ref.path, row);
        // Reuse official packed-row decoding, adjacent migrations and validation.
        // No plugin runtime, source rewriting, or guessed legacy field mappings.
        restore = sessionFormatCatalog.createRestore(row, { recovery: "strict", validation: "current" });
      } else restore.decodeRow(row);
    }
    if (!restore) throw new Error("空会话文件");
    return projectDsh(source, restore.finish());
  } catch (error) {
    throw new Error(`无法解析 DSH 会话 ${ref.path}：${errorMessage(error)}`, { cause: error });
  }
}

interface Question {
  id: string;
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

interface PendingTool {
  entry: TimelineEntry;
  questions: { question: Question; entry: TimelineEntry }[];
}

/** Only official transcript carriers are projected; opaque plugin events/meta are never stringified. */
function projectDsh(ref: SessionRef, artifact: SessionFormatArtifact): ParsedSession {
  const entries: TimelineEntry[] = [];
  const calls = new Map<string, PendingTool>();
  const callsBySeq = new Map<number, PendingTool>();
  const summaries = new Map<string, string>();
  const diagnostics = { handled: 0, ignored: 0, unknown: 0, unknownTypes: [] as string[] };
  const unknown = new Set<string>();
  const warnings = new Set<string>();
  let title: string | undefined;
  let turn = 0;
  let step = 0;
  const push = (entry: Omit<TimelineEntry, "index">): TimelineEntry => {
    const value = { ...entry, index: entries.length };
    entries.push(value);
    return value;
  };
  const callKey = (id: string) => `${turn}:${step}:${id}`;

  function startTool(id: string, name: string, args: unknown, timestamp: string, rawType: string): PendingTool {
    const entry = push({ role: "tool", kind: "tool", title: name, text: "", timestamp, rawType,
      tool: { callId: id, name, arguments: args, result: { type: "pending" } } });
    const questions = name === "ask_user_question" ? readQuestions(args) : [];
    const pending: PendingTool = { entry, questions: questions.map((question) => ({ question,
      entry: push({ role: "assistant", kind: "question", text: questionText(question), timestamp,
        rawType: "ask_user_question.question", data: { questionId: question.id } }),
    })) };
    calls.set(callKey(id), pending);
    return pending;
  }

  function finishTool(pending: PendingTool, content: unknown, failed: boolean, code: unknown, timestamp: string): void {
    const log = visibleText(content);
    const cancelled = code === "ASK_CANCELLED" || code === "ASK_ABORTED" || code === "TOOL_ABORTED";
    pending.entry.tool!.result = { type: cancelled ? "rejected" : failed ? "failure" : "success", log };
    pending.entry.text = log;
    if (pending.questions.length === 0) return;
    if (failed) {
      for (const { entry } of pending.questions) entry.text += cancelled ? "\n\n（提问已取消）" : "\n\n（未取得回答）";
      pending.questions = [];
      return;
    }
    const answers = readAnswers(content, pending.questions.map(({ question }) => question));
    if (!answers) {
      warnings.add("部分提问结果不符合官方问答格式，未推断回答");
      return;
    }
    for (const { question } of pending.questions) {
      const answer = answers.get(question.id)!;
      push({ role: "user", kind: "decision", text: `回答「${question.question}」：\n${answer}`, timestamp,
        rawType: "ask_user_question.answer", data: { questionId: question.id } });
    }
    pending.questions = [];
  }

  function visibleText(content: unknown): string {
    if (!Array.isArray(content)) return "";
    return content.map((value) => {
      const block = record(value);
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image" || block.type === "file") {
        warnings.add("图片和文件附件仅显示占位符，未嵌入附件内容");
        const name = record(block.attachment).name;
        return block.type === "image" ? "[图片]" : `[附件：${typeof name === "string" ? name : "文件"}]`;
      }
      return "";
    }).join("");
  }

  for (const raw of artifact.events) {
    const event = raw as unknown as SessionEvent;
    const data = record(raw.data);
    const timestamp = new Date(raw.time).toISOString();
    if (raw.type === "turn/start") { turn = Number(data.turn); step = 0; }
    if (raw.type === "step/start") step = Number(data.step);
    if (raw.type === "session/title") {
      if (typeof data.title === "string") title = data.title;
    } else if (raw.type === "tool/call") {
      const pending = startTool(String(data.callId), String(data.name), parseJson(data.arguments), timestamp, raw.type);
      callsBySeq.set(raw.seq, pending);
    } else if (raw.type === "tool/ptc-dispatch-start" || raw.type === "tool/ptc-dispatch") {
      const id = String(data.subCallId);
      const pending = calls.get(callKey(id)) ?? startTool(id, String(data.name), data.arguments, timestamp, raw.type);
      if (raw.type === "tool/ptc-dispatch") finishTool(pending, data.content, data.isError === true, undefined, timestamp);
    } else if (raw.type === "compaction/summary") {
      if (typeof data.compactionId === "string") summaries.set(data.compactionId, visibleText(data.summary));
    } else if (raw.type === "user/message" && isReplacementSurfaceEvent(event)) {
      const source = record(data.source);
      if (source.kind === "plugin" && source.plugin === "compact" && typeof source.compactionId === "string") {
        push({ role: "event", kind: "compaction", text: summaries.get(source.compactionId) || "对话已压缩", timestamp, rawType: raw.type });
      }
    } else if (isAppendSurfaceEvent(event)) {
      const message = deriveEventMessage(event);
      if (event.type === "user/message" && message?.source.kind === "user") {
        const text = visibleText(message.content);
        if (text.trim()) push({ role: "user", kind: "message", text, timestamp, rawType: raw.type });
      } else if (event.type === "assistant/message" && message) {
        const reasoning = message.content.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
        if (reasoning.trim()) push({ role: "reasoning", kind: "reasoning", text: reasoning, timestamp, rawType: raw.type });
        const text = visibleText(message.content);
        if (text.trim()) push({ role: "assistant", kind: "message", text, timestamp, rawType: raw.type });
      } else if (event.type === "tool/result") {
        const block = event.data.message.content[0];
        const linked = (raw.sourceEventSeqs as number[] | undefined)?.map((seq) => callsBySeq.get(seq))
          .filter((value) => value !== undefined && value.entry.tool?.callId === block.toolCallId) ?? [];
        const pending = linked.length > 1 ? undefined : linked[0] ?? calls.get(callKey(block.toolCallId));
        if (pending) finishTool(pending, block.content, block.isError === true, event.data.error?.code, timestamp);
        else push({ role: "tool", kind: "tool", text: visibleText(block.content), timestamp, rawType: raw.type,
          tool: { callId: block.toolCallId, result: { type: block.isError ? "failure" : "success", log: visibleText(block.content) } } });
      } else { diagnostics.ignored++; continue; }
    } else {
      if (KNOWN_SESSION_EVENT_TYPES.has(raw.type)) diagnostics.ignored++;
      else { diagnostics.unknown++; unknown.add(raw.type); }
      continue;
    }
    diagnostics.handled++;
  }
  for (const pending of calls.values()) {
    for (const { entry } of pending.questions) entry.text += "\n\n（未记录可匹配的回答）";
  }
  diagnostics.unknownTypes = [...unknown].sort();
  return { ...ref, title, updatedAt: artifact.events.length ? new Date(artifact.events.at(-1)!.time).toISOString() : ref.startedAt,
    source: { kind: "events", path: ref.path, lossy: warnings.size > 0, warning: warnings.size ? [...warnings].join("；") : undefined },
    entries, diagnostics };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function readQuestions(args: unknown): Question[] {
  const values = record(args).questions;
  if (!Array.isArray(values) || values.length === 0) return [];
  const questions: Question[] = [];
  for (const value of values) {
    const q = record(value);
    if (typeof q.id !== "string" || typeof q.question !== "string" || questions.some((other) => other.id === q.id)) return [];
    if ((q.options !== undefined && !Array.isArray(q.options))
      || (q.multi_select !== undefined && typeof q.multi_select !== "boolean")
      || (q.header !== undefined && typeof q.header !== "string")) return [];
    const options: Question["options"] = [];
    for (const value of (q.options ?? []) as unknown[]) {
      const option = record(value);
      if (typeof option.label !== "string" || (option.description !== undefined && typeof option.description !== "string")) return [];
      options.push({ label: option.label, description: option.description as string | undefined });
    }
    questions.push({ id: q.id, question: q.question, header: typeof q.header === "string" ? q.header : undefined,
      options, multiSelect: q.multi_select === true });
  }
  return questions;
}

function questionText(q: Question): string {
  const mode = q.options.length ? q.multiSelect ? "（多选）" : "（单选）" : "";
  return `${q.header ? `${q.header}\n` : ""}${q.question}${mode}`
    + q.options.map((option, index) => `\n${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`).join("");
}

/** Match the official settled-question card: one text result, unique IDs, complete one-to-one pairing. */
function readAnswers(content: unknown, questions: Question[]): Map<string, string> | undefined {
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = record(content[0]);
  if (block.type !== "text" || typeof block.text !== "string") return undefined;
  const values = record(parseJson(block.text)).answers;
  if (!Array.isArray(values) || values.length !== questions.length) return undefined;
  const answers = new Map<string, string>();
  for (const value of values) {
    const answer = record(value);
    if (typeof answer.id !== "string" || answers.has(answer.id) || !questions.some((q) => q.id === answer.id)
      || !Array.isArray(answer.selected) || !answer.selected.every((item) => typeof item === "string")
      || (answer.custom !== undefined && typeof answer.custom !== "string")) return undefined;
    const parts = [...answer.selected, ...(typeof answer.custom === "string" && answer.custom.trim() ? [answer.custom] : [])];
    answers.set(answer.id, parts.length ? parts.join("\n") : "（未选择）");
  }
  return answers;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
