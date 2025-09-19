import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

/**
 * Instelbaar aantal producten naast elkaar in één RSS-item.
 * Zet op 1 als je elk product als eigen item wilt.
 */
const ITEMS_PER_ROW = 3;

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const CONFIG_PATH = path.join(__dirname, "..", "feeds.config.json");
const OUT_DIR = path.join(__dirname, "..", "public");

/**
 * Parse Nedgame feed:
 * <rss><items><product>...</product>...</items></rss>
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

/**
 * Maak kaart-HTML voor één product
 * Titel onder afbeelding; prijs daaronder; alles gecentreerd.
 */
function productCardHTML(p) {
  const esc = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `
    <td style="text-align:center; width:180px; padding:10px; vertical-align:top;">
      <a href="${p.link}" style="text-decoration:none; color:#000;">
        <img src="${p.image}" alt="${esc(p.title)}" style="max-width:150px; height:auto; display:block; margin:0 auto;" />
        <div style="margin-top:8px; font-weight:bold; font-size:14px; line-height:1.3;">
          ${esc(p.title)}
        </div>
        <div style="margin-top:4px; color:#000; font-weight:bold;">
          € ${isFinite(p.price) ? p.price.toFixed(2) : esc(p.price)}
        </div>
      </a>
    </td>
  `.trim();
}

/**
 * Bouw een description-blok met N producten naast elkaar (1 rij).
 */
function rowHTML(productsInRow) {
  const cells = productsInRow.map(productCardHTML).join("");
  return `
    <![CDATA[
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse;">
        <tr>
          ${cells}
        </tr>
      </table>
    ]]>
  `.trim();
}

/**
 * Converteer naar RSS 2.0.
 * Wanneer ITEMS_PER_ROW > 1, worden producten in chunks geplaatst
 * zodat elk RSS-item meerdere “cards” naast elkaar toont.
 */
function toRss({ site, feedTitle, itemsChunks }) {
  const pubDate = new Date().toUTCString();
  const esc = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const itemXml = itemsChunks.map((chunk, idx) => {
    // Title van het RSS-item: feedTitle + set-nummer
    const itemTitle = itemsChunks.length > 1
      ? `${feedTitle} – set ${idx + 1}`
      : feedTitle;

    // Link van het item: neem link van eerste product voor fallback
    const firstLink = chunk[0]?.link || site.link;

    // Enclosure: pak de eerste image als enclosure
    const firstImage = chunk[0]?.image;
    const enclosure = firstImage ? `<enclosure url="${firstImage}" length="0" type="image/jpeg" />` : "";

    return `
      <item>
        <title>${esc(itemTitle)}</title>
        <link>${firstLink}</link>
        <guid isPermaLink="false">${esc(`${feedTitle}-${idx + 1}-${chunk[0]?.id || Date.now()}`)}</guid>
        <pubDate>${pubDate}</pubDate>
        <description>
          ${rowHTML(chunk)}
        </description>
        ${enclosure}
      </item>
    `.trim();
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(feedTitle || site.title)}</title>
    <link>${site.link}</link>
    <description>${esc(site.description || "Proxy feed")}</description>
    <language>${site.language || "nl-NL"}</language>
    <lastBuildDate>${pubDate}</lastBuildDate>
    ${itemXml}
  </channel>
</rss>`.trim();
}

/**
 * Chunk helper: splits array in blokken van size N
 */
function chunk(array, size) {
  if (size <= 1) return array.map(x => [x]);
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

async function main() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const config = JSON.parse(raw);

  await fs.mkdir(path.join(OUT_DIR, "rss"), { recursive: true });
  await fs.mkdir(path.join(OUT_DIR, "api"), { recursive: true });

  for (const feed of config.feeds) {
    try {
      const res = await fetch(feed.source, { headers: { "User-Agent": "nedgame-ac-proxy/1.1" } });
      if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
      const xml = await res.text();
      const products = parseProducts(xml);

      // JSON output (volledige lijst)
      const jsonOut = {
        title: feed.title,
        source: feed.source,
        generatedAt: new Date().toISOString(),
        count: products.length,
        products
      };
      await fs.writeFile(path.join(OUT_DIR, "api", `${feed.slug}.json`), JSON.stringify(jsonOut, null, 2), "utf8");

      // RSS output in "cards" met ITEMS_PER_ROW naast elkaar
      const chunks = chunk(products, Math.max(1, ITEMS_PER_ROW));
      const rssXml = toRss({
        site: config.site || { title: "Nedgame Feeds", link: "https://www.nedgame.nl/", language: "nl-NL" },
        feedTitle: feed.title,
        itemsChunks: chunks
      });
      await fs.writeFile(path.join(OUT_DIR, "rss", `${feed.slug}.xml`), rssXml, "utf8");

      console.log(`Generated: ${feed.slug} (${products.length} products / ${chunks.length} RSS items, ${ITEMS_PER_ROW} per row)`);
    } catch (e) {
      console.error(`Error on ${feed.slug}:`, e.message);
    }
  }

  // Indexpagina
  const indexHtml = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${config.site?.title || "Nedgame Feeds"} – GitHub Pages</title>
</head>
<body>
  <h1>${config.site?.title || "Nedgame Feeds"}</h1>
  <p>Proxy-output voor ActiveCampaign:</p>
  <ul>
    ${config.feeds.map(f => `<li>
      <a href="./rss/${f.slug}.xml">RSS: ${f.title}</a> · 
      <a href="./api/${f.slug}.json">JSON: ${f.title}</a>
    </li>`).join("")}
  </ul>
  <p>Layout: ${ITEMS_PER_ROW} product(en) per rij in de RSS items.</p>
</body>
</html>`;
  await fs.writeFile(path.join(OUT_DIR, "index.html"), indexHtml, "utf8");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
