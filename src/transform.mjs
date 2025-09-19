
import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const CONFIG_PATH = path.join(__dirname, "..", "feeds.config.json");
const OUT_DIR = path.join(__dirname, "..", "public");

/**
 * Parse Nedgame feed XML structure into an array of product objects.
 * Expected structure:
 * <rss><items><product><id><![CDATA[]]></id> ... </product>...</items></rss>
 */
function parseProducts(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    cdataPropName: "__cdata",
    trimValues: true
  });
  const obj = parser.parse(xmlText);
  const items = obj?.rss?.items?.product ?? [];
  const products = Array.isArray(items) ? items : [items];
  const norm = (v) => {
    if (v == null) return "";
    if (typeof v === "object" && "__cdata" in v) return String(v.__cdata).trim();
    return String(v).trim();
  };
  return products
    .map(p => ({
      id: norm(p.id),
      title: norm(p.title),
      link: norm(p.link),
      image: norm(p.image_link),
      price: parseFloat(norm(p.price).replace(",", "."))
    }))
    .filter(p => p.id && p.title && p.link);
}

function toRss({ site, title, link, description, items }) {
  const pubDate = new Date().toUTCString();
  const escape = (s) => s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const itemXml = items.map(it => {
    const desc = `<![CDATA[
      <table style="width:100%; border-collapse:collapse;">
        <tr>
          <td style="width:120px; vertical-align:top;">
            <img src="${it.image}" alt="${escape(it.title)}" style="max-width:120px;height:auto;" />
          </td>
          <td style="vertical-align:top; padding-left:10px;">
            <p style="margin:0;font-weight:bold;">€ ${it.price.toFixed(2)}</p>
            <p style="margin:8px 0 0 0;"><a href="${it.link}">Bekijk product</a></p>
          </td>
        </tr>
      </table>
    ]]>`;
    const enclosure = it.image ? `<enclosure url="${it.image}" length="0" type="image/jpeg" />` : "";
    return `
      <item>
        <title>${escape(it.title)}</title>
        <link>${it.link}</link>
        <guid isPermaLink="false">${escape(it.id)}</guid>
        <pubDate>${pubDate}</pubDate>
        <description>${desc}</description>
        ${enclosure}
      </item>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escape(title || site.title)}</title>
    <link>${link || site.link}</link>
    <description>${escape(description || site.description)}</description>
    <language>${site.language || "nl-NL"}</language>
    <lastBuildDate>${pubDate}</lastBuildDate>
    ${itemXml}
  </channel>
</rss>`;
}

async function main() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const config = JSON.parse(raw);
  await fs.mkdir(path.join(OUT_DIR, "rss"), { recursive: true });
  await fs.mkdir(path.join(OUT_DIR, "api"), { recursive: true });

  for (const feed of config.feeds) {
    try {
      const res = await fetch(feed.source, { headers: { "User-Agent": "nedgame-ac-proxy/1.0" } });
      if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
      const xml = await res.text();
      const products = parseProducts(xml);

      // JSON output
      const jsonOut = {
        title: feed.title,
        source: feed.source,
        generatedAt: new Date().toISOString(),
        count: products.length,
        products
      };
      await fs.writeFile(path.join(OUT_DIR, "api", `${feed.slug}.json`), JSON.stringify(jsonOut, null, 2), "utf8");

      // RSS output
      const rssXml = toRss({
        site: config.site,
        title: feed.title,
        link: config.site.link,
        description: `${feed.title} via Nedgame proxy feed`,
        items: products
      });
      await fs.writeFile(path.join(OUT_DIR, "rss", `${feed.slug}.xml`), rssXml, "utf8");

      console.log(`Generated: ${feed.slug} (${products.length} items)`);
    } catch (e) {
      console.error(`Error on ${feed.slug}:`, e.message);
    }
  }

  // Friendly index
  const indexHtml = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${config.site.title} – GitHub Pages</title>
</head>
<body>
  <h1>${config.site.title}</h1>
  <p>Proxy-output voor ActiveCampaign:</p>
  <ul>
    ${config.feeds.map(f => `<li>
      <a href="./rss/${f.slug}.xml">RSS: ${f.title}</a> &middot; 
      <a href="./api/${f.slug}.json">JSON: ${f.title}</a>
    </li>`).join("")}
  </ul>
  <p>Broncode en instructies in <code>README.md</code>.</p>
</body>
</html>`;

  await fs.writeFile(path.join(OUT_DIR, "index.html"), indexHtml, "utf8");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
