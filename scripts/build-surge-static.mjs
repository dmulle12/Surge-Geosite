// Build static Surge rule files for GitHub Pages (no Cloudflare needed).
//
// - Reads dist/geosite-json/*.json and dist/geoip-json/*.json
//   (produced by `npm run build:geosite` / `npm run build:geoip`)
// - Emits pages/surge/<NAME>.list and pages/surge/<NAME>@<attr>.list
//   in Surge RULE-SET format, plus pages/geoip/<NAME>.list variants.
// - Emits pages/index.json (discovery map) and a minimal pages/index.html.
//
// Conversion mirrors worker/index.ts:
//   geosite: domain -> DOMAIN-SUFFIX, ; full -> DOMAIN, ; regexp -> skipped
//   geoip:   cidr4 -> IP-CIDR,<cidr>,no-resolve ; cidr6 -> IP-CIDR6,<cidr>,no-resolve
// Attribute filters (@cn / @!cn / @ads, case-insensitive) behave like
// the worker's /geosite/<name>@<filter> endpoint.
//
// Node 18+ required.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const GEOSITE_JSON_DIR = path.join(ROOT, "dist", "geosite-json");
const GEOIP_JSON_DIR = path.join(ROOT, "dist", "geoip-json");
const OUT_DIR = path.join(ROOT, "pages");
const SURGE_DIR = path.join(OUT_DIR, "surge");
const GEOIP_DIR = path.join(OUT_DIR, "geoip");

const ruleMatchesAttr = (rule, filter) => {
  const neg = filter.startsWith("!");
  const target = (neg ? filter.slice(1) : filter).toLowerCase();
  const attrs = (rule.attrs || []).map((a) => String(a).toLowerCase());
  const has = attrs.includes(target);
  return neg ? !has : has;
};

const geositeToSurge = (rules, filter = null) => {
  const lines = [];
  for (const r of rules) {
    if (filter && !ruleMatchesAttr(r, filter)) continue;
    if (r.type === "domain") lines.push(`DOMAIN-SUFFIX,${r.value}`);
    else if (r.type === "full") lines.push(`DOMAIN,${r.value}`);
    // regexp rules are skipped, same as the worker
  }
  return lines.length ? lines.join("\n") + "\n" : "";
};

const geoipToSurge = (json, filter = null) => {
  const f = (filter || "").toLowerCase();
  const wantV4 = !f || f === "v4" || f === "ipv4";
  const wantV6 = !f || f === "v6" || f === "ipv6";
  const lines = [];
  if (wantV4) {
    for (const c of json.cidr4 || []) lines.push(`IP-CIDR,${c},no-resolve`);
  }
  if (wantV6) {
    for (const c of json.cidr6 || []) lines.push(`IP-CIDR6,${c},no-resolve`);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
};

const readJson = async (p) => JSON.parse(await fsp.readFile(p, "utf8"));

const main = async () => {
  await fsp.rm(OUT_DIR, { recursive: true, force: true });
  await fsp.mkdir(SURGE_DIR, { recursive: true });
  await fsp.mkdir(GEOIP_DIR, { recursive: true });

  const index = { geosite: {}, geoip: {} };

  // ---- geosite ----
  const geositeFiles = (await fsp.readdir(GEOSITE_JSON_DIR))
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of geositeFiles) {
    const name = path.basename(file, ".json");
    const data = await readJson(path.join(GEOSITE_JSON_DIR, file));
    const rules = data.rules || [];

    // attribute variants actually present in this category, e.g. @cn
    const attrs = new Set();
    for (const r of rules) {
      for (const a of r.attrs || []) {
        const v = String(a).trim();
        if (v) attrs.add(v.startsWith("!") ? v : v.toLowerCase());
      }
    }

    const variants = { "": geositeToSurge(rules) };
    for (const attr of [...attrs].sort()) {
      variants[`@${attr}`] = geositeToSurge(rules, attr);
    }

    const entry = { file: `surge/${name}.list`, rules: rules.length, variants: {} };
    for (const [suffix, text] of Object.entries(variants)) {
      if (!text) continue;
      const outName = `${name}${suffix}.list`;
      await fsp.writeFile(path.join(SURGE_DIR, outName), text);
      entry.variants[suffix || "(default)"] = `surge/${outName}`;
    }
    index.geosite[name] = entry;
  }

  // ---- geoip ----
  const geoipFiles = fs.existsSync(GEOIP_JSON_DIR)
    ? (await fsp.readdir(GEOIP_JSON_DIR)).filter((f) => f.endsWith(".json")).sort()
    : [];
  for (const file of geoipFiles) {
    const name = path.basename(file, ".json");
    const data = await readJson(path.join(GEOIP_JSON_DIR, file));
    const entry = {
      file: `geoip/${name}.list`,
      cidr4: (data.cidr4 || []).length,
      cidr6: (data.cidr6 || []).length,
      variants: {},
    };
    for (const suffix of ["", "@v4", "@v6"]) {
      const text = geoipToSurge(data, suffix ? suffix.slice(1) : null);
      if (!text) continue;
      const outName = `${name}${suffix}.list`;
      await fsp.writeFile(path.join(GEOIP_DIR, outName), text);
      entry.variants[suffix || "(default)"] = `geoip/${outName}`;
    }
    index.geoip[name] = entry;
  }

  await fsp.writeFile(
    path.join(OUT_DIR, "index.json"),
    JSON.stringify(index, null, 2) + "\n"
  );

  // ---- minimal landing page ----
  const geositeNames = Object.keys(index.geosite);
  const geoipNames = Object.keys(index.geoip);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Surge Geosite (static mirror)</title>
<style>
body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;line-height:1.6}
code{background:#f0f0f0;padding:2px 6px;border-radius:4px}
ul{columns:3;list-style:none;padding:0}
li{margin:2px 0;break-inside:avoid}
h2{margin-top:2rem}
</style>
</head>
<body>
<h1>Surge Geosite — static mirror</h1>
<p>Daily-built Surge RULE-SET files from Loyalsoldier/v2ray-rules-dat. No Cloudflare involved.</p>
<h2>Usage</h2>
<p><code>RULE-SET,https://jovanykoch.github.io/Surge-Geosite-Enhance/surge/CHINA-LIST.list,DIRECT</code></p>
<p>Attribute variants (same as the old <code>/geosite/&lt;name&gt;@&lt;filter&gt;</code> API): append <code>@cn</code>, <code>@!cn</code> or <code>@ads</code> before <code>.list</code> when listed below.</p>
<p>GeoIP: <code>RULE-SET,https://jovanykoch.github.io/Surge-Geosite-Enhance/geoip/CN.list,DIRECT</code> (<code>@v4</code> / <code>@v6</code> variants available).</p>
<p>Machine-readable index: <a href="index.json">index.json</a></p>
<h2>Geosite (${geositeNames.length})</h2>
<ul>
${geositeNames.map((n) => {
  const e = index.geosite[n];
  const vars = Object.keys(e.variants).filter((v) => v !== "(default)");
  return `<li><a href="${e.variants["(default)"]}">${n}</a>${vars.length ? ` <small>(${vars.join(" ")})</small>` : ""}</li>`;
}).join("\n")}
</ul>
<h2>GeoIP (${geoipNames.length})</h2>
<ul>
${geoipNames.map((n) => `<li><a href="${index.geoip[n].variants["(default)"]}">${n}</a></li>`).join("\n")}
</ul>
</body>
</html>
`;
  await fsp.writeFile(path.join(OUT_DIR, "index.html"), html);

  console.log(
    `Wrote ${geositeNames.length} geosite + ${geoipNames.length} geoip lists to ${OUT_DIR}`
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
