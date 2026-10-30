/**
 * Ecological estimate of the old->new transition matrix P (K x M, row-stochastic):
 *   minimize  sum_u w_u ||y_u - x_u P||^2 + lambda ||P - T||^2
 * where x_u / y_u are the old / new category shares of unit u (including
 * non-voters), w_u is the unit's old registered voters, and T has every row
 * equal to the overall new shares (keeps poorly identified rows sensible).
 * Solved by FISTA with each row projected onto the probability simplex.
 */

const RIDGE = 1e-3;

/** pairs: [{ x: Float64Array(K) counts, y: Float64Array(M) counts }] */
export function computeStats(pairs, K, M) {
  const A = new Float64Array(K * K);
  const B = new Float64Array(K * M);
  const oldTotals = new Float64Array(K);
  const newTotals = new Float64Array(M);
  const xs = new Float64Array(K);
  const ys = new Float64Array(M);
  for (const { x, y } of pairs) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < K; i++) sx += x[i];
    for (let j = 0; j < M; j++) sy += y[j];
    if (sx <= 0 || sy <= 0) continue;
    for (let i = 0; i < K; i++) { xs[i] = x[i] / sx; oldTotals[i] += x[i]; }
    for (let j = 0; j < M; j++) { ys[j] = y[j] / sy; newTotals[j] += y[j]; }
    const w = sx;
    for (let i = 0; i < K; i++) {
      const wxi = w * xs[i];
      if (wxi === 0) continue;
      for (let k = 0; k < K; k++) A[i * K + k] += wxi * xs[k];
      for (let j = 0; j < M; j++) B[i * M + j] += wxi * ys[j];
    }
  }
  return { K, M, A, B, oldTotals, newTotals, units: pairs.length };
}

function projectSimplex(row, out, off, M, buf) {
  for (let j = 0; j < M; j++) buf[j] = row[off + j];
  buf.sort((a, b) => b - a);
  let cum = 0;
  let theta = 0;
  for (let j = 0; j < M; j++) {
    cum += buf[j];
    const t = (cum - 1) / (j + 1);
    if (buf[j] - t > 0) theta = t;
  }
  for (let j = 0; j < M; j++) out[off + j] = Math.max(0, row[off + j] - theta);
}

function maxEigen(A, K) {
  let v = new Float64Array(K).fill(1 / Math.sqrt(K));
  let lambda = 0;
  for (let it = 0; it < 100; it++) {
    const w = new Float64Array(K);
    for (let i = 0; i < K; i++) {
      let s = 0;
      for (let k = 0; k < K; k++) s += A[i * K + k] * v[k];
      w[i] = s;
    }
    const norm = Math.hypot(...w);
    if (norm === 0) return 0;
    for (let i = 0; i < K; i++) w[i] /= norm;
    if (Math.abs(norm - lambda) < 1e-12 * norm) return norm;
    lambda = norm;
    v = w;
  }
  return lambda;
}

export function solveTransition(stats, maxIter = 4000) {
  const { K, M, A, B, newTotals } = stats;
  let trace = 0;
  for (let i = 0; i < K; i++) trace += A[i * K + i];
  const lambda = RIDGE * (trace / K || 1);
  const L = 2 * (maxEigen(A, K) + lambda) || 1;
  const step = 1 / L;

  const totalNew = newTotals.reduce((a, b) => a + b, 0) || 1;
  const prior = Float64Array.from(newTotals, (v) => v / totalNew);

  let P = new Float64Array(K * M);
  for (let i = 0; i < K; i++) P.set(prior, i * M);
  let Yk = Float64Array.from(P);
  let t = 1;
  const G = new Float64Array(K * M);
  const next = new Float64Array(K * M);
  const buf = new Float64Array(M);

  for (let it = 0; it < maxIter; it++) {
    // G = 2 (A Yk - B) + 2 lambda (Yk - prior)
    for (let i = 0; i < K; i++) {
      const gi = i * M;
      for (let j = 0; j < M; j++) G[gi + j] = lambda * (Yk[gi + j] - prior[j]) - B[gi + j];
      for (let k = 0; k < K; k++) {
        const a = A[i * K + k];
        if (a === 0) continue;
        const yk = k * M;
        for (let j = 0; j < M; j++) G[gi + j] += a * Yk[yk + j];
      }
      for (let j = 0; j < M; j++) G[gi + j] *= 2;
    }
    for (let idx = 0; idx < K * M; idx++) G[idx] = Yk[idx] - step * G[idx];
    for (let i = 0; i < K; i++) projectSimplex(G, next, i * M, M, buf);

    let diff = 0;
    let restart = 0;
    for (let idx = 0; idx < K * M; idx++) {
      const d = next[idx] - P[idx];
      diff = Math.max(diff, Math.abs(d));
      restart += (Yk[idx] - next[idx]) * d;
    }
    // Adaptive restart (O'Donoghue & Candes): drop momentum when it points uphill.
    if (restart > 0) t = 1;

    const tNext = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
    const mom = (t - 1) / tNext;
    for (let idx = 0; idx < K * M; idx++) Yk[idx] = next[idx] + mom * (next[idx] - P[idx]);
    P = Float64Array.from(next);
    t = tNext;
    if (diff < 1e-7 && it > 50) break;
  }
  return P;
}
