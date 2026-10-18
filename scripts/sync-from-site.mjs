// Refreshes content/shared.json and content/platforms.json from the dyscalculia.io site's own modules
// (content/developers.ts and content/embedGuide.ts), so the commands shown here equal the ones on
// dyscalculia.io/mcp. Client menus change: when you edit one place, run this and review the diff.
//
//   node scripts/sync-from-site.mjs [path/to/dyscalculia_marketing]     (or DYSC_SITE=...)
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const site = resolve(process.argv[2] ?? process.env.DYSC_SITE ?? new URL("../../../dyscalculia_marketing", import.meta.url).pathname);
const { createJiti } = await import(`${site}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(`${site}/x.mjs`, { alias: { "@": site }, jsx: true });
const d = await jiti.import(`${site}/content/developers.ts`);
const g = await jiti.import(`${site}/content/embedGuide.ts`);

const shared = {
  MCP_URL: d.MCP_URL,
  MCP_NPM: d.MCP_NPM,
  MCP_CLIENTS: d.MCP_CLIENTS,
  GITHUB_ORG: d.GITHUB_ORG,
  MCP_REPO: d.MCP_REPO,
  DATA_REPO: d.DATA_REPO,
  EMBED_REPO: d.EMBED_REPO,
  MCP_CHECK_PROMPT: d.MCP_CHECK_PROMPT,
  MCP_CHECK_ANSWER: d.MCP_CHECK_ANSWER,
  MCP_EXAMPLES: d.MCP_EXAMPLES,
  NOT_DOING: d.NOT_DOING,
  MCP_TROUBLESHOOTING: d.MCP_TROUBLESHOOTING,
  MCP_FAQ: d.MCP_FAQ,
  DATA_EXAMPLES: d.DATA_EXAMPLES,
  DEV_FAQ: d.DEV_FAQ,
};
writeFileSync(new URL("../content/shared.json", import.meta.url), JSON.stringify(shared, null, 2) + "\n");

const platforms = g.PLATFORMS.map((p) => ({
  name: p.name,
  paste: g.USE_LABEL[p.use],
  steps: p.steps,
  limits: p.limits,
  verified: p.verified,
  ...(p.source ? { source: p.source } : {}),
}));
writeFileSync(new URL("../content/platforms.json", import.meta.url), JSON.stringify(platforms, null, 1) + "\n");
console.log(`shared.json: ${shared.MCP_CLIENTS.length} clients; platforms.json: ${platforms.length} platforms`);
