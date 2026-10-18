// Docs site generator: page blocks -> HTML + sitemap + llms.txt + llms-full.txt.
// The tool reference is not hand-written: the MCP package is started and `tools/list` plus real
// example calls are read, and every number comes from the data package. So the docs cannot drift
// from the server or the dataset.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { renderMd } from "./lib/blocks.mjs";
import { BASE, CSS, JS, MAIN, ORG, buildNav, page } from "./lib/layout.mjs";

const require = createRequire(import.meta.url);
const S = JSON.parse(readFileSync(new URL("./content/shared.json", import.meta.url), "utf8"));
const platforms = JSON.parse(readFileSync(new URL("./content/platforms.json", import.meta.url), "utf8"));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const dataDir = dirname(require.resolve("dyscalculia-data"));
const mcpDir = join(dirname(require.resolve("dyscalculia-mcp/dist/stdio.js")), "..");
const embedDir = dirname(require.resolve("dyscalculia-embed/package.json"));
const dataPkg = readJson(join(dataDir, "package.json"));
const mcpPkg = readJson(join(mcpDir, "package.json"));
const embedPkg = readJson(join(embedDir, "package.json"));
const stats = readJson(join(dataDir, "statistics.json"));
const refs = readJson(join(dataDir, "references.json"));
// The embed catalog is the embed package's own catalog.json: docs never carry a hand-made copy.
const catalog = readJson(join(embedDir, "catalog.json"));

// Docs describe `dyscalculia-embed` games, so an older package would document something that does not exist.
const EMBED_DOCS_MIN = "0.1.0";
const semver = (v) => v.split(".").map(Number);
const older = (a, b) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };
if (older(embedPkg.version, EMBED_DOCS_MIN) && process.env.ALLOW_OLD_EMBED !== "1") {
  throw new Error(`dyscalculia-embed ${embedPkg.version} is older than ${EMBED_DOCS_MIN}; publish/upgrade it first, or set ALLOW_OLD_EMBED=1 for a local build`);
}

const UPDATED = "2026-10-18";
const URL_MCP = S.MCP_URL;
const code = (label, c) => ({ t: "code", label, code: c });
const nf = (n) => n.toLocaleString("en-US");

/* ------------------------------------------- numbers: from the published data */
const prev = stats.prevalence;
const range = prev.find((p) => p.id === "worldwide-range");
const guideline = prev.find((p) => p.id === "german-guideline");
const populationStudies = prev.filter((p) => p.n);
// The check prompt's expected answer must be the dataset's own range.
if (!S.MCP_CHECK_ANSWER.includes(`${range.lo} to ${range.hi}`)) throw new Error(`MCP_CHECK_ANSWER "${S.MCP_CHECK_ANSWER}" does not match the data range ${range.lo}-${range.hi}`);

/* ------------------------------------------------ the real MCP server: tool schemas */
const client = new Client({ name: "docs-build", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [require.resolve("dyscalculia-mcp/dist/stdio.js")] }));
const { tools } = await client.listTools();
const SAMPLE = {
  get_prevalence: { study: "israel-1996" },
  list_studies: { topic: "persistence" },
  get_reference: { key: "shalev2000" },
  explain_screening_test: { game: "numberLine", include_items: true },
  list_chart_data: { id: "chart-1" },
  get_citation: {},
};
// Docs-owned one-liners and prompts (the server's own descriptions are printed in full on the tool page).
const TOOL_DOCS = {
  get_prevalence: { returns: "Prevalence figures with sample size, publication year, age, reference key and a `calc` flag; filter by study, age or percent range.", prompt: "What share of school-age children have dyscalculia, and which study says so?" },
  list_studies: { returns: "Every source the statistics page cites, with the topics it supports (prevalence, sex ratio, comorbidity, persistence, family, maths anxiety, interventions, ...).", prompt: "Which sources report how long dyscalculia lasts?" },
  get_reference: { returns: "One full citation by key, with DOI or PMID where the site has one.", prompt: "Give me the full reference for the Israeli population study." },
  explain_screening_test: { returns: "The five screening games: what each measures, item counts, how items and games are scored in general terms, optional item sets and the limits. A description, never a result.", prompt: "How is the free screening test scored, and what does it not cover?" },
  list_chart_data: { returns: "The 4 charts and 3 tables of the statistics page with their CSV, JSON and SVG addresses; with an id, the rows and reference keys.", prompt: "Give me the numbers behind the prevalence chart as a table." },
  get_citation: { returns: "License, citation text, an HTML credit link and the download addresses.", prompt: "How do I cite these dyscalculia statistics in a report?" },
};
const calls = {};
for (const t of tools) {
  const r = await client.callTool({ name: t.name, arguments: SAMPLE[t.name] ?? {} });
  if (r.isError) throw new Error(`sample call for ${t.name} failed: ${r.content[0].text}`);
  calls[t.name] = JSON.parse(r.content[0].text);
}
await client.close();
const missing = Object.keys(TOOL_DOCS).filter((n) => !tools.some((x) => x.name === n));
const undocumented = tools.filter((t) => !TOOL_DOCS[t.name]);
if (missing.length || undocumented.length) throw new Error(`tool list does not match the package: missing ${missing}, undocumented ${undocumented.map((t) => t.name)}`);
// Cross-check one sample response against the dataset so the reference is real, not decorative.
if (calls.get_prevalence.entries[0].pct !== stats.figures.israel.pct) throw new Error("get_prevalence sample differs from the data package");

const clip = (obj, max = 2400) => {
  const s = JSON.stringify(obj, null, 2);
  return s.length <= max ? s : `${s.slice(0, max).replace(/\n[^\n]*$/, "")}\n  … (truncated)`;
};

const toolBlocks = tools.flatMap((t) => {
  const props = t.inputSchema?.properties ?? {};
  const req = new Set(t.inputSchema?.required ?? []);
  const rows = Object.entries(props).map(([k, v]) => [`\`${k}\``, v.enum ? `enum: ${v.enum.map((e) => `\`${e}\``).join(", ")}` : v.type, req.has(k) ? "yes" : "no", v.description ?? ""]);
  const args = SAMPLE[t.name] ?? {};
  return [
    { t: "h2", text: t.name },
    { t: "p", text: t.description },
    rows.length ? { t: "table", head: ["Parameter", "Type", "Required", "Description"], rows } : { t: "p", text: "No parameters." },
    code("Example request (MCP tools/call)", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: t.name, arguments: args } }, null, 2)),
    code("Real response (from the package at build time)", clip(calls[t.name])),
  ];
});

/* ------------------------------------------------------------------- pages */
const clients = S.MCP_CLIENTS;
const pages = [];
const gamesN = catalog.games.length;
const langsN = catalog.languages.length;

pages.push({
  path: "/", label: "Overview", title: "Dyscalculia.io Developer Docs: Statistics Dataset, MCP Server and Number Games",
  description: "Developer documentation for Dyscalculia.io: sourced dyscalculia statistics as CSV and JSON, an MCP server for AI assistants, and free number practice games to embed. Open source.",
  h1: "Dyscalculia.io developer docs",
  lede: `Three free, open-source building blocks from [Dyscalculia.io](${MAIN}): the dyscalculia statistics as data (CSV, JSON and an npm package), an MCP server that lets AI assistants such as Claude, ChatGPT, Codex and Cursor look the figures up with their sources, and ${gamesN} number practice games you can embed in ${langsN} languages. ${populationStudies.length} population studies and ${refs.count} references, each with its year and source.`,
  blocks: [
    { t: "h2", text: "Start here" },
    { t: "table", head: ["I want to…", "Go to"], rows: [
      ["Let an AI assistant look up dyscalculia figures with sources", "[MCP server](/mcp)"],
      ["Download the statistics as CSV or JSON, or use them in code", "[Statistics dataset](/data)"],
      ["Put a free number game on my website", "[Embed the games](/embed)"],
      ["Try it in two minutes", "[Quickstart](/quickstart)"],
      ["Read the statistics as a page", `[Dyscalculia statistics](${MAIN}/dyscalculia-statistics)`],
    ] },
    { t: "h2", text: "What is published" },
    { t: "table", head: ["Package", "Version", "What it is", "Source"], rows: [
      [`\`${S.MCP_NPM}\``, mcpPkg.version, `Read-only MCP server: ${tools.length} tools, stdio and hosted HTTP`, `[GitHub](${S.MCP_REPO})`],
      ["`dyscalculia-data`", dataPkg.version, "The statistics, references and screening-game item sets as JSON and CSV with small helpers", `[GitHub](${S.DATA_REPO})`],
      ["`dyscalculia-embed`", embedPkg.version, "The free number practice games as a web component and React wrapper", `[GitHub](${S.EMBED_REPO})`],
    ] },
    { t: "h2", text: "What the figures are, and are not" },
    { t: "p", text: `The statistics are prevalence estimates from published studies and official counts, each with the year of the study and a reference you can check. There is no worldwide pooled meta-analysis of dyscalculia prevalence, so the overall figure is a range across population studies (${range.lo} to ${range.hi} percent; the German clinical guideline gives ${guideline.lo} to ${guideline.hi}), not one number. Studies use different criteria and ages, so they are not directly comparable.` },
    { t: "note", text: "These are research figures, not a diagnosis of any person. The free screening test on dyscalculia.io is a screening of basic number skills, not a diagnosis. The number games you can embed are practice: they show no score and no result." },
    { t: "h2", text: "Licenses" },
    { t: "ul", items: ["**Code** (MCP server, data package, embed package, these docs): MIT.", `**Statistics compilation** (selection, tables, charts, descriptions): CC BY 4.0. Credit Dyscalculia.io and link the [statistics page](${MAIN}/dyscalculia-statistics). Each figure belongs to the source it cites.`] },
  ],
});

pages.push({
  path: "/quickstart", label: "Quickstart", title: "Quickstart: Connect an AI Assistant to Dyscalculia.io Statistics in Two Minutes",
  description: "Add the hosted MCP server to Claude, ChatGPT, Codex or Cursor, ask for dyscalculia prevalence with sources, verify with curl, then use the dataset in code and embed a game.",
  h1: "Quickstart",
  lede: "Connect an AI assistant to the statistics, check it works, then use the data in code and put a game on a page. No account and no API key are needed for any step.",
  blocks: [
    { t: "h2", text: "1. Connect your assistant" },
    { t: "p", text: "The hosted server works in every client that supports remote MCP servers. Claude Code is one command:" },
    code("Claude Code", `claude mcp add --transport http --scope user dyscalculia ${URL_MCP}`),
    { t: "p", text: `For other clients use the same URL: \`${URL_MCP}\`. Step-by-step pages: ${clients.map((c) => `[${c.name}](/mcp/${c.id})`).join(", ")}.` },
    { t: "h2", text: "2. Ask a question" },
    { t: "p", text: S.MCP_CHECK_PROMPT },
    { t: "p", text: `The answer should be ${S.MCP_CHECK_ANSWER}, read by the \`get_prevalence\` tool.` },
    { t: "h2", text: "3. Check without a client" },
    code("curl", `curl -s ${URL_MCP} \\\n  -H 'content-type: application/json' \\\n  -H 'accept: application/json, text/event-stream' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`),
    { t: "p", text: "The address `https://mcp.dyscalculia.io/health` answers `ok`. The server is stateless and accepts only `POST /mcp`, so a browser visit to `/mcp` shows 405." },
    { t: "h2", text: "4. Use the data directly" },
    code("JavaScript", `npm install dyscalculia-data\n\nimport { prevalenceFor, getReference } from "dyscalculia-data";\nprevalenceFor({ study: "israel-1996" });  // 6.5 percent, 3,029 children, 1996\ngetReference("grosstsur1996");`),
    { t: "p", text: "Files, columns and examples in curl, Python and R are on the [dataset page](/data)." },
    { t: "h2", text: "5. Put a game on a page" },
    code("HTML", `<div data-dysc-game="dots"></div>\n<script async src="${MAIN}/embed.js"></script>`),
    { t: "p", text: "Options, languages, chart embeds, platform steps and the credit-line terms are on the [embed page](/embed)." },
  ],
});

pages.push({
  path: "/mcp", label: "Overview", title: "MCP Server: Sourced Dyscalculia Statistics for AI Assistants",
  description: "A free, read-only MCP server with dyscalculia prevalence figures, references with DOIs, chart data and a description of the screening games. Hosted URL or npx; open source.",
  h1: "MCP server",
  lede: `A free, read-only Model Context Protocol server. It gives an AI assistant ${prev.length} prevalence entries from ${populationStudies.length} population studies and ranges, ${refs.count} references, and the data behind the statistics page's charts, so a student or journalist can ask "what share of children have dyscalculia, and which study says so?" and get an answer with its source. Hosted at \`${URL_MCP}\`, or run locally with \`npx -y ${S.MCP_NPM}\`.`,
  blocks: [
    { t: "h2", text: "Hosted or local" },
    { t: "table", head: ["", "Hosted", "Local (npx)"], rows: [
      ["Install", "Nothing", `Node.js 18+, \`npx -y ${S.MCP_NPM}\``],
      ["Works in ChatGPT and Claude custom connectors", "Yes", "No (they cannot start a local process)"],
      ["Works offline", "No", "Yes"],
      ["Tools", `Same ${tools.length}`, `Same ${tools.length}`],
    ] },
    { t: "h2", text: "Connect your client" },
    { t: "ul", items: clients.map((c) => `[${c.name}](/mcp/${c.id}): ${c.summary.replace(/`/g, "")}`) },
    { t: "h2", text: "Tools" },
    { t: "table", head: ["Tool", "What it returns"], rows: tools.map((t) => [`[\`${t.name}\`](/mcp/tools#${t.name.replace(/_/g, "-")})`, TOOL_DOCS[t.name].returns]) },
    { t: "p", text: "Parameters and real example responses are on the [tool reference](/mcp/tools)." },
    { t: "h2", text: "What it does not do" },
    { t: "ul", items: S.NOT_DOING },
    { t: "h2", text: "Example questions" },
    { t: "ul", items: S.MCP_EXAMPLES.map((e) => `“${e}”`) },
  ],
});

for (const c of clients) {
  pages.push({
    path: `/mcp/${c.id}`, label: c.name,
    title: `Connect ${c.name} to the Dyscalculia.io MCP Server`,
    description: `How to add the Dyscalculia.io statistics MCP server to ${c.name}: ${c.summary.replace(/`/g, "")}`.slice(0, 200),
    h1: `Connect ${c.name}`,
    lede: c.summary,
    blocks: [
      { t: "h2", text: "Steps" },
      { t: "ol", items: c.steps },
      { t: "h2", text: "Configuration" },
      ...c.code.map((b) => code(b.label, b.code)),
      { t: "h2", text: "Check it works" },
      { t: "p", text: `Ask: “${S.MCP_CHECK_PROMPT}” The answer should be ${S.MCP_CHECK_ANSWER}.` },
      ...(c.note ? [{ t: "note", text: c.note }] : []),
      { t: "p", text: `Source for the ${c.name} syntax: [${c.source.label}](${c.source.url}). Client menus and file locations change; if a step no longer matches, follow that page and tell us on [GitHub](${S.MCP_REPO}/issues).` },
      { t: "p", text: "See also the [tool reference](/mcp/tools) and [troubleshooting](/faq#troubleshooting)." },
    ],
  });
}

pages.push({
  path: "/mcp/tools", label: "Tool reference", title: "MCP Tool Reference: Parameters and Real Responses",
  description: `Reference for all ${tools.length} tools of the Dyscalculia.io MCP server: parameters, types, example requests and real responses generated from the package.`,
  h1: "Tool reference",
  lede: `${tools.length} read-only tools. This page is generated at build time from the \`${S.MCP_NPM}@${mcpPkg.version}\` package: the parameters come from the server's own \`tools/list\` and the responses from calling each tool, so it cannot drift from the server.`,
  blocks: [{ t: "note", text: "Every tool is read-only, needs no authentication and scores no one. Invalid input returns a result with `isError: true` and a message that lists the valid options." }, ...toolBlocks],
});

const COLUMN_DOC = {
  section: "The section of the statistics page, or “At a glance” for the key figures",
  type: "`key_figure`, `chart` or `table`",
  title: "Title of the chart or caption of the table (empty for key figures)",
  row: "The row label (the study population for chart rows)",
  column: "The column label (for tables) or the measure (for charts)",
  value: "The value as shown on the page, for example `6.5%`",
  numeric_value: "The value as a number, for chart rows",
  note: "A note such as the sample size and publication year",
  data_year: "Year of the data, for key figures",
  source: "The citation text of the source",
  source_url: "Link to the source (PubMed, DOI or the official page)",
};
for (const col of stats.columns) if (!COLUMN_DOC[col]) throw new Error(`CSV column "${col}" is not described in COLUMN_DOC`);

pages.push({
  path: "/data", label: "Files and schema", title: "Dyscalculia Statistics Dataset: CSV and JSON, Schema, Examples and License",
  description: "Download sourced dyscalculia statistics as CSV and JSON: prevalence studies with sample size, year and age, comorbidity, persistence, maths anxiety, references and screening-game item sets. CC BY 4.0.",
  h1: "Statistics dataset",
  lede: `Files carry the figures shown on the [dyscalculia statistics page](${MAIN}/dyscalculia-statistics): ${prev.length} prevalence entries (${populationStudies.length} with a sample size), ${stats.charts.length} charts, ${stats.tables.length} tables, ${nf(stats.rows.length)} rows in all, and ${refs.count} references. Free to reuse under CC BY 4.0. The files hold published figures only: no person's data of any kind.`,
  blocks: [
    { t: "h2", text: "On the website" },
    { t: "table", head: ["File", "Contents", "Address"], rows: [
      ["`dyscalculia-statistics.json`", "All rows of the page plus license and methodology date", stats.files.json],
      ["`dyscalculia-statistics.csv`", "One row per figure; the first three lines are `#` comments with title, address and license, so read it with `comment=\"#\"`", stats.files.csv],
      ["`dyscalculia-statistics-chart-<n>.svg`", `One standalone SVG per chart (${stats.files.charts.length} charts)`, `${MAIN}/data/`],
      ["`screening-test.json`", "The five screening games: items, scoring rules and limits. No results, no one's answers", stats.files.screeningTest],
      ["`changelog.json`", "Dated changes to the site's test and method", stats.files.changelog],
    ] },
    { t: "p", text: "The files are static, served with CORS open (`Access-Control-Allow-Origin: *`) and cached for an hour, so a browser app can fetch them directly." },
    { t: "h2", text: "In the npm package" },
    { t: "p", text: `\`dyscalculia-data\` ships the same figures as plain files plus small helpers. Its \`statistics.csv\` has the header on the first line (no comment lines) and its JSON leaves out the site's generation timestamp; the rows are identical. It also carries \`references.json\` (${refs.count} sources by key) and \`screening-test.json\` (items and scoring only).` },
    { t: "table", head: ["File", "Contents"], rows: [
      ["`statistics.json`", "`figures` (the site's number object, unchanged), `calc`, `prevalence`, `keyFigures`, `charts`, `tables`, `rows`, license and citation"],
      ["`statistics.csv`", "The rows, header first, UTF-8 with BOM"],
      ["`references.json`", `${refs.count} references by site key: citation text, \`doi\` or \`pmid\` only where the site has one, \`url\` for official statistics, and the topics that cite each`],
      ["`screening-test.json`", "Item sets and scoring rules of the five games"],
    ] },
    { t: "h2", text: "CSV columns" },
    { t: "table", head: ["Column", "Meaning"], rows: stats.columns.map((c) => [`\`${c}\``, COLUMN_DOC[c]]) },
    { t: "h2", text: "Prevalence entries" },
    { t: "p", text: "Each entry has `pct` (or `lo` and `hi` for a range), `n` (sample size, null for reviews), `year` (publication year of the study), `age` as the site states it, `ref` (a key into the references) and `calc`: true when the site calculated the figure rather than the source reporting it." },
    { t: "table", head: ["Id", "Population", "Figure", "n", "Year", "Source key"], rows: prev.map((p) => [`\`${p.id}\``, p.population, p.kind === "range" ? `${p.lo}–${p.hi}%` : `${p.pct}%`, p.n ? nf(p.n) : "–", String(p.year), `\`${p.ref}\``]) },
    { t: "note", text: `${stats.honestLimits[0]} ${stats.honestLimits[1]}` },
    { t: "h2", text: "Examples" },
    ...S.DATA_EXAMPLES.map((e) => code(e.label, e.code)),
    code("JavaScript (npm)", `import { prevalenceFor, getReference, statistics } from "dyscalculia-data";\n\nprevalenceFor({ study: "israel-1996" });   // { pct: 6.5, n: 3029, year: 1996, ref: "grosstsur1996", ... }\nprevalenceFor({ age: 11 });                // entries whose stated age range includes 11\nprevalenceFor({ minPct: 6, maxPct: 7 });   // entries that overlap 6-7 percent\ngetReference("grosstsur1996").pmid;        // from the site's reference list\nstatistics.charts.map((c) => c.title);`),
    { t: "h2", text: "License and citation" },
    { t: "p", text: `${stats.license.note} Licence: [${stats.license.name}](${stats.license.url}). To quote a single number, cite its study (see the references), not only this compilation.` },
    code("Cite as", stats.citeAs),
    { t: "h2", text: "Limits" },
    { t: "ul", items: stats.honestLimits },
    { t: "h2", text: "Versions" },
    { t: "p", text: `The files change when the statistics page is reviewed. The npm package version follows, so a pinned dependency never shifts under you. Current package version: \`${dataPkg.version}\`. Figures last reviewed ${stats.updated}; next review planned ${stats.nextReview}.` },
  ],
});

const byGame = Object.fromEntries(catalog.games.map((g) => [g.id, catalog.items.filter((i) => i.game === g.id)]));
pages.push({
  path: "/embed", label: "Embed the number games", title: "Embed Free Number Practice Games on Your Website: Script, Web Component and React",
  description: "Add free number practice games to a school, tutoring or parenting site: script tag, web component or React; options, catalog, chart embeds, platform steps, credit link and privacy.",
  h1: "Embed the number games",
  lede: `Free number practice games for your own site: ${gamesN} games in ${langsN} languages, ${catalog.total} ready-to-embed combinations. They are practice, not a test: no score, no result. The embedded game page loads no analytics and sets no cookies. Three ways to add one: a script tag, a web component or a React component.`,
  blocks: [
    { t: "p", text: `A code builder with a live sample page is on [dyscalculia.io/embed](${MAIN}/embed): pick a game and see the result before you paste anything.` },
    { t: "note", text: "The games are practice with numbers, not a screening or an assessment. The Dyscalculia.io screening test cannot be embedded." },
    { t: "h2", text: "Script tag" },
    code("HTML", `<div data-dysc-game="dots"></div>\n<script async src="${MAIN}/embed.js"></script>`),
    { t: "p", text: "The script builds the iframe, keeps its height equal to its content and writes a visible credit line under the game into your page, in the game's language." },
    { t: "h2", text: "npm: web component" },
    code("Install", "npm install dyscalculia-embed"),
    code("Use", `<script type="module">import "dyscalculia-embed";</script>\n<dyscalculia-game game="dots" lang="en" size="standard"></dyscalculia-game>`),
    { t: "h2", text: "npm: React" },
    code("React", `import { Game } from "dyscalculia-embed/react";\n\n<Game game="numberline" size="wide" />\n<Game game="compare" lang="de" />`),
    { t: "p", text: "The wrapper registers the web component on the client only, so it is safe in server-rendered apps." },
    { t: "h2", text: "Plain iframe" },
    { t: "p", text: "For pages that block scripts. Add the credit line yourself." },
    code("HTML", `<iframe src="${MAIN}/embed/en/dots" title="${catalog.items[0].iframe.match(/title="([^"]+)"/)[1]}" width="480" height="560" style="border:0;width:100%;max-width:480px" loading="lazy"></iframe>\n<p style="text-align:center;font:12px system-ui,sans-serif">Free number games by <a href="${MAIN}/" target="_blank">Dyscalculia.io</a></p>`),
    { t: "h2", text: "Options" },
    { t: "table", head: ["Script", "Component / React", "Values"], rows: [
      ["`data-dysc-game`", "`game`", catalog.games.map((g) => `\`${g.id}\``).join(", ")],
      ["`data-lang`", "`lang`", `\`en\` (default), ${catalog.languages.filter((l) => l.code !== "en").map((l) => `\`${l.code}\``).join(", ")}`],
      ["`data-size`", "`size`", catalog.sizes.map((s) => `\`${s.id}\` (${s.width} px wide)`).join(", ") + "; `standard` is the default. The frame starts at " + catalog.sizes[0].height + " px tall and follows the game"],
    ] },
    { t: "h2", text: "Games" },
    { t: "table", head: ["`game`", "Name", "What the player does", "Languages"], rows: catalog.games.map((g) => [`\`${g.id}\``, g.name, g.what, byGame[g.id].map((i) => i.lang).join(", ")]) },
    { t: "p", text: `Every game exists in every language. The full catalog, with the name of each game in each language, example code and frame addresses, is machine-readable: [embed-catalog.json](${BASE}/embed-catalog.json) (the \`catalog.json\` of the npm package).` },
    { t: "h3", text: "Examples that exist today" },
    { t: "table", head: ["What you want", "Code"], rows: [
      ["Dot counting, English", "`data-dysc-game=\"dots\"`"],
      ["Number comparison in German", "`data-dysc-game=\"symbolic\" data-lang=\"de\"`"],
      ["Number line in Brazilian Portuguese, wide", "`data-dysc-game=\"numberline\" data-lang=\"pt-br\" data-size=\"wide\"`"],
      ["Digit memory in Dutch", "`data-dysc-game=\"digitspan\" data-lang=\"nl\"`"],
    ] },
    { t: "h2", text: "Chart embeds" },
    { t: "p", text: `The [statistics page](${MAIN}/dyscalculia-statistics) also offers embed code for its ${catalog.charts.length} charts: a standalone SVG (CC BY 4.0) in a figure whose caption links back to the page. Copy the code below or open "Embed" under a chart on the page.` },
    { t: "table", head: ["Chart", "Image"], rows: catalog.charts.map((c) => [c.title, c.svg]) },
    code(`HTML: ${catalog.charts[0].title}`, catalog.charts[0].html),
    { t: "p", text: "The other charts use the same pattern with their own image address; their ready-made code is in [CATALOG.md](" + `${S.EMBED_REPO}/blob/main/CATALOG.md` + "). Keep the caption: it is the credit and the link." },
    { t: "h2", text: "Add it on your platform" },
    { t: "p", text: "Steps taken from each platform's own help pages (read 18 October 2026). Menus and plan limits change; if a platform removes scripts, use the plain iframe and add the credit line by hand." },
    { t: "table", head: ["Platform", "Paste", "Steps", "Good to know"], rows: platforms.map((p) => [p.source ? `[${p.name}](${p.source})` : p.name, p.paste, p.steps.map((s, i) => `${i + 1}. ${s}`).join(" "), p.limits + (p.verified ? "" : " (Not fully confirmed from the official page.)")]) },
    { t: "h2", text: "Height" },
    { t: "p", text: "The game posts its content height to the parent window and the iframe follows. The script and the web component handle it; with a plain iframe you can listen yourself." },
    code("JavaScript", `window.addEventListener("message", (e) => {\n  if (e.origin !== "${MAIN}") return;\n  const m = e.data;\n  if (m && m.source === "dysc-embed" && m.type === "resize") {\n    iframe.style.height = Math.ceil(m.height) + "px";\n  }\n});`),
    { t: "h2", text: "The credit link" },
    { t: "p", text: `The script and the component write one small line under the game into your page, in the game's language: ${catalog.languages.map((l) => `“${l.creditLine}” (${l.code})`).join(", ")}. The name links to the Dyscalculia.io home page in that language. We ask that it stays visible. A link inside the frame would belong to the game's own document, which is why the line is written into your page.` },
    { t: "h2", text: "Privacy" },
    { t: "p", text: "The embedded game page loads no analytics and sets no cookies, and has no sign-up or account. Nothing the player does is sent anywhere: there is no score to send. The page loads from dyscalculia.io like any embedded file, so ordinary server request logs exist. The credit link on your page is only a link." },
    { t: "h2", text: "Terms" },
    { t: "ul", items: ["Free to use on any website, including schools, tutoring businesses and commercial sites.", "Keep the credit line under the game visible. Do not hide it or restyle it to invisibility.", "Do not change the game or present it as your own. The games are practice with numbers: not a test, and not an assessment of anyone."] },
    { t: "p", text: `Source: [dyscalculia-embed](${S.EMBED_REPO}).` },
  ],
});

const FAQ = [...S.MCP_FAQ, ...S.DEV_FAQ];
pages.push({
  path: "/faq", label: "FAQ and troubleshooting", title: "FAQ and Troubleshooting for the Dyscalculia.io MCP Server, Dataset and Games",
  description: "Answers about the Dyscalculia.io MCP server, statistics dataset and embeddable number games: accounts, sources, licenses, and fixes when tools do not appear or a connector option is missing.",
  h1: "FAQ and troubleshooting",
  lede: "Answers to the common questions about the MCP server, the dataset and the games, and fixes for the problems people hit most often.",
  faq: FAQ,
  blocks: [
    { t: "h2", text: "Frequently asked questions" },
    ...FAQ.flatMap((f) => [{ t: "h3", text: f.q }, { t: "p", text: f.a }]),
    { t: "h2", text: "Troubleshooting" },
    ...S.MCP_TROUBLESHOOTING.flatMap((f) => [{ t: "h3", text: f.q }, { t: "p", text: f.a }]),
    { t: "h3", text: "A game does not show on my page." },
    { t: "p", text: "Some platforms remove `<script>` tags, for example free plans of some site builders. Use the plain iframe code from the [embed page](/embed) and add the credit line yourself. Notion takes an address only: paste the game address after `/embed`." },
  ],
});

pages.push({
  path: "/changelog", label: "Changelog", title: "Changelog: Packages and Docs",
  description: "Dated changes to the Dyscalculia.io developer packages, the hosted MCP server and these docs.",
  h1: "Changelog",
  lede: "What changed in the developer packages and these docs. Changes to the statistics themselves are dated on the statistics page and in the data files (`updated`).",
  blocks: [
    { t: "table", head: ["Date", "Change"], rows: [
      [UPDATED, `First release of \`${S.MCP_NPM}\`, \`dyscalculia-data\` and \`dyscalculia-embed\` at 0.1.0; these docs; the hosted MCP server at \`${URL_MCP}\`.`],
    ] },
  ],
});

/* ------------------------------------------------------------------ output */
const nav = buildNav(clients);
const flat = nav.flatMap(([, items]) => items.map(([path, label]) => ({ path, label }))).filter((x) => x.path !== "/llms.txt");
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/assets", { recursive: true });
// public/: files that must sit at the root, such as the IndexNow key file (skipped when the folder is missing).
if (existsSync("public")) cpSync("public", "dist", { recursive: true });
writeFileSync("dist/assets/docs.css", CSS.trim());
writeFileSync("dist/assets/docs.js", JS.trim());
// The embed catalog served by the docs is the embed package's own catalog.json (generated, not hand-copied).
writeFileSync("dist/embed-catalog.json", readFileSync(join(embedDir, "catalog.json")));
const outPath = (p) => (p === "/" ? "dist/index.html" : `dist${p}.html`);
for (const p of pages) {
  mkdirSync(dirname(outPath(p.path)), { recursive: true });
  writeFileSync(outPath(p.path), page({ p, nav, flat, updated: UPDATED }));
}
writeFileSync("dist/404.html", `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found | Dyscalculia.io developer docs</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/assets/docs.css"></head><body><main style="max-width:640px;margin:15vh auto;padding:0 20px"><h1>Page not found</h1><p>That page is not in the docs. Start from the <a href="/">overview</a> or the <a href="/quickstart">quickstart</a>.</p></main></body></html>`);
writeFileSync("dist/robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${BASE}/sitemap.xml\n`);
writeFileSync("dist/sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `<url><loc>${BASE}${p.path === "/" ? "/" : p.path}</loc><lastmod>${UPDATED}</lastmod></url>`).join("\n")}\n</urlset>\n`);

writeFileSync("dist/llms.txt", [
  "# Dyscalculia.io developer docs", "",
  `> Documentation for the free, open-source developer tools of Dyscalculia.io (dyscalculia.io): sourced dyscalculia statistics as CSV and JSON (CC BY 4.0), a read-only MCP server for AI assistants, and free number practice games to embed. There is no worldwide pooled prevalence figure, only a range across population studies; the figures are not a diagnosis of any person.`, "",
  `Hosted MCP server: ${URL_MCP}`, `Source: ${ORG}`, "",
  "## Docs", "",
  ...pages.map((p) => `- [${p.h1}](${BASE}${p.path}): ${p.description}`), "",
  "## Optional", "",
  `- [Dyscalculia statistics](${MAIN}/dyscalculia-statistics): the figures as a page, with sources.`,
  `- [Methodology](${MAIN}/methodology): how the numbers and the screening test are built.`,
  `- [Full documentation as one file](${BASE}/llms-full.txt)`, "",
].join("\n"));
writeFileSync("dist/llms-full.txt", [
  "# Dyscalculia.io developer docs (full text)", "", `Source: ${BASE} · Updated ${UPDATED}`, "",
  ...pages.map((p) => `# ${p.h1}\n\nURL: ${BASE}${p.path}\n\n${renderMd([{ t: "p", text: p.lede }, ...p.blocks], BASE)}\n`),
].join("\n\n"));
console.log(`built ${pages.length} pages · tools documented: ${tools.length} · mcp ${mcpPkg.version} · data ${dataPkg.version} · embed ${embedPkg.version} · ${prev.length} prevalence entries · ${catalog.total} game combinations`);
