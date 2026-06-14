import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface QueuedPrompt {
  prompt: string;
  project?: string;
  queued_at: string;
  processed: boolean;
}

export interface SlackQueue {
  prompts: QueuedPrompt[];
}

const QUEUE_FILE = "slack-queue.json";

function loadQueue(repoDir: string): SlackQueue {
  const path = join(repoDir, QUEUE_FILE);
  if (!existsSync(path)) return { prompts: [] };
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { prompts: [] };
  }
}

function saveQueue(repoDir: string, queue: SlackQueue): void {
  writeFileSync(join(repoDir, QUEUE_FILE), JSON.stringify(queue, null, 2));
}

export function enqueuePrompt(repoDir: string, prompt: string, project?: string): void {
  const queue = loadQueue(repoDir);
  queue.prompts.push({ prompt, project, queued_at: new Date().toISOString(), processed: false });
  saveQueue(repoDir, queue);
}

export function pendingPrompts(repoDir: string): QueuedPrompt[] {
  return loadQueue(repoDir).prompts.filter(p => !p.processed);
}

export function markProcessed(repoDir: string, prompt: string): void {
  const queue = loadQueue(repoDir);
  for (const p of queue.prompts) {
    if (p.prompt === prompt) p.processed = true;
  }
  saveQueue(repoDir, queue);
}
