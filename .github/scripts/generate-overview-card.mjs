import { mkdir, writeFile } from "node:fs/promises";

const token = process.env.METRICS_TOKEN;
const login = process.env.GITHUB_LOGIN || "GabrielBrunhara";

if (!token) {
  throw new Error("METRICS_TOKEN is required");
}

const endpoint = "https://api.github.com/graphql";
const ignoredLanguages = new Set(["HTML", "CSS"]);
const maxLanguages = 8;
const now = new Date();
const oneYearAgo = new Date(now);
oneYearAgo.setUTCFullYear(now.getUTCFullYear() - 1);

const query = `
  query($login: String!, $after: String, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      name
      login
      createdAt
      followers {
        totalCount
      }
      following {
        totalCount
      }
      organizations(first: 100) {
        totalCount
      }
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
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        totalIssueContributions
        totalRepositoryContributions
        restrictedContributionsCount
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
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

  return payload.data.user;
}

async function searchTotal(path, queryText, accept) {
  const url = new URL(`https://api.github.com/${path}`);
  url.searchParams.set("q", queryText);

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: accept || "application/vnd.github+json",
      "user-agent": "GabrielBrunhara-profile-metrics",
    },
  });

  if (!response.ok) return null;
  const payload = await response.json();
  return payload.total_count ?? null;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
}

function formatBytes(bytes) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function languageStats(repositories) {
  const totals = new Map();

  for (const repository of repositories) {
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

  return {
    allCount: allLanguages.length,
    displayed,
    totalBytes,
  };
}

function stat(x, y, label, value) {
  return `
    <g transform="translate(${x} ${y})">
      <text class="stat-value" x="0" y="0">${escapeXml(value)}</text>
      <text class="muted" x="0" y="20">${escapeXml(label)}</text>
    </g>`;
}

function metricLine(x, y, label, value) {
  return `
    <g transform="translate(${x} ${y})">
      <circle cx="0" cy="-5" r="4" fill="#22D3EE" opacity="0.9" />
      <text class="label" x="14" y="0">${escapeXml(label)}</text>
      <text class="value" x="230" y="0" text-anchor="end">${escapeXml(value)}</text>
    </g>`;
}

function buildLanguageBar(languages, totalBytes, x, y, width) {
  let offset = 0;
  return languages
    .map((language, index) => {
      const currentWidth =
        index === languages.length - 1
          ? width - offset
          : Math.max(2, (language.bytes / totalBytes) * width);
      const rect = `<rect x="${(x + offset).toFixed(2)}" y="${y}" width="${currentWidth.toFixed(2)}" height="10" fill="${language.color}" />`;
      offset += currentWidth;
      return rect;
    })
    .join("");
}

function buildLanguageList(languages, totalBytes) {
  return languages
    .map((language, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = column === 0 ? 650 : 890;
      const y = 184 + row * 26;
      const percentage = ((language.bytes / totalBytes) * 100).toFixed(1);

      return `
        <circle cx="${x}" cy="${y - 5}" r="5" fill="${language.color}" />
        <text x="${x + 16}" y="${y}" class="label">${escapeXml(language.name)}</text>
        <text x="${x + 174}" y="${y}" class="muted" text-anchor="end">${percentage}%</text>`;
    })
    .join("");
}

function buildSvg({ user, languages, totals, searches }) {
  const calendar = user.contributionsCollection.contributionCalendar;
  const visibleContributions =
    calendar.totalContributions - user.contributionsCollection.restrictedContributionsCount;
  const languageSubtitle = `${totals.repositoryCount} contributed repositories · ${formatBytes(languages.totalBytes)} analyzed`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="320" viewBox="0 0 1240 320" role="img" aria-labelledby="title desc">
  <title id="title">GitHub activity and language metrics</title>
  <desc id="desc">Aggregated GitHub contribution and language metrics for Gabriel Brunhara</desc>
  <style>
    svg {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: #0D1117;
    }

    .title {
      fill: #FFFFFF;
      font-size: 24px;
      font-weight: 700;
    }

    .section {
      fill: #22D3EE;
      font-size: 18px;
      font-weight: 700;
    }

    .muted {
      fill: #8B949E;
      font-size: 13px;
    }

    .label {
      fill: #C9D1D9;
      font-size: 14px;
      font-weight: 500;
    }

    .value {
      fill: #FFFFFF;
      font-size: 14px;
      font-weight: 650;
    }

    .stat-value {
      fill: #FFFFFF;
      font-size: 28px;
      font-weight: 800;
    }
  </style>

  <rect width="1240" height="320" rx="0" fill="#0D1117" />
  <rect x="0" y="0" width="1240" height="2" fill="#22D3EE" opacity="0.9" />
  <rect x="0" y="2" width="1240" height="2" fill="#4A2CC5" opacity="0.85" />

  <text x="32" y="48" class="title">GitHub activity</text>
  <text x="650" y="48" class="title">Languages</text>
  <line x1="604" y1="32" x2="604" y2="284" stroke="#30363D" />

  ${stat(32, 98, "contributions this year", formatNumber(calendar.totalContributions))}
  ${stat(210, 98, "private contributions", formatNumber(user.contributionsCollection.restrictedContributionsCount))}
  ${stat(388, 98, "contributed repos", formatNumber(totals.repositoryCount))}

  ${metricLine(32, 154, "Public commits", formatNumber(visibleContributions))}
  ${metricLine(32, 184, "Searchable commits", formatNumber(searches.commits ?? 0))}
  ${metricLine(32, 214, "Pull requests opened", formatNumber(searches.pullRequests ?? 0))}
  ${metricLine(32, 244, "Pull requests reviewed", formatNumber(searches.reviews ?? 0))}
  ${metricLine(32, 274, "Organizations", formatNumber(user.organizations.totalCount))}

  <text x="650" y="88" class="section">Top ${languages.displayed.length} of ${languages.allCount}</text>
  <text x="650" y="110" class="muted">${escapeXml(languageSubtitle)}</text>

  <clipPath id="language-bar">
    <rect x="650" y="132" width="520" height="10" rx="5" />
  </clipPath>
  <g clip-path="url(#language-bar)">
    ${buildLanguageBar(languages.displayed, languages.totalBytes, 650, 132, 520)}
  </g>

  ${buildLanguageList(languages.displayed, languages.totalBytes)}
</svg>
`;
}

let after = null;
let user;
const repositories = [];

do {
  user = await graphql({
    login,
    after,
    from: oneYearAgo.toISOString(),
    to: now.toISOString(),
  });

  repositories.push(...(user.repositoriesContributedTo.nodes ?? []));
  const pageInfo = user.repositoriesContributedTo.pageInfo;
  after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
} while (after);

const [commitCount, pullRequestCount, reviewCount] = await Promise.all([
  searchTotal(
    "search/commits",
    `author:${login}`,
    "application/vnd.github.cloak-preview+json",
  ),
  searchTotal("search/issues", `author:${login} type:pr`),
  searchTotal("search/issues", `reviewed-by:${login} type:pr`),
]);

const languages = languageStats(repositories);

if (languages.totalBytes === 0) {
  throw new Error("No language data found for contributed repositories");
}

await mkdir("metrics", { recursive: true });
await writeFile(
  "metrics/overview.svg",
  buildSvg({
    user,
    languages,
    totals: {
      repositoryCount: user.repositoriesContributedTo.totalCount,
    },
    searches: {
      commits: commitCount,
      pullRequests: pullRequestCount,
      reviews: reviewCount,
    },
  }),
);
