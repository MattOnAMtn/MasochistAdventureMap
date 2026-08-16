import { mkdir, writeFile } from 'node:fs/promises';

const SHEET = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vR4VTs94z-gknDfCKTYgZk7Xdc6EruKB_ajYxHoJHIUfKybTLf4slcPz7HI2CbCtg1qPS9aPTppr8uE/pub';
const SOURCES = {
  trips: `${SHEET}?output=csv&gid=244642622`,
  peaks: `${SHEET}?output=csv&gid=470214005`,
};

const clean = value => String(value ?? '').trim();
const splitList = value => clean(value).split(/\s*(?:\||,)\s*/).filter(Boolean);
const unique = values => [...new Set(values.filter(Boolean))];

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

function records(csv) {
  const rows = parseCsv(csv).filter(row => row.some(clean));
  const headers = rows.shift().map((header, index) => clean(header).replace(/^\uFEFF/, '') || `_column_${index + 1}`);
  return rows.map(row => Object.fromEntries(headers.map((header, index) => [header, clean(row[index])])));
}

async function fetchCsv(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'MasochistAdventureMap archive builder' } });
  if (!response.ok) throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  return response.text();
}

function number(value) {
  if (!clean(value)) return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(value, warnings, context) {
  const raw = clean(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) { warnings.push(`${context}: unrecognized date “${raw}”`); return null; }
  const [, month, day, year] = match.map(Number);
  if (year < 1900 || year > new Date().getUTCFullYear() + 2) warnings.push(`${context}: suspicious year in “${raw}”`);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    warnings.push(`${context}: invalid date “${raw}”`);
    return null;
  }
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function classifyMaps(row) {
  const urls = unique([
    ...splitList(row['Map URL']),
    ...clean(row['All Map URLs']).split(/\s*\|\s*/).filter(Boolean),
  ]).filter(url => /^https?:\/\//i.test(url));
  return {
    caltopo: urls.find(url => /(?:^|\.)caltopo\.com\//i.test(url)) ?? null,
    staticImage: urls.find(url => /(?:^|\.)flickr\.com\//i.test(url)) ?? null,
    other: urls.filter(url => !/(?:^|\.)(?:caltopo|flickr)\.com\//i.test(url)),
  };
}

function locationFor(trip, peaks) {
  const lat = number(trip['Trip Lat']), lng = number(trip['Trip Lng']);
  if (lat !== null && lng !== null) return { lat, lng, source: clean(trip['Lat Source']) || 'trip' };
  const points = peaks.filter(peak => peak.lat !== null && peak.lng !== null);
  if (!points.length) return null;
  return {
    lat: Number((points.reduce((sum, point) => sum + point.lat, 0) / points.length).toFixed(6)),
    lng: Number((points.reduce((sum, point) => sum + point.lng, 0) / points.length).toFixed(6)),
    source: points.length === 1 ? 'peak' : 'peak-centroid',
  };
}

const [tripCsv, peakCsv] = await Promise.all(Object.values(SOURCES).map(fetchCsv));
const tripRows = records(tripCsv);
const peakRows = records(peakCsv);
const warnings = [];

for (const required of ['Trip ID', 'Trip Name', 'Date Start', 'Trip Types']) {
  if (!(required in (tripRows[0] ?? {}))) throw new Error(`Trips_NEW is missing required column: ${required}`);
}
for (const required of ['Trip ID', 'Peak Name', 'Lat', 'Lng']) {
  if (!(required in (peakRows[0] ?? {}))) throw new Error(`Peaks_NEW is missing required column: ${required}`);
}

const peaksByTrip = new Map();
for (const row of peakRows) {
  const tripId = clean(row['Trip ID']);
  if (!tripId) { warnings.push(`Peak “${clean(row['Peak Name']) || '(unnamed)'}” has no Trip ID`); continue; }
  const peak = {
    name: clean(row['Peak Name']),
    height: clean(row.Height) || null,
    peakbaggerUrl: clean(row['Peakbagger URL']) || null,
    peakbaggerId: clean(row.PID) || null,
    lat: number(row.Lat),
    lng: number(row.Lng),
    coordinateSource: clean(row['Lat Source']) || null,
  };
  if (!peaksByTrip.has(tripId)) peaksByTrip.set(tripId, []);
  peaksByTrip.get(tripId).push(peak);
}

const seen = new Set();
const trips = tripRows.map(row => {
  const id = clean(row['Trip ID']);
  const title = clean(row['Trip Name']);
  if (!id) warnings.push(`Trip “${title || '(unnamed)'}” has no Trip ID`);
  if (seen.has(id)) warnings.push(`Duplicate Trip ID: ${id}`);
  seen.add(id);
  const peaks = peaksByTrip.get(id) ?? [];
  peaksByTrip.delete(id);
  return {
    id,
    title,
    alternateNames: splitList(row['Alt Names']),
    startDate: isoDate(row['Date Start'], warnings, id || title),
    endDate: isoDate(row['Date End'], warnings, id || title),
    startDateDisplay: clean(row['Date Start']) || null,
    endDateDisplay: clean(row['Date End']) || null,
    types: splitList(row['Trip Types']),
    reportUrl: clean(row['TR URL']) || null,
    photosUrl: clean(row['Pics URL']) || null,
    maps: classifyMaps(row),
    location: locationFor(row, peaks),
    peaks,
    notes: clean(row.Notes) || null,
  };
});

for (const [tripId, orphanPeaks] of peaksByTrip) warnings.push(`${orphanPeaks.length} peak(s) reference missing trip ${tripId}`);

trips.sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? '') || a.title.localeCompare(b.title));
const reportUrls = new Set(trips.map(trip => trip.reportUrl).filter(Boolean));
const archive = {
  schemaVersion: 1,
  source: { workbook: 'FCoTM JSON', tripsTab: 'Trips_NEW', peaksTab: 'Peaks_NEW' },
  summary: {
    trips: trips.length,
    articles: reportUrls.size,
    peakOccurrences: trips.reduce((sum, trip) => sum + trip.peaks.length, 0),
    uniquePeaks: new Set(trips.flatMap(trip => trip.peaks.map(peak => peak.peakbaggerId || peak.name))).size,
    mappedTrips: trips.filter(trip => trip.location).length,
    caltopoMaps: trips.filter(trip => trip.maps.caltopo).length,
    staticMapImages: trips.filter(trip => trip.maps.staticImage).length,
  },
  trips,
};

await mkdir('data', { recursive: true });
await writeFile('data/legacy-archive.json', `${JSON.stringify(archive)}\n`);
await writeFile('data/legacy-archive-audit.json', `${JSON.stringify({ warnings }, null, 2)}\n`);

console.log(`Built ${archive.summary.trips} trips, ${archive.summary.uniquePeaks} unique peaks, ${archive.summary.articles} report URLs.`);
console.log(`${archive.summary.mappedTrips} trips mapped; ${archive.summary.caltopoMaps} CalTopo maps; ${warnings.length} audit warnings.`);

