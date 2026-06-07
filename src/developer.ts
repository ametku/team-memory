import { execSync } from "child_process";

export function getDeveloperName(): string {
  if (process.env.TEAM_MEMORY_DEVELOPER) {
    return process.env.TEAM_MEMORY_DEVELOPER;
  }

  const name = execSync("git config user.name", { encoding: "utf-8" }).trim();
  if (!name) {
    throw new Error(
      "Cannot determine developer name. Set TEAM_MEMORY_DEVELOPER or configure git user.name",
    );
  }
  return name;
}
