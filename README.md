# Nedgame → ActiveCampaign Proxy

Doel: jouw Nedgame XML-feeds omzetten naar **RSS 2.0** (geschikt voor de ActiveCampaign RSS-blok) en parallel ook **JSON** publiceren. Gehost op GitHub Pages, automatisch vernieuwd via GitHub Actions.

## Waarom RSS en niet puur JSON?
ActiveCampaign kan in e-mails geen externe JSON renderen of scripts uitvoeren. De **RSS content block** kan wel een feed ophalen en in je template tonen. Daarom genereren we RSS die je direct kunt gebruiken. De JSON staat ernaast voor andere toepassingen.

## Mappen
- `src/transform.mjs` – script dat de Nedgame XML's ophaalt en omzet.
- `feeds.config.json` – beheer hier je bronnen en titels.
- `public/rss/*.xml` – output voor ActiveCampaign (gebruik deze URLs).
- `public/api/*.json` – parallelle JSON-output.
- `.github/workflows/build.yml` – draait op schema en bij push om output te vernieuwen.

## Deploy (GitHub Pages)
1. Maak een nieuwe public repo (bijv. `nedgame-ac-proxy`).
2. Upload alle bestanden uit deze zip.
3. Ga naar **Settings → Pages** en zet **Deploy from GitHub Actions** aan.
4. Push één keer (of upload via de web UI). De workflow bouwt en publiceert `public/`.

## Handmatig lokaal testen
```bash
npm install
npm run build
# open ./public/index.html in de browser
```

## ActiveCampaign gebruiken
- In je campagne kies je het **RSS**-blok en plak je de URL van een gegenereerde feed, zoals:
  - `https://<jouw-gebruikersnaam>.github.io/<jouw-repo>/rss/nieuw-binnen.xml`
- Het blok toont per item: titel, afbeelding, prijs en knoplink.
- Wil je minder/meer items? Dat stel je in bij het RSS-block in ActiveCampaign.

## Cron/Schema
De workflow draait **elk uur** en bij elke push. Aanpassen kan in `.github/workflows/build.yml`.

## Aanpassen van output
- Pas de HTML in `toRss()` aan als je andere markup wilt voor in de e-mail (let op: inline styles, geen scripts of iframes).
- Nieuwe feed toevoegen? Voeg een object toe in `feeds.config.json` met `slug`, `title`, `source`.

## Opmerking
De script-parser verwacht exact de Nedgame-structuur uit je voorbeeld (`<rss><items><product>...`). Als Nedgame ooit de structuur wijzigt, pas `parseProducts()` aan.
