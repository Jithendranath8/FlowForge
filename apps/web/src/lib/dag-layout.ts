/*
 * Left-to-right layout for a workflow DAG, shared by the homepage demo and run views.
 *
 * - Layer: the longest dependency path to a node, so every edge points to the right.
 * - Order within a layer: barycentre sweeps (forward, then backward) to reduce edge
 *   crossings; ties keep the definition order, so the result is deterministic.
 * - Unknown dependencies are ignored; a cycle (which the API never accepts) does not
 *   loop forever: its nodes go after the last layer.
 */

export interface DagInput {
  id: string;
  dependsOn: readonly string[];
}

export interface PlacedNode {
  id: string;
  layer: number;
  /** Position within its layer, top to bottom. */
  row: number;
  x: number;
  y: number;
}

export interface PlacedEdge {
  from: string;
  to: string;
  /** SVG path data. */
  path: string;
}

export interface DagLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  /** Horizontal gap between layers. */
  gapX: number;
  /** Vertical gap between nodes of a layer. */
  gapY: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = { nodeWidth: 148, nodeHeight: 44, gapX: 56, gapY: 16 };

export function layoutDag(input: readonly DagInput[], opts: LayoutOptions = DEFAULT_LAYOUT): DagLayout {
  const ids = new Set(input.map((n) => n.id));
  const deps = new Map(input.map((n) => [n.id, [...new Set(n.dependsOn)].filter((d) => ids.has(d) && d !== n.id)]));

  // Longest-path layering (Kahn's order).
  const layer = new Map<string, number>();
  const indegree = new Map(input.map((n) => [n.id, deps.get(n.id)!.length]));
  const children = new Map<string, string[]>(input.map((n) => [n.id, []]));
  for (const n of input) for (const d of deps.get(n.id)!) children.get(d)!.push(n.id);
  const queue = input.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) layer.set(id, 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const c of children.get(id)!) {
      layer.set(c, Math.max(layer.get(c) ?? 0, layer.get(id)! + 1));
      indegree.set(c, indegree.get(c)! - 1);
      if (indegree.get(c) === 0) queue.push(c);
    }
  }
  const maxLayer = Math.max(-1, ...layer.values());
  for (const n of input) if (!layer.has(n.id)) layer.set(n.id, maxLayer + 1); // cycle members

  const layers: string[][] = [];
  for (const n of input) (layers[layer.get(n.id)!] ??= []).push(n.id);
  for (let l = 0; l < layers.length; l++) layers[l] ??= [];

  // Barycentre ordering: two forward/backward sweeps.
  const position = () => new Map(layers.flatMap((ids) => ids.map((id, i) => [id, i] as const)));
  const sortBy = (ids: string[], neighbours: (id: string) => string[], pos: Map<string, number>) => {
    const original = new Map(ids.map((id, i) => [id, i]));
    const centre = (id: string) => {
      const ns = neighbours(id).filter((n) => pos.has(n));
      return ns.length ? ns.reduce((a, n) => a + pos.get(n)!, 0) / ns.length : original.get(id)!;
    };
    ids.sort((a, b) => centre(a) - centre(b) || original.get(a)! - original.get(b)!);
  };
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let l = 1; l < layers.length; l++) sortBy(layers[l]!, (id) => deps.get(id)!, position());
    for (let l = layers.length - 2; l >= 0; l--) sortBy(layers[l]!, (id) => children.get(id)!, position());
  }

  const tallest = Math.max(1, ...layers.map((l) => l.length));
  const height = tallest * opts.nodeHeight + (tallest - 1) * opts.gapY;
  const nodes: PlacedNode[] = [];
  layers.forEach((ids, l) => {
    const columnHeight = ids.length * opts.nodeHeight + Math.max(0, ids.length - 1) * opts.gapY;
    const top = (height - columnHeight) / 2;
    ids.forEach((id, row) => nodes.push({ id, layer: l, row, x: l * (opts.nodeWidth + opts.gapX), y: top + row * (opts.nodeHeight + opts.gapY) }));
  });
  const at = new Map(nodes.map((n) => [n.id, n]));
  const edges: PlacedEdge[] = [];
  for (const n of input) {
    for (const d of deps.get(n.id)!) {
      const a = at.get(d)!;
      const b = at.get(n.id)!;
      const x1 = a.x + opts.nodeWidth;
      const y1 = a.y + opts.nodeHeight / 2;
      const x2 = b.x;
      const y2 = b.y + opts.nodeHeight / 2;
      const mid = (x1 + x2) / 2;
      edges.push({ from: d, to: n.id, path: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` });
    }
  }
  const width = layers.length * opts.nodeWidth + Math.max(0, layers.length - 1) * opts.gapX;
  return { nodes, edges, width: Math.max(width, 0), height };
}

/** Count edge crossings between adjacent layers (used by tests and to judge layouts). */
export function countCrossings(layout: DagLayout): number {
  const pos = new Map(layout.nodes.map((n) => [n.id, n]));
  const segs = layout.edges.map((e) => ({ a: pos.get(e.from)!, b: pos.get(e.to)! })).filter((s) => s.b.layer === s.a.layer + 1);
  let crossings = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]!;
      const t = segs[j]!;
      if (s.a.layer !== t.a.layer) continue;
      if ((s.a.row - t.a.row) * (s.b.row - t.b.row) < 0) crossings++;
    }
  }
  return crossings;
}
