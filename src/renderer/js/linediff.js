// Diferencias línea a línea (algoritmo de Myers) para ver qué cambió en un archivo de texto,
// como un "diff" de git: bloques con unas líneas de contexto alrededor de cada cambio.

const MAX_D = 2500; // más cambios que esto no se muestran línea a línea (sería ilegible y lento)

const splitLines = (t) => {
  const s = String(t ?? '').replace(/\r\n?/g, '\n');
  const lines = s.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return s === '' ? [] : lines;
};

// Camino más corto entre A[a0..a1) y B[b0..b1). Devuelve [['=', i, j] | ['-', i] | ['+', null, j]] o null.
function myers(A, B, a0, a1, b0, b1) {
  const N = a1 - a0;
  const M = b1 - b0;
  const max = N + M;
  if (!max) return [];
  const off = max + 1;
  const V = new Int32Array(2 * max + 3);
  const trace = [];
  const limit = Math.min(max, MAX_D);
  for (let d = 0; d <= limit; d++) {
    trace.push(V.slice(off - d - 1, off + d + 2)); // V antes del paso d, para k en [-d-1, d+1]
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[a0 + x] === B[b0 + y]) { x++; y++; }
      V[off + k] = x;
      if (x >= N && y >= M) return backtrack(trace, N, M, a0, b0);
    }
  }
  return null;
}

function backtrack(trace, N, M, a0, b0) {
  const out = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const get = (k) => v[k + d + 1];
    const k = x - y;
    const prevK = (k === -d || (k !== d && get(k - 1) < get(k + 1))) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push(['=', a0 + x - 1, b0 + y - 1]); x--; y--; }
    if (d > 0) {
      if (x === prevX) out.push(['+', null, b0 + y - 1]);
      else out.push(['-', a0 + x - 1, null]);
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

/**
 * Compara dos textos. Devuelve { hunks: [{ lines: [{ t: ' '|'+'|'-', a, b, text }] }], added, removed, truncated }
 * o { tooMany: true, added, removed } si hay demasiados cambios.
 */
export function diffLines(oldText, newText, { context = 3, maxLines = 2000 } = {}) {
  const A = splitLines(oldText);
  const B = splitLines(newText);
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA--; endB--; }
  const mid = myers(A, B, start, endA, start, endB);
  if (!mid) {
    // aproximado: líneas que están en un lado y no en el otro
    const count = (arr) => arr.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
    const ca = count(A.slice(start, endA));
    const cb = count(B.slice(start, endB));
    let added = 0;
    let removed = 0;
    for (const [l, n] of cb) added += Math.max(0, n - (ca.get(l) || 0));
    for (const [l, n] of ca) removed += Math.max(0, n - (cb.get(l) || 0));
    return { tooMany: true, added, removed };
  }
  const ops = [];
  for (let i = 0; i < start; i++) ops.push(['=', i, i]);
  ops.push(...mid);
  for (let i = 0; endA + i < A.length; i++) ops.push(['=', endA + i, endB + i]);

  let added = 0;
  let removed = 0;
  for (const o of ops) { if (o[0] === '+') added++; else if (o[0] === '-') removed++; }
  // bloques: cada cambio con `context` líneas iguales antes y después
  const keep = new Uint8Array(ops.length);
  ops.forEach((o, i) => {
    if (o[0] === '=') return;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = 1;
  });
  const hunks = [];
  let cur = null;
  let shown = 0;
  let truncated = false;
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) { cur = null; continue; }
    if (shown >= maxLines) { truncated = true; break; }
    if (!cur) { cur = { lines: [] }; hunks.push(cur); }
    const [t, a, b] = ops[i];
    cur.lines.push({ t: t === '=' ? ' ' : t, a: a == null ? null : a + 1, b: b == null ? null : b + 1, text: t === '+' ? B[b] : A[a] });
    shown++;
  }
  return { hunks, added, removed, truncated };
}

// Los JSON guardados en una sola línea se formatean para que la comparación sirva de algo.
export function prettyIfJson(file, a, b) {
  if (!/\.(json|mcmeta)$/i.test(file || '')) return { a, b, formatted: false };
  const long = (t) => String(t || '').split('\n').some((l) => l.length > 300);
  if (!long(a) && !long(b)) return { a, b, formatted: false };
  try {
    return { a: a ? JSON.stringify(JSON.parse(a), null, 2) : a, b: b ? JSON.stringify(JSON.parse(b), null, 2) : b, formatted: true };
  } catch {
    return { a, b, formatted: false };
  }
}
