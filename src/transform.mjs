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

  // Index with preview data
  const previewData = {};
  for (const feed of config.feeds) {
    try {
      const jsonPath = path.join(OUT_DIR, "api", `${feed.slug}.json`);
      const jsonContent = await fs.readFile(jsonPath, "utf8");
      const data = JSON.parse(jsonContent);
      previewData[feed.slug] = data.products.slice(0, 12); // Max 12 voor preview
    } catch (e) {
      previewData[feed.slug] = [];
    }
  }

  const indexHtml = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${config.site?.title || "Nedgame Feeds"} – ActiveCampaign RSS Proxy</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: linear-gradient(to bottom right, #f8fafc, #e2e8f0);
    min-height: 100vh;
    line-height: 1.6;
  }
  
  .container {
    max-width: 1280px;
    margin: 0 auto;
    padding: 2rem 1rem;
  }
  
  .header {
    text-align: center;
    margin-bottom: 3rem;
    animation: fadeInDown 0.6s ease-out;
  }
  
  .header h1 {
    font-size: 2.5rem;
    font-weight: 800;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 0.5rem;
  }
  
  .header p {
    color: #64748b;
    font-size: 1.125rem;
  }
  
  .feed-card {
    background: white;
    border-radius: 1rem;
    padding: 1.5rem;
    margin-bottom: 2rem;
    box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
    animation: fadeInUp 0.6s ease-out;
    animation-fill-mode: both;
  }
  
  .feed-card:nth-child(2) { animation-delay: 0.1s; }
  .feed-card:nth-child(3) { animation-delay: 0.2s; }
  .feed-card:nth-child(4) { animation-delay: 0.3s; }
  .feed-card:nth-child(5) { animation-delay: 0.4s; }
  
  .feed-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
    gap: 1rem;
  }
  
  .feed-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #1e293b;
  }
  
  .feed-controls {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
  }
  
  .columns-selector {
    display: flex;
    background: #f1f5f9;
    border-radius: 0.5rem;
    padding: 0.25rem;
    gap: 0.25rem;
  }
  
  .col-btn {
    padding: 0.5rem 1rem;
    border: none;
    background: transparent;
    color: #64748b;
    border-radius: 0.375rem;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.2s;
    font-size: 0.875rem;
  }
  
  .col-btn:hover {
    color: #334155;
  }
  
  .col-btn.active {
    background: white;
    color: #6366f1;
    box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1);
  }
  
  .url-container {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
  }
  
  .url-input {
    flex: 1;
    min-width: 300px;
    padding: 0.75rem 1rem;
    border: 2px solid #e2e8f0;
    border-radius: 0.5rem;
    font-family: 'Monaco', 'Courier New', monospace;
    font-size: 0.875rem;
    color: #475569;
    background: #f8fafc;
    transition: all 0.2s;
  }
  
  .url-input:focus {
    outline: none;
    border-color: #6366f1;
    background: white;
  }
  
  .copy-btn {
    padding: 0.75rem 1.25rem;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    border-radius: 0.5rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s;
    position: relative;
    overflow: hidden;
  }
  
  .copy-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 20px -5px rgba(102, 126, 234, 0.4);
  }
  
  .copy-btn.copied {
    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  }
  
  .json-btn {
    padding: 0.75rem 1.25rem;
    background: #0ea5e9;
    color: white;
    border: none;
    border-radius: 0.5rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s;
    text-decoration: none;
    display: inline-block;
  }
  
  .json-btn:hover {
    background: #0284c7;
    transform: translateY(-2px);
  }
  
  .preview-container {
    border: 2px dashed #e2e8f0;
    border-radius: 0.75rem;
    padding: 1rem;
    background: #fafafa;
    overflow-x: auto;
    transition: all 0.3s;
  }
  
  .preview-grid {
    display: grid;
    gap: 1rem;
    min-width: min-content;
    transition: grid-template-columns 0.3s ease;
  }
  
  .preview-grid.cols-1 { grid-template-columns: repeat(1, minmax(200px, 1fr)); }
  .preview-grid.cols-2 { grid-template-columns: repeat(2, minmax(200px, 1fr)); }
  .preview-grid.cols-3 { grid-template-columns: repeat(3, minmax(200px, 1fr)); }
  .preview-grid.cols-4 { grid-template-columns: repeat(4, minmax(200px, 1fr)); }
  
  .product-card {
    background: white;
    border-radius: 0.5rem;
    padding: 1rem;
    text-align: center;
    transition: all 0.3s;
    cursor: pointer;
    animation: productFadeIn 0.4s ease-out;
    animation-fill-mode: both;
  }
  
  .product-card:hover {
    transform: translateY(-4px);
    box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1);
  }
  
  .product-img {
    width: 100%;
    max-width: 150px;
    height: 150px;
    object-fit: contain;
    margin: 0 auto 0.75rem;
    border-radius: 0.375rem;
  }
  
  .product-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: #334155;
    margin-bottom: 0.5rem;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.4;
    min-height: 2.8em;
  }
  
  .product-price {
    font-size: 1.125rem;
    font-weight: 700;
    color: #6366f1;
  }
  
  .loading-text {
    text-align: center;
    color: #94a3b8;
    padding: 2rem;
    font-style: italic;
  }
  
  .stats-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.75rem;
    background: #f0f9ff;
    color: #0369a1;
    border-radius: 9999px;
    font-size: 0.875rem;
    font-weight: 500;
  }
  
  @keyframes fadeInDown {
    from {
      opacity: 0;
      transform: translateY(-20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  
  @keyframes fadeInUp {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  
  @keyframes productFadeIn {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
  
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }
  
  .toast {
    position: fixed;
    bottom: 2rem;
    right: 2rem;
    background: #10b981;
    color: white;
    padding: 1rem 1.5rem;
    border-radius: 0.5rem;
    font-weight: 600;
    box-shadow: 0 10px 25px -5px rgba(16, 185, 129, 0.4);
    transform: translateY(100px);
    opacity: 0;
    transition: all 0.3s;
    z-index: 1000;
  }
  
  .toast.show {
    transform: translateY(0);
    opacity: 1;
  }
  
  @media (max-width: 768px) {
    .preview-grid {
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)) !important;
    }
    
    .feed-header {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎮 Nedgame Feed Proxy</h1>
      <p>ActiveCampaign RSS feeds met aanpasbare product grid layouts</p>
    </div>
    
    ${indexLinks.map(({ feed, files }) => {
      const products = previewData[feed.slug] || [];
      const defaultCols = feed.default_per_row || 3;
      const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
      
      // HTML escaping functie voor product titels
      const escHtml = (str) => String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
      
      return `
      <div class="feed-card">
        <div class="feed-header">
          <h2 class="feed-title">${feed.title}</h2>
          <div class="feed-controls">
            <span class="stats-badge">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
              </svg>
              ${products.length} producten
            </span>
            <div class="columns-selector" data-feed="${feed.slug}">
              ${feed.row_variants.map(cols => `
                <button class="col-btn ${cols === defaultCols ? 'active' : ''}" 
                        data-cols="${cols}" 
                        onclick="updateColumns('${feed.slug}', ${cols})">
                  ${cols} ${cols === 1 ? 'kolom' : 'kolommen'}
                </button>
              `).join('')}
            </div>
            <a href="./api/${feed.slug}.json" class="json-btn">JSON</a>
          </div>
        </div>
        
        <div class="url-container">
          <input type="text" 
                 class="url-input" 
                 id="url-${feed.slug}" 
                 value="\${window.location.origin}/rss/${feed.slug}.xml" 
                 readonly />
          <button class="copy-btn" onclick="copyUrl('${feed.slug}')">
            <span class="copy-text">📋 Kopieer URL</span>
          </button>
        </div>
        
        <div class="preview-container">
          ${products.length > 0 ? `
            <div class="preview-grid cols-${defaultCols}" id="preview-${feed.slug}">
              ${products.slice(0, 8).map((p, idx) => `
                <div class="product-card" style="animation-delay: ${idx * 0.05}s">
                  <img src="${p.image}" alt="${escHtml(p.title)}" class="product-img" loading="lazy" />
                  <div class="product-title">${escHtml(p.title)}</div>
                  <div class="product-price">€ ${p.price ? p.price.toFixed(2) : '-.--'}</div>
                </div>
              `).join('')}
            </div>
          ` : '<div class="loading-text">Geen producten gevonden...</div>'}
        </div>
      </div>
      `;
    }).join('')}
  </div>
  
  <div class="toast" id="toast">✅ URL gekopieerd!</div>
  
  <script>
    // Initialize with actual base URL
    document.addEventListener('DOMContentLoaded', function() {
      const baseUrl = window.location.origin + window.location.pathname.replace(/index\\.html$/, '');
      document.querySelectorAll('.url-input').forEach(input => {
        const feedSlug = input.id.replace('url-', '');
        const defaultFile = getFileName(feedSlug, getCurrentCols(feedSlug));
        input.value = baseUrl + 'rss/' + defaultFile;
      });
    });
    
    function getCurrentCols(feedSlug) {
      const activeBtn = document.querySelector(\`.columns-selector[data-feed="\${feedSlug}"] .col-btn.active\`);
      return activeBtn ? parseInt(activeBtn.dataset.cols) : 3;
    }
    
    function getFileName(feedSlug, cols) {
      const config = ${JSON.stringify(config.feeds)};
      const feed = config.find(f => f.slug === feedSlug);
      const defaultCols = feed?.default_per_row || 3;
      return cols === defaultCols ? \`\${feedSlug}.xml\` : \`\${feedSlug}-r\${cols}.xml\`;
    }
    
    function updateColumns(feedSlug, cols) {
      // Update button states
      const selector = document.querySelector(\`.columns-selector[data-feed="\${feedSlug}"]\`);
      selector.querySelectorAll('.col-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.cols) === cols);
      });
      
      // Update preview grid
      const preview = document.getElementById(\`preview-\${feedSlug}\`);
      if (preview) {
        preview.className = \`preview-grid cols-\${cols}\`;
        
        // Re-trigger animations
        preview.querySelectorAll('.product-card').forEach((card, idx) => {
          card.style.animation = 'none';
          setTimeout(() => {
            card.style.animation = \`productFadeIn 0.4s ease-out \${idx * 0.05}s both\`;
          }, 10);
        });
      }
      
      // Update URL
      const baseUrl = window.location.origin + window.location.pathname.replace(/index\\.html$/, '');
      const fileName = getFileName(feedSlug, cols);
      const urlInput = document.getElementById(\`url-\${feedSlug}\`);
      urlInput.value = baseUrl + 'rss/' + fileName;
      
      // Highlight effect on URL change
      urlInput.style.background = '#fef3c7';
      urlInput.style.borderColor = '#fbbf24';
      setTimeout(() => {
        urlInput.style.background = '#f8fafc';
        urlInput.style.borderColor = '#e2e8f0';
      }, 300);
    }
    
    function copyUrl(feedSlug) {
      const input = document.getElementById(\`url-\${feedSlug}\`);
      const btn = event.currentTarget;
      
      // Copy to clipboard
      input.select();
      input.setSelectionRange(0, 99999);
      navigator.clipboard.writeText(input.value);
      
      // Button feedback
      btn.classList.add('copied');
      btn.querySelector('.copy-text').textContent = '✅ Gekopieerd!';
      
      // Show toast
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.querySelector('.copy-text').textContent = '📋 Kopieer URL';
        toast.classList.remove('show');
      }, 2000);
    }
  </script>
</body>
</html>`;
  await fs.writeFile(path.join(OUT_DIR, "index.html"), indexHtml, "utf8");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
