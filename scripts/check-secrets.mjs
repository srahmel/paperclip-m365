import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const git = process.platform === "win32" ? "git.exe" : "git";
async function listProjectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && [".git", "dist", "node_modules"].includes(entry.name)) continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listProjectFiles(absolutePath));
    if (entry.isFile()) files.push(relative(projectRoot, absolutePath));
  }
  return files;
}

let projectFiles;
try {
  projectFiles = execFileSync(
    git,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).split("\0").filter(Boolean);
} catch {
  projectFiles = await listProjectFiles(projectRoot);
}

const binaryExtensions = new Set([".gif", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".tgz", ".webp"]);
const patterns = [
  { name: "private key", regex: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/ },
  { name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
];
const assignmentPattern = /\b(client[_-]?secret|password|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?([^\s"']{8,})/gi;
const placeholderPattern = /^(?:disabled|example|none|not-configured|placeholder|replace-me|<[^>]+>|\$\{[^}]+\})$/i;

let scannedFiles = 0;
for (const relativePath of projectFiles) {
  if (binaryExtensions.has(extname(relativePath).toLowerCase())) continue;
  const content = await readFile(resolve(projectRoot, relativePath), "utf8");
  scannedFiles += 1;

  for (const pattern of patterns) {
    assert(!pattern.regex.test(content), `${relativePath} contains a possible ${pattern.name}`);
  }

  for (const match of content.matchAll(assignmentPattern)) {
    const value = match[2].replace(/[),.;]+$/, "");
    assert(placeholderPattern.test(value), `${relativePath} contains a non-placeholder ${match[1]} assignment`);
  }
}

console.log(JSON.stringify({ check: "secrets", scannedFiles, findings: 0 }));
