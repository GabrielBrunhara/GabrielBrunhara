import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const token = process.env.METRICS_TOKEN;
const generatorDirectory = process.env.ACTIVITY_GRAPH_DIR;
const login = process.env.GITHUB_LOGIN || "GabrielBrunhara";
if (!token) throw new Error("METRICS_TOKEN is required");
if (!generatorDirectory) throw new Error("ACTIVITY_GRAPH_DIR is required");

const require = createRequire(import.meta.url);
const { Utilities } = require(resolve(generatorDirectory, "dist/utils.js"));
const now = new Date();
const from = new Date(now);
from.setUTCDate(from.getUTCDate() - 30);
from.setUTCHours(0, 0, 0, 0);

const response = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "GabrielBrunhara-profile-activity",
  },
  signal: AbortSignal.timeout(30_000),
  body: JSON.stringify({
    query: `query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        name
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks { contributionDays { date contributionCount } }
          }
        }
      }
    }`,
    variables: { login, from: from.toISOString(), to: now.toISOString() },
  }),
});
if (!response.ok) throw new Error(`GitHub GraphQL request failed: ${response.status}`);
const payload = await response.json();
if (payload.errors?.length) {
  throw new Error(payload.errors.map((error) => error.message).join("; "));
}
const user = payload.data?.user;
if (!user) throw new Error(`GitHub user not found: ${login}`);
const contributions = user.contributionsCollection.contributionCalendar.weeks
  .flatMap((week) => week.contributionDays)
  .filter((day) => day.date >= from.toISOString().slice(0, 10)
    && day.date <= now.toISOString().slice(0, 10))
  .map((day) => ({ ...day, date: String(Number(day.date.slice(-2))) }));
if (contributions.length !== 31) {
  throw new Error(`Expected 31 contribution days, received ${contributions.length}`);
}

const graph = new Utilities({
  username: login,
  bg_color: "0D1117",
  color: "C9D1D9",
  line: "22D3EE",
  point: "4A2CC5",
  area: "true",
  area_color: "4A2CC5",
  hide_border: "true",
});
const { finalGraph } = await graph.buildGraph({ name: user.name, contributions });
if (!finalGraph.includes("ct-series") || !finalGraph.includes("<svg")) {
  throw new Error("Generator did not return a contribution chart");
}
await mkdir("metrics", { recursive: true });
await writeFile("metrics/activity.svg", finalGraph);
console.log(`Generated activity graph for ${login} with ${contributions.length} days`);
