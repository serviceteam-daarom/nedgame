# Nedgame → ActiveCampaign Proxy

Zet Nedgame XML-feeds om naar **RSS 2.0** (voor ActiveCampaign) en **JSON**. Publicatie via GitHub Pages met GitHub Actions.

## Snel starten
1. Upload alles naar een **public** repo.
2. Settings → Pages → **Source = GitHub Actions**.
3. Actions → run de workflow of doe een commit.
4. Gebruik in ActiveCampaign het **RSS-blok** met een van:
   - `/rss/pre-orders.xml`
   - `/rss/nieuw-binnen.xml`
   - `/rss/best-verkocht.xml`
   - `/rss/merchandise.xml`

## Lokaal testen
```
npm install
npm run build
# Output in ./public/
```

## Aanpassen
- Bronnen in `feeds.config.json`.
- Output HTML in `toRss()` in `src/transform.mjs`.
