# Legacy trip archive

`build-legacy-archive.mjs` downloads the published `Trips_NEW` and `Peaks_NEW`
tabs from the **FCoTM JSON** workbook and creates:

- `data/legacy-archive.json` — the stable, browser-ready archive consumed by Blogger.
- `data/legacy-archive-audit.json` — non-fatal data warnings to review over time.

The GitHub workflow runs daily and can also be started manually from the Actions
tab. It commits output only when the source data has changed.

CalTopo and Flickr map URLs are stored separately. CalTopo should be presented as
the primary interactive route map; Flickr should be labeled as a static map image.
