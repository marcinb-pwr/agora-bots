import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const patterns = [
  ["private key", new RegExp(["-----BEGIN", "PRIVATE KEY-----"].join(" "))],
  ["OpenAI-style key", new RegExp(["sk", "[A-Za-z0-9_-]{20,}"].join("-"))],
  ["AWS access key", new RegExp(["AKIA", "[A-Z0-9]{16}"].join(""))],
];
const files = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const findings = [];

for (const file of files) {
  const contents = readFileSync(file);
  if (contents.includes(0)) continue;
  const text = contents.toString("utf8");
  for (const [name, pattern] of patterns) {
    if (pattern.test(text)) findings.push(`${file}: possible ${name}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Secret scan passed for ${files.length} tracked files.\n`,
  );
}
