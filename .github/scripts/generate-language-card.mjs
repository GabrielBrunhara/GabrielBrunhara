import { mkdir, writeFile } from "node:fs/promises";

const token = process.env.METRICS_TOKEN;
const login = process.env.GITHUB_LOGIN || "GabrielBrunhara";

if (!token) {
  throw new Error("METRICS_TOKEN is required");
}

const ignoredLanguages = new Set(["HTML", "CSS"]);
const maxLanguages = 8;
const endpoint = "https://api.github.com/graphql";

const query = `
  query($login: String!, $after: String) {
    user(login: $login) {
      repositoriesContributedTo(
        first: 100
        after: $after
        includeUserRepositories: true
        contributionTypes: [COMMIT, PULL_REQUEST, PULL_REQUEST_REVIEW, REPOSITORY]
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges {
              size
              node {
                name
                color
              }
            }
          }
        }
      }
    }
  }
`;

async function graphql(variables) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "GabrielBrunhara-profile-metrics",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: ${response.status}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  return payload.data.user.repositoriesContributedTo;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatBytes(bytes) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function buildSvg({ languages, totalBytes, repositoryCount, totalLanguageCount }) {
  const width = 480;
  const rowHeight = 24;
  const rows = Math.ceil(languages.length / 2);
  const height = Math.max(150, 98 + rows * rowHeight);
  const barX = 24;
  const barY = 70;
  const barWidth = width - barX * 2;

  let offset = 0;
  const bar = languages
    .map((language, index) => {
      const currentWidth =
        index === languages.length - 1
          ? barWidth - offset
          : Math.max(2, (language.bytes / totalBytes) * barWidth);
      const rect = `<rect x="${(barX + offset).toFixed(2)}" y="${barY}" width="${currentWidth.toFixed(2)}" height="10" fill="${language.color}" />`;
      offset += currentWidth;
      return rect;
    })
    .join("\n      ");

  const list = languages
    .map((language, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = column === 0 ? 32 : 260;
      const y = 104 + row * rowHeight;
      const percentage = ((language.bytes / totalBytes) * 100).toFixed(1);

      return `
      <circle cx="${x}" cy="${y - 5}" r="5" fill="${language.color}" />
      <text x="${x + 16}" y="${y}" class="language">${escapeXml(language.name)}</text>
      <text x="${x + 126}" y="${y}" class="muted" text-anchor="end">${percentage}%</text>`;
    })
    .join("");

  const summary = `${repositoryCount} contributed repositories · ${formatBytes(totalBytes)} analyzed`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">GitHub language metrics</title>
  <desc id="desc">Most used languages across contributed repositories</desc>
  <style>
    svg {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: #0D1117;
    }

    .title {
      fill: #22D3EE;
      font-size: 18px;
      font-weight: 600;
    }

    .subtitle,
    .muted {
      fill: #8B949E;
      font-size: 12px;
    }

    .language {
      fill: #C9D1D9;
      font-size: 13px;
      font-weight: 500;
    }
  </style>

  <rect width="100%" height="100%" rx="0" fill="#0D1117" />
  <text x="24" y="32" class="title">Top ${languages.length} of ${totalLanguageCount} Languages</text>
  <text x="24" y="52" class="subtitle">${escapeXml(summary)}</text>

  <clipPath id="language-bar">
    <rect x="${barX}" y="${barY}" width="${barWidth}" height="10" rx="5" />
  </clipPath>

  <g clip-path="url(#language-bar)">
      ${bar}
  </g>

${list}
</svg>
`;
}

let after = null;
let repositoryCount = 0;
const totals = new Map();

do {
  const page = await graphql({ login, after });
  repositoryCount = page.totalCount;

  for (const repository of page.nodes ?? []) {
    for (const edge of repository.languages.edges ?? []) {
      const name = edge.node.name;
      if (ignoredLanguages.has(name)) continue;

      const current = totals.get(name) ?? {
        name,
        color: edge.node.color || "#8B949E",
        bytes: 0,
      };

      current.bytes += edge.size;
      totals.set(name, current);
    }
  }

  after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
} while (after);

const allLanguages = [...totals.values()].sort((a, b) => b.bytes - a.bytes);
let displayed = allLanguages.slice(0, maxLanguages);
const otherBytes = allLanguages
  .slice(maxLanguages)
  .reduce((sum, language) => sum + language.bytes, 0);

if (otherBytes > 0) {
  displayed = [
    ...displayed.slice(0, maxLanguages - 1),
    { name: "Other", color: "#4A2CC5", bytes: otherBytes },
  ];
}

const totalBytes = displayed.reduce((sum, language) => sum + language.bytes, 0);

if (totalBytes === 0) {
  throw new Error("No language data found for contributed repositories");
}

await mkdir("metrics", { recursive: true });
await writeFile(
  "metrics/languages.svg",
  buildSvg({
    languages: displayed,
    totalBytes,
    repositoryCount,
    totalLanguageCount: allLanguages.length,
  }),
);
