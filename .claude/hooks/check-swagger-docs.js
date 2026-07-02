#!/usr/bin/env node
// PreToolUse hook (Bash matcher): blocks `git commit`/`git push` when staged *.routes.ts
// files have router.<method>(...) calls without a matching @openapi JSDoc block.
// See backend/CLAUDE.md Workflow section: swagger docs must be written before the commit.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..", "..");

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(input || "{}");
  } catch {
    process.exit(0);
  }

  const command = payload?.tool_input?.command || "";
  if (!/\bgit\s+(commit|push)\b/.test(command)) process.exit(0);

  let staged;
  try {
    staged = execSync("git diff --cached --name-only --diff-filter=ACM", {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    process.exit(0);
  }

  const routeFiles = staged.filter((f) => /^src\/routes\/.*\.routes\.ts$/.test(f));
  if (routeFiles.length === 0) process.exit(0);

  const problems = [];
  for (const file of routeFiles) {
    const full = path.join(repoRoot, file);
    if (!fs.existsSync(full)) continue;
    const content = fs.readFileSync(full, "utf8");
    const routeCalls = (content.match(/router\.(get|post|put|patch|delete)\(/g) || []).length;
    const openapiBlocks = (content.match(/@openapi/g) || []).length;
    if (openapiBlocks < routeCalls) {
      problems.push(
        `  ${file}: ${routeCalls} router call(s) but only ${openapiBlocks} @openapi block(s)`
      );
    }
  }

  if (problems.length > 0) {
    console.error(
      "Blocked: staged route changes are missing Swagger docs.\n" +
        problems.join("\n") +
        "\n\nAdd an @openapi JSDoc block above each new/changed router.<method>(...) call " +
        "(and any new components.schemas in src/config/swagger.ts) before committing. " +
        "Consider using the swagger-doc-writer subagent. See backend/CLAUDE.md Workflow section."
    );
    process.exit(2);
  }

  process.exit(0);
});
