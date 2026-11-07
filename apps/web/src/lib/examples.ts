import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./repo";

/**
 * The quick-start example, read from examples/quickstart at build time, so the code on
 * the website is always the code that runs (and is type-checked with the SDK).
 */
const root = join(repoRoot(), "examples", "quickstart", "src");
export const quickstart = {
  workflow: readFileSync(join(root, "workflow.ts"), "utf8").trim(),
  worker: readFileSync(join(root, "worker.ts"), "utf8").trim(),
  run: readFileSync(join(root, "run.ts"), "utf8").trim(),
};

/** Installation commands, in order (the homepage and the quick start show these). scripts/check-quickstart.mjs runs them. */
export const installSteps: { title: string; detail: string; code: string; shell?: string }[] = [
  {
    title: "Get the code and install",
    detail: "Node.js 22 or later and Docker. FlowForge is not published to npm yet, so you run it from the repository.",
    code: "git clone https://github.com/Jithendranath8/FlowForge.git\ncd FlowForge\nnpm ci\nnpm run build",
  },
  {
    title: "Start Postgres and Redis",
    detail: "PostgreSQL 16 holds every workflow, run and task. Redis only delivers wake-ups; FlowForge keeps working without it. --wait returns once both are ready to accept connections.",
    code: "docker compose up -d --wait",
  },
  {
    title: "Configure",
    detail: "Copy the template and set a session secret. The defaults point at the containers above.",
    code: "cp .env.example .env\nnode -e \"console.log('SESSION_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))\" >> .env",
  },
  {
    title: "Start the API",
    detail: "Database migrations run on start. The API listens on http://localhost:4000.",
    code: "npm run dev:api",
  },
  {
    title: "Create a workspace and two API keys",
    detail: "In a second terminal. One key submits workflows; the worker key only executes tasks. Each key is printed once.",
    code: "npm run admin -- create-tenant demo\nnpm run admin -- create-key demo cli read,workflows:write,runs:write\nnpm run admin -- create-key demo worker worker",
  },
  {
    title: "Start a worker",
    detail: "It registers, long-polls for tasks and runs the handlers in examples/quickstart/src/worker.ts.",
    code: "FLOWFORGE_API_KEY=<worker key> npm run worker -w @flowforge/example-quickstart",
  },
  {
    title: "Run the workflow",
    detail: "In a third terminal: registers the workflow, starts a run and waits for it.",
    code: "FLOWFORGE_API_KEY=<cli key> npm run run-workflow -w @flowforge/example-quickstart",
  },
  {
    title: "Inspect the result",
    detail: "Every attempt, event and output is in Postgres and available over the API (and in the dashboard).",
    code: "curl -s -H \"authorization: Bearer <cli key>\" http://localhost:4000/v1/runs | head -c 600",
  },
];
