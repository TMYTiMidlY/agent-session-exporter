import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import {
  captureChatGptShare,
  chatGptConversationId,
  chatGptSnapshotPath,
} from "../../core/index.js";

export function buildImportCommand(): Command {
  const cmd = new Command("import")
    .argument("<url>", "ChatGPT 公开分享链接")
    .description("把 ChatGPT 公开分享导入本地 asmgr 归档")
    .option("-o, --out <path>", "指定快照输出路径")
    .option("--chatgpt-root <path>", "覆盖 ChatGPT 导入文件的托管目录")
    .option("--force", "覆盖已经存在的快照");

  cmd.action(async (url, opts) => {
    const sourceUrl = String(url);
    const id = chatGptConversationId(sourceUrl);
    const out = opts.out
      ? resolve(String(opts.out))
      : chatGptSnapshotPath(id, typeof opts.chatgptRoot === "string" ? opts.chatgptRoot : undefined);
    if (!opts.force && await fileExists(out)) {
      throw new Error(`输出文件已存在：${out}（如需覆盖，请加 --force）`);
    }
    const snapshot = await captureChatGptShare(sourceUrl);
    await mkdir(dirname(out), { recursive: true });
    try {
      await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: opts.force ? "w" : "wx",
      });
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new Error(`输出文件已存在：${out}（如需覆盖，请加 --force）`);
      }
      throw error;
    }
    await chmod(out, 0o600);
    console.log(out);
  });
  return cmd;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "EEXIST",
  );
}
