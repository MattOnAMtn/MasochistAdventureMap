# CLAUDE.md - MasochistAdventureMap

## Project Overview

Interactive web map visualizing long-distance hikes, paddles, and dive trips. Static HTML/CSS/JS app using Leaflet.js for mapping, with adventure data stored as GeoJSON/GPX files and metadata managed via Google Sheets (auto-synced to CSV).

## Tech Stack

- **Frontend**: Vanilla HTML5, CSS3, JavaScript (ES6+) — no build tools or frameworks
- **Mapping**: Leaflet.js v1.9.4 (loaded via CDN)
- **Data**: GeoJSON (`.json`), GPX (`.gpx`), CSV metadata
- **Hosting**: GitHub Pages / Blogger integration
- **Metadata source**: Google Sheets → `AdventureMapMetadata.csv`

## Project Structure

```
├── adventures.html              # Main app (~1,470 lines, all-in-one HTML/CSS/JS)
├── AdventureMapMetadata.csv     # Adventure metadata (synced from Google Sheets)
├── BloggerPages/                # Blogger-embedded version
│   └── AdventureMap.html
├── hikes/                       # GeoJSON + GPX trail data (~46 adventures)
├── paddles/                     # GeoJSON + GPX water route data (~14 adventures)
└── dives/                       # Waypoint JSON + GPX dive data (~24 adventures)
```

## Key Files

- **`adventures.html`** — The entire application. Contains all HTML, CSS, and JavaScript inline. Key functions: `loadMetadata()`, `parseGPX()`, `isFutureTrip()`.
- **`AdventureMapMetadata.csv`** — Central data file with columns: `StartDate, EndDate, Filename, Mileage, Gain, Count, Link`. Auto-updated from Google Sheets via GitHub Actions.

## Data Formats

- **Hikes/Paddles**: GeoJSON `FeatureCollection` with `LineString` coordinates
- **Dives**: Simple waypoint format `{"waypoints": [{"lat": ..., "lon": ...}]}` or GeoJSON
- **GPX**: Raw GPS track data from recording devices, paired with JSON files

## Adding a New Adventure

1. Add the GeoJSON/GPX files to the appropriate directory (`hikes/`, `paddles/`, or `dives/`)
2. Add a row to `AdventureMapMetadata.csv` (or update via Google Sheets) with the adventure metadata
3. The `Filename` column in the CSV must match the JSON filename (without path prefix)

## Conventions

- Adventures are color-coded by type (hike/paddle/dive) and status (complete/future)
- Future trips are determined by `isFutureTrip()` based on start date
- File naming: `YYYY - Adventure Name.json` (and matching `.gpx`)
- The app fetches data at runtime from GitHub raw URLs
- CSS uses mobile-first responsive breakpoints (480px, 768px, 1200px)
- No package manager, no dependencies to install, no build step

## Common Tasks

- **Preview locally**: Open `adventures.html` in a browser (data loads from GitHub)
- **Update metadata**: Edit Google Sheets source; CSV auto-syncs to repo
- **Add adventure**: Drop JSON/GPX files in correct directory, update CSV
