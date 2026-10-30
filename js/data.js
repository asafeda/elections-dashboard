export const FILES = {
  cityOld: 'by_city_old.csv',
  cityNew: 'by_city.csv',
  kalpiOld: 'by_kalpi_old.csv',
  kalpiNew: 'by_kalpi.csv',
  eshkol: 'eshkol.csv',
  parties: 'parties.csv',
};

const META_COLUMNS = new Set([
  'סמל ועדה', 'ברזל', 'שם ישוב', 'סמל ישוב', 'קלפי', 'ריכוז', 'שופט',
  'בזב', 'מצביעים', 'פסולים', 'כשרים', 'חיצוניות', 'קלפי אחרת',
]);

export const THRESHOLD = 0.0325;
export const OTHERS = 'אחרים';
export const NON_VOTERS = 'לא הצביעו / פסול';

function fetchCsv(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(`${url}?t=${Date.now()}`, {
      download: true,
      skipEmptyLines: true,
      complete: (res) => resolve(res.data),
      error: (err) => reject(new Error(`${url}: ${err.message || err}`)),
    });
  });
}

function stripBom(s) {
  return s.replace(/^\uFEFF/, '').trim();
}

/** Must stay in sync with normalize() in scripts/extract_eshkol.py. */
export function normalizeName(name) {
  return (name || '').replace(/[^\u05d0-\u05ea]/g, '').replaceAll('יי', 'י').replaceAll('וו', 'ו');
}

function parseElection(rows) {
  const header = rows[0].map(stripBom);
  const col = (name) => header.indexOf(name);
  const parties = [];
  const partyIdx = [];
  header.forEach((h, i) => {
    if (h && !META_COLUMNS.has(h)) {
      parties.push(h);
      partyIdx.push(i);
    }
  });
  const ci = {
    cityName: col('שם ישוב'), cityCode: col('סמל ישוב'), kalpi: col('קלפי'),
    bzb: col('בזב'), voters: col('מצביעים'), valid: col('כשרים'),
  };
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < header.length - 1) continue;
    const votes = new Float64Array(parties.length);
    partyIdx.forEach((c, k) => { votes[k] = num(row[c]); });
    records.push({
      cityName: (row[ci.cityName] || '').trim(),
      cityCode: (row[ci.cityCode] || '').trim(),
      kalpi: ci.kalpi >= 0 ? String(row[ci.kalpi]).trim() : null,
      bzb: num(row[ci.bzb]),
      voters: num(row[ci.voters]),
      valid: num(row[ci.valid]),
      votes,
    });
  }
  return { parties, records };
}

function nationalShares(election) {
  const totals = new Float64Array(election.parties.length);
  let valid = 0;
  for (const rec of election.records) {
    rec.votes.forEach((v, k) => { totals[k] += v; });
    valid += rec.valid;
  }
  const sum = valid || totals.reduce((a, b) => a + b, 0);
  const shares = {};
  election.parties.forEach((p, k) => { shares[p] = totals[k] / sum; });
  return shares;
}

function parsePartiesConfig(rows) {
  const header = rows[0].map(stripBom);
  const idx = (n) => header.indexOf(n);
  const cfg = { old: {}, new: {} };
  for (const row of rows.slice(1)) {
    const year = (row[idx('year')] || '').trim();
    const letter = (row[idx('letter')] || '').trim();
    if (!cfg[year] || !letter) continue;
    cfg[year][letter] = {
      name: (row[idx('display_name')] || '').trim() || letter,
      sector: (row[idx('sector')] || '').trim(),
    };
  }
  return cfg;
}

function parseEshkol(rows) {
  const header = rows[0].map(stripBom);
  const [iName, iEshkol, iAlias] = ['name', 'eshkol', 'alias'].map((n) => header.indexOf(n));
  const map = new Map();
  for (const row of rows.slice(1)) {
    const eshkol = Number(row[iEshkol]);
    if (!eshkol) continue;
    for (const n of [row[iName], iAlias >= 0 ? row[iAlias] : '']) {
      const key = normalizeName(n);
      if (key) map.set(key, eshkol);
    }
  }
  return map;
}

export async function loadAll() {
  const keys = Object.keys(FILES);
  const raw = await Promise.all(keys.map((k) => fetchCsv(FILES[k])));
  const d = Object.fromEntries(keys.map((k, i) => [k, raw[i]]));

  const cityOld = parseElection(d.cityOld);
  const cityNew = parseElection(d.cityNew);
  const kalpiOld = parseElection(d.kalpiOld);
  const kalpiNew = parseElection(d.kalpiNew);
  const partiesCfg = parsePartiesConfig(d.parties);
  const eshkolByName = parseEshkol(d.eshkol);

  // City code -> eshkol, trying both years' spellings of the name.
  const eshkolByCity = new Map();
  for (const rec of [...cityOld.records, ...cityNew.records]) {
    if (eshkolByCity.has(rec.cityCode)) continue;
    const e = eshkolByName.get(normalizeName(rec.cityName));
    if (e) eshkolByCity.set(rec.cityCode, e);
  }

  return {
    city: { old: cityOld, new: cityNew },
    kalpi: { old: kalpiOld, new: kalpiNew },
    shares: { old: nationalShares(cityOld), new: nationalShares(cityNew) },
    partiesCfg,
    eshkolByCity,
  };
}

export function partyLabel(data, year, letter) {
  if (letter === OTHERS || letter === NON_VOTERS) return letter;
  const name = data.partiesCfg[year][letter]?.name;
  return name && name !== letter ? `${name} (${letter})` : letter;
}

/**
 * Category list per year: parties shown individually, then OTHERS (if any were
 * merged), then NON_VOTERS. `map[k]` gives the category index for party column k.
 */
export function buildCategories(data, year, showAll) {
  const { parties } = data.city[year];
  const shares = data.shares[year];
  const kept = parties
    .filter((p) => (showAll ? shares[p] > 0 : shares[p] >= THRESHOLD))
    .sort((a, b) => shares[b] - shares[a]);
  const hasOthers = kept.length < parties.length;
  const cats = [...kept, ...(hasOthers ? [OTHERS] : []), NON_VOTERS];
  const catIndex = new Map(cats.map((c, i) => [c, i]));
  const mapFor = (partyList) => partyList.map((p) => catIndex.get(p) ?? catIndex.get(OTHERS) ?? -1);
  return { cats, mapFor, nonVoterIdx: cats.length - 1 };
}

function aggregate(records, keyFn) {
  const m = new Map();
  for (const rec of records) {
    if (rec.bzb <= 0) continue;
    const key = keyFn(rec);
    const cur = m.get(key);
    if (!cur) {
      m.set(key, { ...rec, votes: Float64Array.from(rec.votes) });
    } else {
      cur.bzb += rec.bzb; cur.voters += rec.voters; cur.valid += rec.valid;
      rec.votes.forEach((v, k) => { cur.votes[k] += v; });
    }
  }
  return m;
}

function sectorLetters(data, year, sector) {
  return Object.entries(data.partiesCfg[year]).filter(([, v]) => v.sector === sector).map(([k]) => k);
}

/**
 * Pairs old/new records into units. Kalpi mode matches by (city code, kalpi
 * number) and drops pairs whose registered voters changed by more than
 * `maxBzbChange` (fraction).
 */
export function buildUnits(data, level, maxBzbChange) {
  const src = data[level];
  const keyFn = level === 'city' ? (r) => r.cityCode : (r) => `${r.cityCode}|${r.kalpi}`;
  const oldMap = aggregate(src.old.records, keyFn);
  const newMap = aggregate(src.new.records, keyFn);

  const sectorIdx = {};
  for (const s of ['haredi', 'arab']) {
    const letters = new Set(sectorLetters(data, 'old', s));
    sectorIdx[s] = src.old.parties.map((p, k) => (letters.has(p) ? k : -1)).filter((k) => k >= 0);
  }

  const units = [];
  let oldBzbTotal = 0;
  let matchedBzb = 0;
  for (const [key, o] of oldMap) {
    oldBzbTotal += o.bzb;
    const n = newMap.get(key);
    if (!n) continue;
    if (level === 'kalpi' && Math.abs(n.bzb - o.bzb) / o.bzb > maxBzbChange) continue;
    matchedBzb += o.bzb;
    const sectorShare = {};
    for (const s of Object.keys(sectorIdx)) {
      const v = sectorIdx[s].reduce((a, k) => a + o.votes[k], 0);
      sectorShare[s] = o.valid > 0 ? v / o.valid : 0;
    }
    units.push({
      key,
      name: o.cityName,
      kalpi: level === 'kalpi' ? o.kalpi : null,
      cityCode: o.cityCode,
      eshkol: data.eshkolByCity.get(o.cityCode) || null,
      old: o,
      new: n,
      sectorShare,
    });
  }
  return {
    units,
    coverage: {
      matched: units.length,
      oldUnits: oldMap.size,
      newUnits: newMap.size,
      bzbShare: oldBzbTotal ? matchedBzb / oldBzbTotal : 0,
    },
  };
}

export function unitSector(unit, cutoff) {
  if (unit.sectorShare.haredi >= cutoff) return 'haredi';
  if (unit.sectorShare.arab >= cutoff) return 'arab';
  return 'general';
}

export function filterUnits(units, { sector, cutoff, eshkol }) {
  return units.filter((u) => {
    if (sector !== 'all' && unitSector(u, cutoff) !== sector) return false;
    if (eshkol !== 'all' && u.eshkol !== Number(eshkol)) return false;
    return true;
  });
}

/** Category vectors (absolute counts, including non-voters) for one side of a unit. */
export function unitVector(rec, map, nCats, nonVoterIdx) {
  const v = new Float64Array(nCats);
  rec.votes.forEach((x, k) => {
    if (map[k] >= 0) v[map[k]] += x;
  });
  v[nonVoterIdx] += Math.max(0, rec.bzb - rec.valid);
  return v;
}
