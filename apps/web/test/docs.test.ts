import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DOC_ORDER, allDocs, expandDirectives, getDoc, parseFrontMatter, renderMarkdown, slugify } from "../src/lib/docs";
import { installSteps } from "../src/lib/examples";

const slugs = DOC_ORDER.flatMap((s) => s.slugs);

describe("markdown rendering", () => {
  it("reads front matter and leaves the body", () => {
    const { data, body } = parseFrontMatter("---\ntitle: Workers\ndescription: \"Run them: well.\"\n---\n\nBody text\n");
    expect(data).toEqual({ title: "Workers", description: "Run them: well." });
    expect(body.trim()).toBe("Body text");
  });

  it("gives headings stable, unique ids and lists h2/h3 for the page outline", () => {
    const { html, toc } = renderMarkdown("## Retry policy (defaults)\n\n### `maxAttempts`\n\n## Retry policy (defaults)\n\n#### Deep\n");
    expect(toc).toEqual([
      { id: "retry-policy-defaults", text: "Retry policy (defaults)", depth: 2 },
      { id: "maxattempts", text: "maxAttempts", depth: 3 },
      { id: "retry-policy-defaults-1", text: "Retry policy (defaults)", depth: 2 },
    ]);
    expect(html).toContain('<h2 id="retry-policy-defaults">');
    expect(html).toContain('<h3 id="maxattempts">');
    expect(slugify("Leases &amp; fencing")).toBe("leases-fencing");
  });

  it("wraps tables so wide ones scroll by themselves", () => {
    const { html } = renderMarkdown("| Field | Default |\n| --- | ---: |\n| `limit` | 50 |\n");
    expect(html).toMatch(/^<div class="table-wrap"><table><thead><tr><th scope="col">Field<\/th><th scope="col" style="text-align:right">Default<\/th>/);
    expect(html).toContain("<td><code>limit</code></td>");
  });

  it("includes repository files and the install steps, and refuses paths outside examples/ and packages/", () => {
    const out = expandDirectives("<!-- include examples/quickstart/src/workflow.ts ts -->");
    expect(out.startsWith("```ts\n")).toBe(true);
    expect(out).toContain('name: "daily-report"');
    const steps = expandDirectives("<!-- install-steps -->");
    expect(steps).toContain(`### 1. ${installSteps[0]!.title}`);
    expect(steps).toContain(installSteps.at(-1)!.code);
    expect(() => expandDirectives("<!-- include ../.env ts -->")).toThrow(/outside/);
    expect(() => expandDirectives("<!-- include apps/api/src/config.ts ts -->")).toThrow(/outside/);
  });
});

describe("documentation content", () => {
  it("has every page in the sidebar, each with a title and a description", () => {
    expect(allDocs().map((d) => d.slug)).toEqual(slugs);
    for (const d of allDocs()) {
      expect(d.title, d.slug).toBeTruthy();
      expect(d.description, d.slug).toBeTruthy();
    }
  });

  it("links only to pages and headings that exist, from the docs and from the site", () => {
    const targets = new Map(allDocs().map((d) => [d.slug === "index" ? "/docs" : `/docs/${d.slug}`, new Set(getDoc(d.slug)!.toc.map((h) => h.id))]));
    const check = (where: string, href: string) => {
      const [path, hash] = href.split("#");
      const ids = targets.get(path!);
      expect(ids, `${where} links to missing page ${href}`).toBeDefined();
      if (hash) expect(ids!.has(hash), `${where} links to missing heading ${href}`).toBe(true);
    };
    for (const d of allDocs()) {
      for (const m of getDoc(d.slug)!.html.matchAll(/href="(\/docs[^"]*)"/g)) check(`docs/${d.slug}`, m[1]!);
    }
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
    for (const file of walk(resolve(process.cwd(), "apps/web/src")).filter((f) => /\.(tsx?|md)$/.test(f))) {
      for (const m of readFileSync(file, "utf8").matchAll(/["'`](\/docs(?:\/[a-z-]+)?(?:#[a-z0-9-]+)?)["'`]/g)) check(file.split("apps/web/")[1]!, m[1]!);
    }
  });
});
