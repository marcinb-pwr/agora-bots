import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const commandVersion = (command, arguments_) =>
  execFileSync(command, arguments_, { encoding: "utf8" }).trim();
const fixture = readFileSync(
  new URL("../packages/providers/test/fixtures/unicode.ts", import.meta.url),
);
const manifest = {
  node: process.version,
  pnpm: commandVersion("pnpm", ["--version"]),
  platform: `${process.platform}-${process.arch}`,
  unicodeFixtureSha256: createHash("sha256").update(fixture).digest("hex"),
};

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
