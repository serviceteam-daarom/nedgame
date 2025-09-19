import fs from "fs";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

const config = JSON.parse(fs.readFileSync("feeds.config.json", "utf-8"));
const parser = new XMLParser();

async function fetchFeed(feed) {
  console.log(`Fetching: ${feed.url}`);
  const res = await fetch(feed.url);
  const xml = await res.text();
  const json = parser.parse(xml);

  const products = json?.rss?.items?.product || [];
  const mapped = products.map((p) => ({
    id: p.id,
    title: p.title,
    link: p.link,
    image: p.image_link,
    price: p.price
  }));

  // JSON opslaan
  const jsonPath = `public/api/${feed.slug}.json`;
  fs.mkdirSync("public/api", { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(mapped, null, 2));

  // RSS opnieuw schrijven (ActiveCampaign kan XML)
  const rssItems = mapped.map((p) => `
    <item>
      <title><![CDATA[${p.title}]]></title>
      <link>${p.link}</link>
      <enclosure url="${p.image}" type="image/jpeg"/>
      <guid>${p.id}</guid>
      <description><![CDATA[Prijs: €${p.price}]]></description>
    </item>
  `).join("\n");

  const rss = `<?xml version="1.0" encoding="UTF-8" ?>
  <rss version="2.0">
    <channel>
      <title>${feed.title}</title>
      <link>${feed.url}</link>
      <description>${feed.title} feed</description>
      ${rssItems}
    </channel>
  </rss>`;

  const rssPath = `public/rss/${feed.slug}.xml`;
  fs.mkdirSync("public/rss", { recursive: true });
  fs.writeFileSync(rssPath, rss);
}

async function main() {
  for (const feed of config.feeds) {
    try {
      await fetchFeed(feed);
    } catch (err) {
      console.error(`Error with ${feed.url}:`, err);
    }
  }

  // Index maken
  const indexHtml = `
  <html>
    <head><title>Nedgame AC Proxy</title></head>
    <body>
      <h1>Nedgame feeds</h1>
      <ul>
        ${config.feeds.map(f => `<li><a href="/rss/${f.slug}.xml">${f.title} (RSS)</a> | <a href="/api/${f.slug}.json">JSON</a></li>`).join("\n")}
      </ul>
    </body>
  </html>`;

  fs.writeFileSync("public/index.html", indexHtml);
}

main();
