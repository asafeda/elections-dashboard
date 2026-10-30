import { solveTransition } from './transfer.js';

self.onmessage = (e) => {
  const { id, jobs } = e.data;
  const results = jobs.map((stats) => solveTransition(stats));
  self.postMessage({ id, results });
};
