import {
  loadAll, buildUnits, buildCategories, filterUnits, unitVector, partyLabel, NON_VOTERS, OTHERS,
} from './data.js';
import { computeStats } from './transfer.js';
import {
  renderSankey, renderHeatmap, renderPartyBars, renderStackedClusters, renderClusterChange, renderEmpty,
  setColorOrder,
} from './charts.js';

const $ = (id) => document.getElementById(id);
const CLUSTERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const LOW_CONFIDENCE_SHARE = 0.01;
const SECTOR_NAMES = { all: 'כל הישובים', general: 'כללי', haredi: 'חרדי', arab: 'ערבי' };

const state = {
  sector: 'all', level: 'city', maxBzb: 0.15, cutoff: 0.5, eshkol: 'all',
  showAll: false, showNonVoters: true, direction: 'from',
  pickOld: 'מחל', pickNew: 'מחל', pickCluster: 'מחל',
};

let data;
let current;
let requestId = 0;
const unitsCache = new Map();
const charts = {};
const POOL_SIZE = Math.max(1, Math.min(11, (navigator.hardwareConcurrency || 4) - 1));
const pending = new Map();
let jobSeq = 0;
let workers = [];

function resetWorkers() {
  workers.forEach((w) => w.terminate());
  pending.clear();
  workers = Array.from({ length: POOL_SIZE }, () => {
    const w = new Worker(new URL('./transfer-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const cb = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (cb) cb(e.data.results);
    };
    return w;
  });
}
resetWorkers();

/** Solves jobs in parallel across the worker pool. Resolves to null if superseded. */
function solve(jobs, firstWorker = 0) {
  const generation = requestId;
  const chunks = workers.map(() => []);
  jobs.forEach((job, k) => chunks[(k + firstWorker) % POOL_SIZE].push(k));
  return Promise.all(chunks.map((idxs, w) => new Promise((resolve) => {
    if (!idxs.length) { resolve([]); return; }
    const id = ++jobSeq;
    pending.set(id, (results) => resolve(idxs.map((k, n) => [k, results[n]])));
    workers[w].postMessage({ id, jobs: idxs.map((k) => jobs[k]) });
  }))).then((parts) => {
    if (generation !== requestId) return null;
    const out = new Array(jobs.length);
    for (const part of parts) for (const [k, r] of part) out[k] = r;
    return out;
  });
}

function getUnits() {
  const key = `${state.level}|${state.level === 'kalpi' ? state.maxBzb : ''}`;
  if (!unitsCache.has(key)) unitsCache.set(key, buildUnits(data, state.level, state.maxBzb));
  return unitsCache.get(key);
}

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

function fillSelect(sel, cats, labels, wanted) {
  sel.innerHTML = '';
  cats.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = labels[i];
    sel.appendChild(opt);
  });
  sel.value = cats.includes(wanted) ? wanted : cats[0];
  return sel.value;
}

function pairsFor(units, co, cn, mo, mn) {
  return units.map((u) => ({
    x: unitVector(u.old, mo, co.cats.length, co.nonVoterIdx),
    y: unitVector(u.new, mn, cn.cats.length, cn.nonVoterIdx),
  }));
}

function toMatrix(P, K, M) {
  return Array.from({ length: K }, (_, i) => Array.from(P.slice(i * M, (i + 1) * M)));
}

async function recompute() {
  const generation = ++requestId;
  if (pending.size) resetWorkers();
  const { units, coverage } = getUnits();
  const co = buildCategories(data, 'old', state.showAll);
  const cn = buildCategories(data, 'new', state.showAll);
  const mo = co.mapFor(data[state.level].old.parties);
  const mn = cn.mapFor(data[state.level].new.parties);
  const K = co.cats.length;
  const M = cn.cats.length;

  const sectorUnits = filterUnits(units, { sector: state.sector, cutoff: state.cutoff, eshkol: 'all' });
  const selected = state.eshkol === 'all'
    ? sectorUnits
    : sectorUnits.filter((u) => u.eshkol === Number(state.eshkol));

  const mainStats = computeStats(pairsFor(selected, co, cn, mo, mn), K, M);
  const clusterStats = CLUSTERS.map((c) => computeStats(
    pairsFor(sectorUnits.filter((u) => u.eshkol === c), co, cn, mo, mn), K, M,
  ));

  renderCoverage(coverage, selected, sectorUnits);
  renderClusterShares(sectorUnits, co, cn, mo, mn);

  setStatus('מחשב…');
  const mainPromise = solve([mainStats]);
  const clusterPromise = solve(clusterStats, 1);
  const [P] = (await mainPromise) || [];
  if (!P || generation !== requestId) return;
  current = { co, cn, K, M, mainStats, clusterStats, P, clusterP: null };
  renderTransfers();
  const clusterP = await clusterPromise;
  if (!clusterP || generation !== requestId) return;
  current.clusterP = clusterP;
  renderClusterTransfer();
  setStatus('');
}

function renderCoverage(coverage, selected, sectorUnits) {
  const levelName = state.level === 'city' ? 'ישובים' : 'קלפיות';
  const bzb = selected.reduce((a, u) => a + u.old.bzb, 0);
  const parts = [
    `${coverage.matched.toLocaleString('he-IL')} ${levelName} הותאמו בין הבחירות`,
    `(${(coverage.bzbShare * 100).toFixed(0)}% מבעלי זכות הבחירה)`,
    `· בסינון הנוכחי (${SECTOR_NAMES[state.sector]}${state.eshkol !== 'all' ? `, אשכול ${state.eshkol}` : ''}):`,
    `${selected.length.toLocaleString('he-IL')} ${levelName}, ${Math.round(bzb).toLocaleString('he-IL')} בעלי זכות בחירה`,
  ];
  if (state.level === 'kalpi') parts.push('· קלפיות הותאמו לפי סמל ישוב ומספר קלפי');
  $('coverage').textContent = parts.join(' ');

  const total = sectorUnits.reduce((a, u) => a + u.old.bzb, 0) || 1;
  const known = sectorUnits.filter((u) => u.eshkol).reduce((a, u) => a + u.old.bzb, 0);
  $('eshkolCoverage').textContent = `ל-${(known / total * 100).toFixed(0)}% מבעלי זכות הבחירה בסינון יש אשכול ידוע (ישובים במועצות אזוריות אינם מדורגים בקובץ האשכולות). מסנן האשכול העליון אינו חל על גרפים אלה.`;
}

function labelsFor(year, cats) {
  return cats.map((c) => partyLabel(data, year, c));
}

function renderTransfers() {
  const { co, cn, K, M, mainStats, P } = current;
  const oldLabels = labelsFor('old', co.cats);
  const newLabels = labelsFor('new', cn.cats);
  const oldTotals = Array.from(mainStats.oldTotals);
  const newTotals = Array.from(mainStats.newTotals);
  const totalOld = oldTotals.reduce((a, b) => a + b, 0);

  if (mainStats.units === 0 || totalOld === 0) {
    for (const k of ['sankey', 'heatmap', 'partyFrom', 'partyTo']) renderEmpty(charts[k], 'אין נתונים בסינון הנוכחי');
    return;
  }

  const lowConf = oldTotals.map((v) => v / totalOld < LOW_CONFIDENCE_SHARE);
  const oldLabelsMarked = oldLabels.map((l, i) => (lowConf[i] ? `${l} *` : l));
  const rows = toMatrix(P, K, M);
  const flows = rows.map((row, i) => row.map((p) => p * oldTotals[i]));
  const inflow = Array.from({ length: M }, (_, j) => flows.reduce((a, r) => a + r[j], 0));

  renderSankey(charts.sankey, {
    oldCats: co.cats, newCats: cn.cats, oldLabels: oldLabelsMarked, newLabels, flows,
    showNonVoters: state.showNonVoters, nonVoter: NON_VOTERS,
  });

  const matrix = state.direction === 'from'
    ? rows
    : flows.map((r) => r.map((v, j) => (inflow[j] > 0 ? v / inflow[j] : 0)));
  const heatmapHeight = `${Math.max(620, K * 32 + 110)}px`;
  if ($('heatmap').style.height !== heatmapHeight) {
    $('heatmap').style.height = heatmapHeight;
    charts.heatmap.resize();
  }
  renderHeatmap(charts.heatmap, {
    rowLabels: oldLabelsMarked, colLabels: newLabels, matrix,
    rowTotals: oldTotals, colTotals: newTotals, direction: state.direction,
  });

  state.pickOld = fillSelect($('pickOld'), co.cats, oldLabelsMarked, state.pickOld);
  state.pickNew = fillSelect($('pickNew'), cn.cats, newLabels, state.pickNew);
  const i = co.cats.indexOf(state.pickOld);
  renderPartyBars(charts.partyFrom, {
    labels: newLabels, cats: cn.cats, values: rows[i], totals: flows[i],
    title: `מצביעי ${oldLabels[i]} (≈${Math.round(oldTotals[i]).toLocaleString('he-IL')})`,
  });
  const j = cn.cats.indexOf(state.pickNew);
  const fromValues = flows.map((r) => (inflow[j] > 0 ? r[j] / inflow[j] : 0));
  renderPartyBars(charts.partyTo, {
    labels: oldLabels, cats: co.cats, values: fromValues, totals: flows.map((r) => r[j]),
    title: `מצביעי ${newLabels[j]} (≈${Math.round(inflow[j]).toLocaleString('he-IL')})`,
  });

  renderClusterTransfer();
}

function renderClusterTransfer() {
  const { co, cn, M, clusterStats, clusterP } = current;
  const oldLabels = labelsFor('old', co.cats);
  state.pickCluster = fillSelect($('pickCluster'), co.cats, oldLabels, state.pickCluster);
  if (!clusterP) {
    renderEmpty(charts.clusterTransfer, 'מחשב…');
    return;
  }
  const i = co.cats.indexOf(state.pickCluster);
  const partyVoters = clusterStats.map((s) => s.oldTotals[i]);
  const active = CLUSTERS.map((_, c) => clusterStats[c].units > 0 && partyVoters[c] > 0);
  if (!active.some(Boolean)) {
    renderEmpty(charts.clusterTransfer, 'אין נתונים');
    return;
  }
  const series = cn.cats.map((cat, j) => ({
    name: partyLabel(data, 'new', cat),
    letter: cat,
    data: CLUSTERS.map((_, c) => (active[c] ? clusterP[c][i * M + j] : null)),
  })).filter((s) => s.data.some((v) => v > 0.005));
  renderStackedClusters(charts.clusterTransfer, {
    clusters: CLUSTERS, series,
    tooltipExtra: (c) => `≈${Math.round(partyVoters[c] || 0).toLocaleString('he-IL')} מצביעי ${oldLabels[i]}`,
  });
}

function clusterShares(units, side, cats, map) {
  // Share of valid votes per category (non-voters excluded) in each cluster.
  const nonVoterIdx = cats.length - 1;
  const totals = CLUSTERS.map(() => new Float64Array(cats.length));
  for (const u of units) {
    if (!u.eshkol) continue;
    const v = unitVector(u[side], map, cats.length, nonVoterIdx);
    v.forEach((x, k) => { totals[u.eshkol - 1][k] += x; });
  }
  return totals.map((t) => {
    const valid = t.reduce((a, b, k) => (k === nonVoterIdx ? a : a + b), 0);
    return Array.from(t, (x, k) => (k === nonVoterIdx || !valid ? null : x / valid));
  });
}

function renderClusterShares(units, co, cn, mo, mn) {
  const oldShares = clusterShares(units, 'old', co.cats, mo);
  const newShares = clusterShares(units, 'new', cn.cats, mn);
  const toSeries = (year, cats, shares) => cats.slice(0, -1).map((cat, k) => ({
    name: partyLabel(data, year, cat), letter: cat, data: shares.map((s) => s[k]),
  }));
  if (!units.some((u) => u.eshkol)) {
    for (const k of ['clusterOld', 'clusterNew', 'clusterChange']) renderEmpty(charts[k], 'אין נתונים');
    return;
  }
  renderStackedClusters(charts.clusterOld, { clusters: CLUSTERS, series: toSeries('old', co.cats, oldShares) });
  renderStackedClusters(charts.clusterNew, { clusters: CLUSTERS, series: toSeries('new', cn.cats, newShares) });

  const common = co.cats.filter((c) => c !== NON_VOTERS && c !== OTHERS && cn.cats.includes(c));
  const series = common.map((cat) => {
    const ko = co.cats.indexOf(cat);
    const kn = cn.cats.indexOf(cat);
    return {
      name: partyLabel(data, 'new', cat),
      letter: cat,
      data: CLUSTERS.map((_, c) => (oldShares[c][ko] == null || newShares[c][kn] == null
        ? null : newShares[c][kn] - oldShares[c][ko])),
    };
  });
  if (series.length) renderClusterChange(charts.clusterChange, { clusters: CLUSTERS, series });
  else renderEmpty(charts.clusterChange, 'אין מפלגות משותפות');
}

function bindControls() {
  $('sectorTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.sector = btn.dataset.sector;
    document.querySelectorAll('#sectorTabs button').forEach((b) => b.classList.toggle('active', b === btn));
    recompute();
  });

  const showRangeValues = () => {
    $('bzbVal').textContent = `${Math.round(state.maxBzb * 100)}%`;
    $('cutoffVal').textContent = `${Math.round(state.cutoff * 100)}%`;
    $('bzbWrap').hidden = state.level !== 'kalpi';
  };
  const on = (id, event, fn) => $(id).addEventListener(event, fn);

  on('level', 'change', (e) => { state.level = e.target.value; showRangeValues(); recompute(); });
  on('maxBzb', 'input', (e) => { state.maxBzb = Number(e.target.value); showRangeValues(); });
  on('maxBzb', 'change', recompute);
  on('cutoff', 'input', (e) => { state.cutoff = Number(e.target.value); showRangeValues(); });
  on('cutoff', 'change', recompute);
  on('eshkol', 'change', (e) => { state.eshkol = e.target.value; recompute(); });
  on('showAll', 'change', (e) => { state.showAll = e.target.checked; recompute(); });
  on('showNonVoters', 'change', (e) => { state.showNonVoters = e.target.checked; renderTransfers(); });
  on('direction', 'change', (e) => { state.direction = e.target.value; renderTransfers(); });
  on('pickOld', 'change', (e) => { state.pickOld = e.target.value; renderTransfers(); });
  on('pickNew', 'change', (e) => { state.pickNew = e.target.value; renderTransfers(); });
  on('pickCluster', 'change', (e) => { state.pickCluster = e.target.value; renderClusterTransfer(); });
  showRangeValues();
}

async function main() {
  for (const id of ['sankey', 'heatmap', 'partyFrom', 'partyTo', 'clusterOld', 'clusterNew', 'clusterChange', 'clusterTransfer']) {
    charts[id] = echarts.init($(id));
  }
  window.addEventListener('resize', () => Object.values(charts).forEach((c) => c.resize()));

  const eshkolSel = $('eshkol');
  for (const c of CLUSTERS) eshkolSel.add(new Option(`אשכול ${c}`, String(c)));

  try {
    data = await loadAll();
  } catch (err) {
    setStatus(`שגיאה בטעינת הנתונים: ${err.message}. יש להריץ דרך start.sh (שרת מקומי).`, true);
    return;
  }
  const maxShare = {};
  for (const year of ['old', 'new']) {
    for (const [p, s] of Object.entries(data.shares[year])) maxShare[p] = Math.max(maxShare[p] || 0, s);
  }
  setColorOrder(Object.keys(maxShare).sort((a, b) => maxShare[b] - maxShare[a]));
  bindControls();
  await recompute();
}

main();
