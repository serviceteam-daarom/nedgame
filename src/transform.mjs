import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

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

/** Product card HTML: links uitgelijnd (titel en prijs) */
function productCardHTML(p) {
  const esc = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `
    <td style="vertical-align:top; width:200px; padding:10px;">
      <a href="${p.link}" style="text-decoration:none; color:#000; display:block;">
        <img src="${p.image}" alt="${esc(p.title)}"
             style="max-width:150px; height:auto; display:block; margin:0 0 8px 0;" />
        <div style="margin:0; font-weight:bold; font-size:14px; line-height:1.3; text-align:left;">
          ${esc(p.title)}
        </div>
        <div style="margin-top:4px; color:#000; font-weight:bold; text-align:left;">
          € ${isFinite(p.price) ? p.price.toFixed(2) : esc(p.price)}
        </div>
      </a>
    </td>
  `.trim();
}

/** 1 rij HTML met N cards naast elkaar */
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

/** Split array in blokken van size N */
function chunk(array, size) {
  if (size <= 1) return array.map(x => [x]);
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

/** Bouw RSS 2.0 met cards in rijen van N */
function toRss({ site, feedTitle, itemsChunks, perRow }) {
  const pubDate = new Date().toUTCString();
  const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  const itemXml = itemsChunks.map((chunk, idx) => {
    const itemTitle = itemsChunks.length > 1
      ? `${feedTitle} – ${perRow} per rij – set ${idx + 1}`
      : `${feedTitle} – ${perRow} per rij`;

    const firstLink = chunk[0]?.link || site.link;
    const firstImage = chunk[0]?.image;
    const enclosure = firstImage ? `<enclosure url="${firstImage}" length="0" type="image/jpeg" />` : "";

    return `
      <item>
        <title>${esc(itemTitle)}</title>
        <link>${firstLink}</link>
        <guid isPermaLink="false">${esc(`${feedTitle}-${perRow}-${idx + 1}-${chunk[0]?.id || Date.now()}`)}</guid>
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

async function buildOneVariant({ site, feed, products, perRow }) {
  const chunks = chunk(products, Math.max(1, perRow));
  const rssXml = toRss({
    site,
    feedTitle: feed.title,
    itemsChunks: chunks,
    perRow
  });

  // bestandsnaam: default_per_row zonder suffix, varianten met -rX
  const suffix = perRow === (feed.default_per_row || 3) ? "" : `-r${perRow}`;
  const fileName = `${feed.slug}${suffix}.xml`;

  await fs.writeFile(path.join(OUT_DIR, "rss", fileName), rssXml, "utf8");
  return fileName;
}

async function main() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const config = JSON.parse(raw);

  await fs.mkdir(path.join(OUT_DIR, "rss"), { recursive: true });
  await fs.mkdir(path.join(OUT_DIR, "api"), { recursive: true });

  const indexLinks = [];

  for (const feed of config.feeds) {
    try {
      const res = await fetch(feed.source, { headers: { "User-Agent": "nedgame-ac-proxy/1.3" } });
      if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
      const xml = await res.text();
      const products = parseProducts(xml);

      // JSON (volledige lijst)
      const jsonOut = {
        title: feed.title,
        source: feed.source,
        generatedAt: new Date().toISOString(),
        count: products.length,
        products
      };
      await fs.writeFile(path.join(OUT_DIR, "api", `${feed.slug}.json`), JSON.stringify(jsonOut, null, 2), "utf8");

      // Variants
      const defaultPerRow = feed.default_per_row || 3;
      const variants = Array.isArray(feed.row_variants) && feed.row_variants.length
        ? Array.from(new Set(feed.row_variants.map(n => Math.max(1, parseInt(n, 10)))))
        : [defaultPerRow];

      if (!variants.includes(defaultPerRow)) variants.unshift(defaultPerRow);

      const files = [];
      for (const perRow of variants) {
        const file = await buildOneVariant({ site: config.site || {}, feed, products, perRow });
        files.push({ perRow, file });
      }

      indexLinks.push({ feed, files });
      console.log(`Generated ${feed.slug}: ${products.length} producten, varianten: ${files.map(f => f.perRow).join(", ")}`);
    } catch (e) {
      console.error(`Error on ${feed.slug}:`, e.message);
    }
  }

  // Index
  const indexHtml = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${config.site?.title || "Nedgame Feeds"} – GitHub Pages</title>
</head>
<body>
  <h1>${config.site?.title || "Nedgame Feeds"}</h1>
  <p>Kies de variant met het gewenste aantal items per rij.</p>
  <ul>
    ${indexLinks.map(({ feed, files }) => `
      <li>
        <strong>${feed.title}</strong>:
        ${files.map(f => `<a href="./rss/${f.file}">${f.perRow}/rij</a>`).join(" · ")}
        &nbsp;|&nbsp; <a href="./api/${feed.slug}.json">JSON</a>
      </li>
    `).join("")}
  </ul>
</body>
</html>`;
  await fs.writeFile(path.join(OUT_DIR, "index.html"), indexHtml, "utf8");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
