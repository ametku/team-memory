#!/usr/bin/env node

const USAGE = `team-memory — shared long-term memory for coding agents

Usage:
  team-memory <command> [options]

Commands:
  add <content>        Add a new fact
  query <text>         Search facts by relevance
  reject <fact_id>     Mark a fact as incorrect
  rebuild-index        Rebuild the local merged index
  prune                Remove stale or rejected facts
  sync                 Pull from remote and rebuild index

Options:
  --help               Show this help message
  --version            Show version
`;

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write("0.1.0\n");
    process.exit(0);
  }

  const command = args[0];
  process.stderr.write(`Unknown command: ${command}\n`);
  process.exit(1);
}

main();
