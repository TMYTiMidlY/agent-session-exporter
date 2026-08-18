import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "turbo-stream";
import { describe, expect, it } from "vitest";
import {
  captureChatGptShare,
  chatGptConversationId,
  parseChatGpt,
  parseChatGptSnapshot,
  parseChatGptShareUrl,
  type ChatGptShareSnapshot,
} from "../adapters/chatgpt.js";
import { sessionToDialogue } from "../index.js";

const root = resolve(fileURLToPath(new URL("../../../fixtures", import.meta.url)));
const fixture = resolve(root, "chatgpt-fixture.chatgpt-share.json");
const shareUrl = "https://chatgpt.com/share/chatgpt-fixture";

describe("ChatGPT share adapter", () => {
  it("validates public share URLs and rejects other conversation URLs", () => {
    expect(parseChatGptShareUrl(shareUrl).toString()).toBe(shareUrl);
    expect(chatGptConversationId(`${shareUrl}?foo=bar`)).toBe("chatgpt-fixture");
    expect(() => parseChatGptShareUrl("https://chatgpt.com/g/g-p-project-fixture/c/private-fixture")).toThrow(
      /地址栏复制的私有会话链接.*点击右上角“分享”/,
    );
    expect(() => parseChatGptShareUrl("https://chatgpt.com/c/private-fixture")).toThrow(
      /地址栏复制的私有会话链接.*点击右上角“分享”/,
    );
    expect(() => parseChatGptShareUrl("https://example.com/share/chatgpt-fixture")).toThrow(
      /目前只支持 ChatGPT 的公开分享链接/,
    );
    expect(() => parseChatGptShareUrl("https://chatgpt.com/share/..%2Fescape")).toThrow(
      /这不是 ChatGPT 分享链接/,
    );
  });

  it("parses imported snapshots into the shared timeline model", async () => {
    const session = await parseChatGpt({
      agent: "chatgpt",
      id: "chatgpt-fixture",
      path: fixture,
    });
    expect(session).toMatchObject({
      agent: "chatgpt",
      id: "chatgpt-fixture",
      title: "ChatGPT fixture",
      source: {
        kind: "chatgpt-share",
        lossy: true,
        origin: shareUrl,
      },
    });
    expect(session.source?.warning).toContain("来源已隐藏 1 条 ChatGPT 工具结果");
    expect(session.entries.some((entry) => entry.role === "system")).toBe(true);
    expect(session.entries.some((entry) => entry.role === "reasoning")).toBe(true);

    const tool = session.entries.find((entry) => entry.role === "tool");
    expect(tool?.tool).toMatchObject({
      name: "web.run",
      arguments: { search_query: [{ q: "fixture query" }] },
      result: { type: "redacted" },
    });

    const dialogue = sessionToDialogue(session);
    expect(dialogue).toContain("Find the answer");
    expect(dialogue).toContain("The final answer.");
    expect(dialogue).toContain("Summarize it");
    expect(dialogue).toContain("Short summary.");
    expect(dialogue).not.toContain("fixture query");
    expect(dialogue).not.toContain("Checking sources");
    expect(dialogue).not.toContain("Public system context");
    expect(dialogue).not.toContain("Shared conversation preamble");
  });

  it("pairs tool results within user boundaries without relying on turn_exchange_id", () => {
    const session = parseChatGptSnapshot(
      { agent: "chatgpt", id: "tool-pairing", path: "tool-pairing.json" },
      snapshot([
        chatGptMessage("user-one", "user", ["Run both tools"], {
          turn_exchange_id: "reused-turn",
        }),
        chatGptMessage("web-result", "tool", ["The output of this plugin was redacted."], {
          turn_exchange_id: "reused-turn",
          is_redacted: true,
        }, "all", "web.run"),
        chatGptMessage("web-call", "assistant", ["{}"], {
          turn_exchange_id: "reused-turn",
        }, "web.run", undefined, "code"),
        chatGptMessage("python-call", "assistant", ["{}"], {
          turn_exchange_id: "reused-turn",
        }, "python", undefined, "code"),
        chatGptMessage("python-result", "tool", ["42"], {
          turn_exchange_id: "reused-turn",
        }, "all", "python"),
        chatGptMessage("user-two", "user", ["Run web again"], {
          turn_exchange_id: "reused-turn",
        }),
        chatGptMessage("later-web-call", "assistant", ["{}"], {
          turn_exchange_id: "reused-turn",
        }, "web.run", undefined, "code"),
      ]),
    );

    const tools = new Map(
      session.entries
        .filter((entry) => entry.kind === "tool")
        .map((entry) => [entry.tool?.callId, entry.tool]),
    );
    expect(tools.get("web-call")?.result).toMatchObject({ type: "redacted" });
    expect(tools.get("python-call")?.result).toMatchObject({ type: "success", log: "42" });
    expect(tools.get("later-web-call")?.result).toMatchObject({ type: "pending" });
    expect(session.entries.some((entry) => entry.kind === "tool_result")).toBe(false);
  });

  it("keeps ambiguous tool results separate instead of guessing a call", () => {
    const session = parseChatGptSnapshot(
      { agent: "chatgpt", id: "ambiguous-tools", path: "ambiguous-tools.json" },
      snapshot([
        chatGptMessage("user", "user", ["Search twice"]),
        chatGptMessage("call-one", "assistant", ["{}"], {}, "web.run", undefined, "code"),
        chatGptMessage("call-two", "assistant", ["{}"], {}, "web.run", undefined, "code"),
        chatGptMessage(
          "result",
          "tool",
          ["The output of this plugin was redacted."],
          { is_redacted: true },
          "all",
          "web.run",
        ),
      ]),
    );

    const calls = session.entries.filter((entry) => entry.kind === "tool");
    expect(calls).toHaveLength(2);
    expect(calls.every((entry) => entry.tool?.result?.type === "pending")).toBe(true);
    expect(session.entries.find((entry) => entry.kind === "tool_result")?.tool?.result)
      .toMatchObject({ type: "redacted" });
  });

  it("marks unarchived image assets as lossy", () => {
    const session = parseChatGptSnapshot(
      { agent: "chatgpt", id: "image-share", path: "image-share.json" },
      snapshot([
        {
          id: "image-message",
          author: { role: "user", name: null },
          recipient: "all",
          content: {
            content_type: "multimodal_text",
            parts: [
              { content_type: "text", text: "Describe this image" },
              {
                content_type: "image_asset_pointer",
                asset_pointer: "file-service://example-image",
              },
            ],
          },
          create_time: 1,
          metadata: {},
        },
      ]),
    );

    expect(session.source).toMatchObject({ lossy: true });
    expect(session.source?.warning).toContain("image_asset_pointer");
    expect(session.entries.some((entry) => entry.text.includes("[image:file-service://example-image]")))
      .toBe(true);
  });

  it("decodes a public share hydration stream without a browser", async () => {
    const fixtureSnapshot = JSON.parse(await readFile(fixture, "utf8")) as {
      data: Record<string, unknown>;
    };
    const encoded = encode({
      loaderData: {
        "routes/share.$shareId": {
          serverResponse: { data: fixtureSnapshot.data },
        },
      },
      actionData: null,
      errors: null,
    });
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    const reader = encoded.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) chunks.push(tail);
    const html = chunks
      .map((chunk) => `<script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(chunk)})</script>`)
      .join("");

    const snapshot = await captureChatGptShare(
      shareUrl,
      async () => new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    expect(snapshot.data.title).toBe("ChatGPT fixture");
    expect(snapshot.data.linear_conversation).toHaveLength(9);
  });

  it("refuses redirects outside public ChatGPT share pages", async () => {
    await expect(captureChatGptShare(
      shareUrl,
      async () => new Response(null, {
        status: 302,
        headers: { location: "https://example.com/share/elsewhere" },
      }),
    )).rejects.toThrow(/重定向到了 ChatGPT 公开分享页之外/);
  });
});

function chatGptMessage(
  id: string,
  role: string,
  parts: unknown[],
  metadata: Record<string, unknown> = {},
  recipient = "all",
  name?: string,
  contentType = "text",
): Record<string, unknown> {
  return {
    id,
    author: { role, name: name ?? null },
    recipient,
    content: { content_type: contentType, parts },
    create_time: 1,
    metadata,
  };
}

function snapshot(messages: Record<string, unknown>[]): ChatGptShareSnapshot {
  return {
    format: "asmgr.chatgpt-share",
    version: 1,
    capturedAt: new Date(0).toISOString(),
    requestedUrl: "https://chatgpt.com/share/test",
    sourceUrl: "https://chatgpt.com/share/test",
    data: {
      conversation_id: "test",
      linear_conversation: messages.map((message, index) => ({
        id: `node-${index}`,
        message,
      })),
    },
  };
}
