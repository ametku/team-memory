import { execSync } from "child_process";
import * as readline from "readline";
import { resolveRepoDir } from "./repo.js";
import { pendingPrompts, markProcessed } from "./slack-queue.js";

const LOG_PREFIX = "[extract-slack]";

function log(msg: string): void {
  process.stdout.write(`${LOG_PREFIX} ${msg}\n`);
}

interface SlackMessage {
  text: string;
  username?: string;
  ts: string;
}

interface SlackSearchMatch {
  channel: { id: string };
  ts: string;
  permalink: string;
  text: string;
}

async function searchSlack(token: string, query: string): Promise<SlackSearchMatch[]> {
  const url = `https://slack.com/api/search.messages?query=${encodeURIComponent(query)}&count=5&sort=score`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Slack search HTTP ${res.status}`);
  const body = await res.json() as any;
  if (!body.ok) throw new Error(`Slack search error: ${body.error}`);
  return (body.messages?.matches ?? []) as SlackSearchMatch[];
}

async function readThread(token: string, channel: string, ts: string): Promise<SlackMessage[]> {
  const url = `https://slack.com/api/conversations.replies?channel=${channel}&ts=${ts}&limit=20`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Slack thread HTTP ${res.status}`);
  const body = await res.json() as any;
  if (!body.ok) throw new Error(`Slack thread error: ${body.error}`);
  return (body.messages ?? []) as SlackMessage[];
}

function formatThread(messages: SlackMessage[]): string {
  return messages.map(m => `[${m.username ?? "user"}]: ${m.text}`).join("\n\n");
}

const SYSTEM_PROMPT = `You are a fact extractor for a team knowledge base.

Review this Slack thread and extract 0-2 facts worth saving.

A fact is a decision, correction, gotcha, or convention that the team agreed on.

DO capture:
- Technical decisions the team reached ("we decided to use X because Y")
- Gotchas or known issues discussed ("watch out for X when doing Y")
- Conventions or agreements ("always do X in this codebase")

DO NOT capture:
- Casual chat, opinions, or jokes
- Ephemeral state ("the deploy is broken right now")
- Things that are already obvious from the code

If nothing fits, return { "facts": [] }.

Return JSON in this exact shape:
{
  "facts": [
    {
      "content": "one declarative sentence, concrete and future-searchable",
      "tags": ["category:<enum>", "kw1", "kw2"]
    }
  ]
}

Tag rules:
- Exactly one category: category:gotcha | category:convention | category:tool | category:workaround | category:decision
- 2-3 keyword tags not already in the content`;

async function extractFactsFromThread(baseUrl: string, apiKey: string, threadText: string): Promise<{ content: string; tags: string[] }[]> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-4-5-sonnet",
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: threadText }],
    }),
  });
  if (!res.ok) throw new Error(`NerdCompletion HTTP ${res.status}`);
  const body = await res.json() as any;
  const raw = (body.content[0].text as string)
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.facts) ? parsed.facts : [];
}

async function buildConfirm(): Promise<{ ask: (q: string) => Promise<boolean>; close: () => void }> {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return {
      ask: (q) => new Promise(res => rl.question(q, a => res(a === "y" || a === "Y"))),
      close: () => rl.close(),
    };
  }
  const lines = await new Promise<string[]>(res => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c: string) => { buf += c; });
    process.stdin.on("end", () => res(buf.split("\n")));
    process.stdin.resume();
  });
  return {
    ask: (q) => { process.stdout.write(q); const a = lines.shift()?.trim() ?? "n"; process.stdout.write(a + "\n"); return Promise.resolve(a === "y" || a === "Y"); },
    close: () => {},
  };
}

export async function runExtractSlack({ dryRun }: { dryRun: boolean }): Promise<void> {
  const slackToken = process.env.SLACK_TOKEN;
  if (!slackToken) {
    process.stderr.write("Error: SLACK_TOKEN is not set.\n");
    process.exit(1);
  }

  const nerdKey = process.env.NERD_COMPLETION_API_KEY;
  if (!nerdKey) {
    process.stderr.write("Error: NERD_COMPLETION_API_KEY is not set.\n");
    process.exit(1);
  }

  const baseUrl = process.env.NERD_COMPLETION_BASE_URL ?? "https://nerd-completion.staging-service.nr-ops.net";
  const repoDir = resolveRepoDir();
  const pending = pendingPrompts(repoDir);

  if (pending.length === 0) {
    log("no pending prompts in queue.");
    return;
  }

  log(`found ${pending.length} pending prompt(s) to search`);
  const confirm = await buildConfirm();
  let totalFacts = 0;

  for (const item of pending.slice(0, 20)) {
    log(`searching Slack for: "${item.prompt}"`);

    let matches: SlackSearchMatch[];
    try {
      matches = await searchSlack(slackToken, item.prompt);
      log(`found ${matches.length} thread(s)`);
    } catch (err: any) {
      log(`WARNING: search failed: ${err.message}`);
      continue;
    }

    for (const match of matches.slice(0, 3)) {
      if (dryRun) {
        process.stdout.write(`[dry-run] Thread: ${match.permalink}\n`);
        process.stdout.write(`  Preview: ${match.text.slice(0, 120)}\n`);
        const yes = await confirm.ask(`[dry-run] Extract facts from this thread? (y/n): `);
        if (!yes) continue;
      }

      let messages: SlackMessage[];
      try {
        messages = await readThread(slackToken, match.channel.id, match.ts);
      } catch (err: any) {
        log(`WARNING: could not read thread: ${err.message}`);
        continue;
      }

      const threadText = formatThread(messages);
      log(`read thread (${messages.length} messages, ${threadText.length} chars)`);

      let facts: { content: string; tags: string[] }[];
      try {
        facts = await extractFactsFromThread(baseUrl, nerdKey, threadText);
        log(`extracted ${facts.length} fact(s)`);
      } catch (err: any) {
        log(`WARNING: extraction failed: ${err.message}`);
        continue;
      }

      for (let i = 0; i < facts.length; i++) {
        const fact = facts[i];
        if (dryRun) {
          process.stdout.write(`[dry-run] Fact ${i + 1}/${facts.length}:\n`);
          process.stdout.write(`  content: ${JSON.stringify(fact.content)}\n`);
          process.stdout.write(`  tags:    ${JSON.stringify(fact.tags)}\n`);
          process.stdout.write(`  source:  ${match.permalink}\n`);
          const yes = await confirm.ask(`[dry-run] Save this fact? (y/n): `);
          if (!yes) continue;
          process.stdout.write(`[dry-run] would run: team-memory add ${JSON.stringify(fact.content)} --tags '${JSON.stringify(fact.tags)}'\n`);
        } else {
          try {
            execSync(
              `team-memory add ${JSON.stringify(fact.content)} --tags '${JSON.stringify(fact.tags)}'`,
              { stdio: "inherit" }
            );
            totalFacts++;
          } catch (err: any) {
            log(`WARNING: failed to save fact: ${err.message}`);
          }
        }
      }
    }

    if (!dryRun) {
      markProcessed(repoDir, item.prompt);
      log(`marked "${item.prompt}" as processed`);
    }
  }

  confirm.close();

  if (dryRun) {
    process.stdout.write("[dry-run] done. No changes written.\n");
  } else {
    log("syncing...");
    execSync("team-memory sync --push", { stdio: "inherit" });
    log(`done. ${totalFacts} fact(s) saved from ${pending.length} prompt(s).`);
  }
}
