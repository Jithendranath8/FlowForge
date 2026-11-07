import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, countCrossings, layoutDag } from "../src/lib/dag-layout";

const diamond = [
  { id: "extract", dependsOn: [] },
  { id: "clean", dependsOn: ["extract"] },
  { id: "enrich", dependsOn: ["extract"] },
  { id: "load", dependsOn: ["clean", "enrich"] },
];

describe("layoutDag", () => {
  it("puts every node one layer right of its deepest dependency, so all edges point right", () => {
    const l = layoutDag([...diamond, { id: "report", dependsOn: ["extract", "load"] }]);
    const layer = Object.fromEntries(l.nodes.map((n) => [n.id, n.layer]));
    expect(layer).toEqual({ extract: 0, clean: 1, enrich: 1, load: 2, report: 3 });
    const x = Object.fromEntries(l.nodes.map((n) => [n.id, n.x]));
    for (const e of l.edges) expect(x[e.to]!).toBeGreaterThan(x[e.from]!);
    expect(l.edges).toHaveLength(6);
  });

  it("is deterministic and keeps definition order among equals", () => {
    const a = layoutDag(diamond);
    const b = layoutDag(diamond);
    expect(a).toEqual(b);
    expect(a.nodes.filter((n) => n.layer === 1).map((n) => n.id)).toEqual(["clean", "enrich"]);
  });

  it("reorders layers to remove avoidable crossings", () => {
    // Definition order crosses: b1 feeds c2, b2 feeds c1.
    const nodes = [
      { id: "a1", dependsOn: [] },
      { id: "a2", dependsOn: [] },
      { id: "c1", dependsOn: ["a2"] },
      { id: "c2", dependsOn: ["a1"] },
    ];
    expect(countCrossings(layoutDag(nodes))).toBe(0);
  });

  it("centres short layers and sizes the canvas from the widest and tallest", () => {
    const l = layoutDag(diamond);
    const { nodeWidth, nodeHeight, gapX, gapY } = DEFAULT_LAYOUT;
    expect(l.width).toBe(3 * nodeWidth + 2 * gapX);
    expect(l.height).toBe(2 * nodeHeight + gapY);
    const extract = l.nodes.find((n) => n.id === "extract")!;
    expect(extract.y).toBe((l.height - nodeHeight) / 2);
  });

  it("ignores unknown dependencies and survives a cycle", () => {
    const l = layoutDag([
      { id: "a", dependsOn: ["ghost"] },
      { id: "b", dependsOn: ["c"] },
      { id: "c", dependsOn: ["b"] },
    ]);
    expect(l.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(l.nodes.find((n) => n.id === "a")!.layer).toBe(0);
    expect(l.nodes.find((n) => n.id === "b")!.layer).toBe(1);
  });

  it("handles an empty graph", () => {
    expect(layoutDag([])).toEqual({ nodes: [], edges: [], width: 0, height: DEFAULT_LAYOUT.nodeHeight });
  });
});
