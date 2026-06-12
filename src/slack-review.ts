import { join } from "path";
import { loadSession, clearSession } from "./slack-session.js";
import { addFact } from "./add.js";

export interface ReviewOptions {
  input: string;
  onPrompt: (question: string) => Promise<boolean>;
  repoDir?: string;
}

export async function reviewSlackSession(
  repoDir: string,
  developer: string,
  opts: ReviewOptions,
): Promise<void> {
  const session = loadSession(repoDir);
  if (!session || session.threads.length === 0) return;

  const factRepoDir = opts.repoDir ?? repoDir;

  for (const thread of session.threads) {
    const question =
      `\nSlack thread surfaced while working on: "${thread.prompt}"\n` +
      `  URL:     ${thread.url}\n` +
      `  Summary: ${thread.summary}\n` +
      `Save as team-memory fact? (y/n): `;

    const approved = await opts.onPrompt(question);

    if (approved) {
      addFact({
        content: thread.summary,
        repoDir: factRepoDir,
        developer,
        tags: ["category:decision", "slack"],
      });
    }
  }

  clearSession(repoDir);
}

export async function runSlackReview(repoDir: string, developer: string): Promise<void> {
  const session = loadSession(repoDir);
  if (!session || session.threads.length === 0) return;

  const lines = await new Promise<string[]>(resolve => {
    if (process.stdin.isTTY) {
      resolve([]);
      return;
    }
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => { buf += chunk; });
    process.stdin.on("end", () => resolve(buf.split("\n")));
    process.stdin.resume();
  });

  const lineQueue = [...lines];

  const onPrompt = (question: string): Promise<boolean> => {
    process.stdout.write(question);
    if (process.stdin.isTTY) {
      return new Promise(res => {
        const { createInterface } = require("readline");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question("", (ans: string) => { rl.close(); res(ans === "y" || ans === "Y"); });
      });
    }
    const answer = lineQueue.shift()?.trim() ?? "n";
    process.stdout.write(answer + "\n");
    return Promise.resolve(answer === "y" || answer === "Y");
  };

  await reviewSlackSession(repoDir, developer, { input: "", onPrompt });
}
