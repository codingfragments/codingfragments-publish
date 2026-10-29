/**
 * Generates the CLI reference section of MANUAL.md from the command table.
 *
 * The section is written between HTML marker comments; everything outside the
 * markers stays hand-written. A test re-generates and compares, so a committed
 * manual that has drifted from `commands.ts` fails CI with a clear instruction.
 *
 * Run: npm run docs:cli
 */

import fs from "node:fs";
import path from "node:path";
import { BIN, COMMANDS, ENVIRONMENT, EXIT_CODES, VERSION } from "./commands.ts";

export const BEGIN_MARKER = "<!-- BEGIN generated: cli-reference -->";
export const END_MARKER = "<!-- END generated: cli-reference -->";

/** Render the generated reference section (without markers). */
export function renderCliReference(): string {
  const lines: string[] = [];
  for (const command of COMMANDS) {
    lines.push(`### \`${command.name}\``);
    lines.push("");
    lines.push("```");
    lines.push(`${BIN} ${command.name} ${command.args}`.trim());
    lines.push("```");
    lines.push("");
    lines.push(command.summary);
    lines.push("");
    if (command.flags.length > 0) {
      lines.push("| Option | Description |");
      lines.push("|---|---|");
      for (const flag of command.flags) {
        const invocation = flag.takesValue
          ? `--${flag.name} ${flag.valueLabel ?? "<value>"}`
          : `--${flag.name}`;
        lines.push(`| \`${invocation}\`${flag.required ? " (required)" : ""} | ${flag.summary} |`);
      }
      lines.push("");
    }
    for (const example of command.examples) {
      lines.push("```");
      lines.push(example);
      lines.push("```");
      lines.push("");
    }
  }
  lines.push("### Environment variables");
  lines.push("");
  lines.push("| Variable | Purpose |");
  lines.push("|---|---|");
  for (const [name, purpose] of ENVIRONMENT) {
    lines.push(`| \`${name}\` | ${purpose} |`);
  }
  lines.push("");
  lines.push("### Exit codes");
  lines.push("");
  lines.push("| Code | Meaning |");
  lines.push("|---|---|");
  for (const [code, meaning] of EXIT_CODES) {
    lines.push(`| ${code} | ${meaning} |`);
  }
  lines.push("");
  lines.push(`Tool version at generation time: ${VERSION}.`);
  return lines.join("\n");
}

/** Insert/replace the generated section inside a manual's full text. */
export function injectSection(manual: string, section: string): string {
  const begin = manual.indexOf(BEGIN_MARKER);
  const end = manual.indexOf(END_MARKER);
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error(`MANUAL.md is missing the ${BEGIN_MARKER} / ${END_MARKER} markers`);
  }
  const head = manual.slice(0, begin);
  const tail = manual.slice(end + END_MARKER.length);
  return `${head}${BEGIN_MARKER}\n\n${section}\n${END_MARKER}${tail}`;
}

if (process.argv[1]?.endsWith("generate-docs.ts")) {
  const manualPath = path.join(import.meta.dirname, "MANUAL.md");
  const manual = fs.readFileSync(manualPath, "utf8");
  fs.writeFileSync(manualPath, injectSection(manual, renderCliReference()));
  console.log(`cli reference regenerated in ${manualPath}`);
}
