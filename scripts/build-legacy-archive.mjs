import { mkdir, readFile, writeFile } from 'node:fs/promises';

const SHEET = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vR4VTs94z-gknDfCKTYgZk7Xdc6EruKB_ajYxHoJHIUfKybTLf4slcPz7HI2CbCtg1qPS9aPTppr8uE/pub';
const SOURCES = {
  trips: `${SHEET}?output=csv&gid=244642622`,
  peaks: `${SHEET}?output=csv&gid=470214005`,
  original: `${SHEET}?output=csv&gid=1376667324`,
};

const clean = value => String(value ?? '').trim();
const splitList = value => clean(value).split(/\s*(?:\||,)\s*/).filter(Boolean);
const unique = values => [...new Set(values.filter(Boolean))];
const normalizedUrl = value => {
  try {
    const url = new URL(clean(value));
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return clean(value);
  }
};
const REPORT_BASE = 'https://github.com/MattOnAMtn/MasochistAdventureMap/blob/agent/adventure-map-fullscreen-layers/';
const POLICY_PATH = 'config/legacy-archive-policy.json';

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

function classifyMaps(row, recoveredUrls = []) {
  const urls = unique([
    ...splitList(row['Map URL']),
    ...clean(row['All Map URLs']).split(/\s*\|\s*/).filter(Boolean),
    ...recoveredUrls,
  ]).filter(url => /^https?:\/\//i.test(url));
  const host = url => {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
    catch { return ''; }
  };
  return {
    caltopo: urls.find(url => host(url) === 'caltopo.com') ?? null,
    staticImage: urls.find(url => host(url) === 'flickr.com') ?? null,
    other: urls.filter(url => !['caltopo.com', 'flickr.com'].includes(host(url))),
  };
}

const normalizedTitle = value => clean(value).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
const tripKey = (date, title) => `${clean(date)}|${normalizedTitle(title)}`;

function urlsIn(row) {
  return unique(Object.values(row).flatMap(value => clean(value).match(/https?:\/\/[^\s|,]+/gi) ?? []));
}

function groupOriginalTrips(rows) {
  const groups = [];
  let current = null;
  for (const row of rows) {
    if (clean(row['Date Start'])) {
      current = { start: row, rows: [row] };
      groups.push(current);
    } else if (current) current.rows.push(row);
  }
  return groups;
}

function recoveredMedia(group) {
  if (!group) return { maps: [], photos: null, report: null, videos: [] };
  const allUrls = unique(group.rows.flatMap(urlsIn));
  const hosts = url => {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
    catch { return ''; }
  };
  const explicitMaps = unique(group.rows.flatMap(row => splitList(row.Map)));
  const maps = unique([
    ...explicitMaps,
    ...allUrls.filter(url => ['caltopo.com', 'flickr.com'].includes(hosts(url)) && group.rows.some(row => clean(row.Map).includes(url))),
  ]);
  return {
    maps,
    photos: group.rows.map(row => clean(row.Pics)).find(Boolean) ?? null,
    report: group.rows.map(row => clean(row.TR)).find(Boolean) ?? null,
    videos: allUrls.filter(url => ['youtube.com', 'youtu.be'].includes(hosts(url))),
  };
}

function driveFileId(url) {
  const value = clean(url);
  if (value.includes('/d/')) return value.split('/d/')[1]?.split('/')[0] || null;
  if (value.includes('id=')) return value.split('id=')[1]?.split('&')[0] || null;
  return null;
}

function reportDates(title) {
  const bracket = clean(title).match(/^\[([^\]]+)\]/)?.[1] || '';
  const parts = bracket.split(/\s+to\s+/i);
  const expand = (value, end = false) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    if (/^\d{4}-\d{2}$/.test(value)) {
      if (!end) return `${value}-01`;
      const [year, month] = value.split('-').map(Number);
      return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    }
    return null;
  };
  return { start: expand(parts[0]), end: expand(parts[1] || parts[0], true) };
}

function reportTitle(title) {
  return clean(title).replace(/^\[[^\]]+\]\s*[-–—]\s*/, '').replace(/\.pdf$/i, '');
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

const policy = JSON.parse(await readFile(POLICY_PATH, 'utf8'));
const excludedReportUrls = new Set((policy.excludeReportUrls ?? []).map(normalizedUrl));
const locationOverrides = policy.locationOverrides ?? {};
const mapLocationDefaults = new Map(Object.entries(policy.mapLocationDefaults ?? {}).map(([url, location]) => [normalizedUrl(url), location]));
const titleLocationRules = (policy.titleLocationRules ?? []).map(rule => ({ ...rule, expression: new RegExp(rule.titlePattern, 'i') }));
const applyLocationOverride = trip => {
  const idLocation = locationOverrides[trip.id];
  if (idLocation) return { ...trip, location: { ...idLocation } };
  const mapUrl = normalizedUrl(trip.maps?.caltopo);
  const titleRule = titleLocationRules.find(rule => normalizedUrl(rule.mapUrl) === mapUrl && rule.expression.test(trip.title));
  if (titleRule) return { ...trip, location: { lat: titleRule.lat, lng: titleRule.lng, source: titleRule.source } };
  const mapDefault = mapLocationDefaults.get(mapUrl);
  return mapDefault ? { ...trip, location: { ...mapDefault } } : trip;
};

const [tripCsv, peakCsv, originalCsv] = await Promise.all(Object.values(SOURCES).map(fetchCsv));
const tripRows = records(tripCsv);
const peakRows = records(peakCsv);
const originalGroups = groupOriginalTrips(records(originalCsv));
const legacyReports = JSON.parse(await readFile('data/legacy-reports-manifest.json', 'utf8'));
const reportsByDriveId = new Map(legacyReports.map(report => [report.driveId, report]));
const linkedReportIds = new Set();
const warnings = [];

const originalsByKey = new Map();
for (const group of originalGroups) {
  const key = tripKey(group.start['Date Start'], group.start['Trip Name']);
  if (!originalsByKey.has(key)) originalsByKey.set(key, []);
  originalsByKey.get(key).push(group);
}

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
let trips = tripRows.map(row => {
  const id = clean(row['Trip ID']);
  const title = clean(row['Trip Name']);
  if (!id) warnings.push(`Trip “${title || '(unnamed)'}” has no Trip ID`);
  if (seen.has(id)) warnings.push(`Duplicate Trip ID: ${id}`);
  seen.add(id);
  const peaks = peaksByTrip.get(id) ?? [];
  peaksByTrip.delete(id);
  const matches = originalsByKey.get(tripKey(row['Date Start'], title)) ?? [];
  if (matches.length > 1) warnings.push(`${id || title}: multiple original trip groups matched`);
  const recovered = recoveredMedia(matches[0]);
  const sourceReportUrl = clean(row['TR URL']) || recovered.report;
  const archivedReport = reportsByDriveId.get(driveFileId(sourceReportUrl));
  if (archivedReport) linkedReportIds.add(archivedReport.driveId);
  return applyLocationOverride({
    id,
    title,
    alternateNames: splitList(row['Alt Names']),
    startDate: isoDate(row['Date Start'], warnings, id || title),
    endDate: isoDate(row['Date End'], warnings, id || title),
    startDateDisplay: clean(row['Date Start']) || null,
    endDateDisplay: clean(row['Date End']) || null,
    types: splitList(row['Trip Types']),
    reportUrl: archivedReport ? `${REPORT_BASE}${archivedReport.path}` : sourceReportUrl || null,
    photosUrl: clean(row['Pics URL']) || recovered.photos,
    videos: recovered.videos,
    maps: classifyMaps(row, recovered.maps),
    location: locationFor(row, peaks),
    peaks,
    notes: clean(row.Notes) || null,
  });
});

const standaloneReportTitles = new Set();
for (const report of legacyReports) {
  if (linkedReportIds.has(report.driveId)) continue;
  const dates = reportDates(report.title);
  const title = reportTitle(report.title);
  const titleKey = normalizedTitle(title);
  if (standaloneReportTitles.has(titleKey)) continue;
  standaloneReportTitles.add(titleKey);
  trips.push(applyLocationOverride({
    id: `legacy-report-${report.path.split('/').pop().replace(/\.pdf$/i, '')}`,
    title,
    alternateNames: [],
    startDate: dates.start,
    endDate: dates.end,
    startDateDisplay: dates.start,
    endDateDisplay: dates.end === dates.start ? null : dates.end,
    types: ['Legacy Report'],
    reportUrl: `${REPORT_BASE}${report.path}`,
    photosUrl: null,
    videos: [],
    maps: { caltopo: null, staticImage: null, other: [] },
    location: null,
    peaks: [],
    notes: 'Preserved legacy PDF report',
  }));
}

for (const [tripId, orphanPeaks] of peaksByTrip) warnings.push(`${orphanPeaks.length} peak(s) reference missing trip ${tripId}`);

const excludedTrips = trips.filter(trip => excludedReportUrls.has(normalizedUrl(trip.reportUrl)));
trips = trips.filter(trip => !excludedReportUrls.has(normalizedUrl(trip.reportUrl)));
for (const trip of excludedTrips) warnings.push(`${trip.id || trip.title}: excluded because its report belongs in Guides & Articles`);

trips.sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? '') || a.title.localeCompare(b.title));
const reportUrls = new Set(trips.map(trip => trip.reportUrl).filter(Boolean));
const archive = {
  schemaVersion: 1,
  source: { workbook: 'FCoTM JSON', tripsTab: 'Trips_NEW', peaksTab: 'Peaks_NEW', enrichmentTab: 'FCoTM Trip Index' },
  summary: {
    trips: trips.length,
    articles: reportUrls.size,
    peakOccurrences: trips.reduce((sum, trip) => sum + trip.peaks.length, 0),
    uniquePeaks: new Set(trips.flatMap(trip => trip.peaks.map(peak => peak.peakbaggerId || peak.name))).size,
    mappedTrips: trips.filter(trip => trip.location).length,
    caltopoMaps: trips.filter(trip => trip.maps.caltopo).length,
    staticMapImages: trips.filter(trip => trip.maps.staticImage).length,
    legacyPdfReports: legacyReports.length,
    excludedGuideArticles: excludedTrips.length,
  },
  trips,
};

await mkdir('data', { recursive: true });
await writeFile('data/legacy-archive.json', `${JSON.stringify(archive)}\n`);
await writeFile('data/legacy-archive-audit.json', `${JSON.stringify({ excludedTrips, warnings }, null, 2)}\n`);

console.log(`Built ${archive.summary.trips} trips, ${archive.summary.uniquePeaks} unique peaks, ${archive.summary.articles} report URLs.`);
console.log(`${archive.summary.mappedTrips} trips mapped; ${archive.summary.caltopoMaps} CalTopo maps; ${warnings.length} audit warnings.`);
console.log(`${archive.summary.excludedGuideArticles} Guides & Articles duplicates excluded.`);
