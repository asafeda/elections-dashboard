const PALETTE = [
  '#1f5fbf', '#e8a20c', '#2e9d5b', '#c23b3b', '#7b4fc4', '#13a3b5', '#d4609e',
  '#6b8e23', '#b5651d', '#3d5a80', '#ef6f3c', '#4caf8e', '#9c27b0', '#8d6e63',
  '#00897b', '#5c6bc0', '#c0ca33', '#f06292', '#455a64', '#ffb300',
];
const FIXED = { 'אחרים': '#a0a4ab', 'לא הצביעו / פסול': '#d9dce1' };
const assigned = new Map();

/** Assign palette colors in order of importance so the biggest parties never collide. */
export function setColorOrder(letters) {
  assigned.clear();
  letters.forEach((l, i) => assigned.set(l, PALETTE[i % PALETTE.length]));
}

export function colorFor(letter) {
  if (FIXED[letter]) return FIXED[letter];
  if (!assigned.has(letter)) assigned.set(letter, PALETTE[assigned.size % PALETTE.length]);
  return assigned.get(letter);
}

const fmt = (n) => Math.round(n).toLocaleString('he-IL');
const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
const BASE = { textStyle: { fontFamily: 'Arial, sans-serif' }, animation: false };

export function renderSankey(chart, { oldCats, newCats, oldLabels, newLabels, flows, showNonVoters, nonVoter }) {
  const total = flows.reduce((a, row) => a + row.reduce((x, y) => x + y, 0), 0) || 1;
  const keepOld = oldCats.map((c) => showNonVoters || c !== nonVoter);
  const keepNew = newCats.map((c) => showNonVoters || c !== nonVoter);
  const oldName = (i) => `${oldLabels[i]} · קודמות`;
  const newName = (j) => `${newLabels[j]} · נוכחיות`;
  const links = [];
  flows.forEach((row, i) => row.forEach((v, j) => {
    if (keepOld[i] && keepNew[j] && v / total >= 0.001) {
      links.push({ source: oldName(i), target: newName(j), value: v });
    }
  }));
  const used = new Set(links.flatMap((l) => [l.source, l.target]));
  const nodes = [
    ...oldCats.map((c, i) => ({ name: oldName(i), itemStyle: { color: colorFor(c) }, depth: 0 })),
    ...newCats.map((c, j) => ({ name: newName(j), itemStyle: { color: colorFor(c) }, depth: 1 })),
  ].filter((n) => used.has(n.name));

  chart.setOption({
    ...BASE,
    tooltip: {
      formatter: (p) => (p.dataType === 'edge'
        ? `${p.data.source} ← ${p.data.target}<br>${fmt(p.data.value)} מצביעים`
        : `${p.name}<br>${fmt(p.value)}`),
    },
    series: [{
      type: 'sankey',
      data: nodes,
      links,
      nodeAlign: 'justify',
      layoutIterations: 0,
      nodeGap: 6,
      left: 160,
      right: 160,
      emphasis: { focus: 'adjacency' },
      lineStyle: { color: 'gradient', opacity: 0.35 },
      label: { fontSize: 12 },
      levels: [
        { depth: 0, label: { position: 'left' } },
        { depth: 1, label: { position: 'right' } },
      ],
    }],
  }, true);
}

export function renderHeatmap(chart, { rowLabels, colLabels, matrix, rowTotals, colTotals, direction }) {
  const data = [];
  matrix.forEach((row, i) => row.forEach((v, j) => data.push([j, i, +(v * 100).toFixed(1)])));
  const crowded = colLabels.length > 16;
  const colAxisLabel = (v) => (crowded ? (v.match(/\(([^)]+)\)$/)?.[1] ?? v) : v.replace(' (', '\n('));
  chart.setOption({
    ...BASE,
    tooltip: {
      formatter: (p) => {
        const [j, i, v] = p.data;
        return direction === 'from'
          ? `מתוך מצביעי ${rowLabels[i]} (≈${fmt(rowTotals[i])})<br>${v}% הצביעו ${colLabels[j]}`
          : `מתוך מצביעי ${colLabels[j]} (≈${fmt(colTotals[j])})<br>${v}% הגיעו מ${rowLabels[i]}`;
      },
    },
    grid: { left: 40, right: 170, top: 70, bottom: 20 },
    xAxis: {
      type: 'category', data: colLabels, position: 'top',
      axisLabel: { interval: 0, fontSize: 11, formatter: colAxisLabel },
      splitArea: { show: true },
      name: 'בחירות נוכחיות', nameLocation: 'middle', nameGap: 45,
    },
    yAxis: {
      type: 'category', data: rowLabels, inverse: true, position: 'right',
      axisLabel: { interval: 0, fontSize: 11 }, splitArea: { show: true },
    },
    visualMap: { min: 0, max: 100, show: false, inRange: { color: ['#ffffff', '#cfe0fb', '#1f5fbf'] } },
    series: [{
      type: 'heatmap', data,
      label: { show: true, fontSize: 10, formatter: (p) => (p.data[2] >= 0.5 ? Math.round(p.data[2]) : '') },
    }],
  }, true);
}

export function renderPartyBars(chart, { labels, cats, values, totals, title }) {
  const order = values.map((v, i) => i).filter((i) => values[i] >= 0.005).sort((a, b) => values[b] - values[a]);
  chart.setOption({
    ...BASE,
    title: { text: title, left: 'center', textStyle: { fontSize: 13 } },
    tooltip: { formatter: (p) => `${p.name}<br>${pct(p.value)} (≈${fmt(totals[order[p.dataIndex]])})` },
    grid: { left: 60, right: 170, top: 40, bottom: 20 },
    xAxis: { type: 'value', max: (m) => Math.min(1, m.max * 1.1), axisLabel: { formatter: (v) => pct(v, 0) } },
    yAxis: { type: 'category', data: order.map((i) => labels[i]), inverse: true, position: 'right', axisLabel: { fontSize: 11 } },
    series: [{
      type: 'bar',
      data: order.map((i) => ({ value: values[i], itemStyle: { color: colorFor(cats[i]) } })),
      label: { show: true, position: 'left', formatter: (p) => pct(p.value) },
    }],
  }, true);
}

/** series: [{ name, letter, data: [share per cluster] }] */
export function renderStackedClusters(chart, { clusters, series, yLabel, tooltipExtra }) {
  chart.setOption({
    ...BASE,
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (items) => {
        const head = `אשכול ${items[0].axisValue}${tooltipExtra ? ` · ${tooltipExtra(items[0].dataIndex)}` : ''}`;
        const lines = items.filter((it) => it.value > 0.003).sort((a, b) => b.value - a.value)
          .map((it) => `${it.marker}${it.seriesName}: ${pct(it.value)}`);
        return [head, ...lines].join('<br>');
      },
    },
    legend: { type: 'scroll', bottom: 0, textStyle: { fontSize: 11 } },
    grid: { left: 50, right: 20, top: 20, bottom: 60 },
    xAxis: { type: 'category', data: clusters, name: yLabel || 'אשכול', nameLocation: 'middle', nameGap: 25 },
    yAxis: { type: 'value', max: 1, axisLabel: { formatter: (v) => pct(v, 0) } },
    series: series.map((s) => ({
      type: 'bar', stack: 'total', name: s.name, data: s.data,
      itemStyle: { color: colorFor(s.letter) }, emphasis: { focus: 'series' },
    })),
  }, true);
}

export function renderClusterChange(chart, { clusters, series }) {
  chart.setOption({
    ...BASE,
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (items) => [`אשכול ${items[0].axisValue}`,
        ...items.map((it) => `${it.marker}${it.seriesName}: ${it.value > 0 ? '+' : ''}${(it.value * 100).toFixed(1)}`)].join('<br>'),
    },
    legend: { type: 'scroll', bottom: 0, textStyle: { fontSize: 11 } },
    grid: { left: 50, right: 20, top: 20, bottom: 60 },
    xAxis: { type: 'category', data: clusters },
    yAxis: { type: 'value', axisLabel: { formatter: (v) => (v * 100).toFixed(0) } },
    series: series.map((s) => ({
      type: 'bar', name: s.name, data: s.data, itemStyle: { color: colorFor(s.letter) },
    })),
  }, true);
}

export function renderEmpty(chart, text) {
  chart.setOption({
    ...BASE,
    title: { text, left: 'center', top: 'middle', textStyle: { fontSize: 14, color: '#888', fontWeight: 'normal' } },
    series: [],
  }, true);
}
