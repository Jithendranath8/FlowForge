import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { Marked, type Tokens } from "marked";
import { installSteps } from "./examples";
import { repoRoot } from "./repo";

/*
 * The documentation: Markdown files in apps/web/content/docs, rendered to HTML at build
 * time. The files are part of this repository (trusted content), so raw HTML in them is
 * passed through; nothing here renders user input.
 */

export interface DocMeta {
  slug: string;
  title: string;
  description: string;
  /** Sidebar group. */
  section: string;
}

export interface Doc extends DocMeta {
  html: string;
  /** Second- and third-level headings, for the "On this page" list. */
  toc: { id: string; text: string; depth: 2 | 3 }[];
}

/** Sidebar order. The slug "index" is the docs home (/docs). */
export const DOC_ORDER: { section: string; slugs: string[] }[] = [
  { section: "Get started", slugs: ["index", "quick-start", "concepts"] },
  { section: "Build", slugs: ["workflows", "workers", "api"] },
  { section: "Run", slugs: ["reliability", "operations", "security"] },
];

const contentDir = () => join(repoRoot(), "apps", "web", "content", "docs");

/**
 * Build-time directives, so code shown in the docs is the code in the repository:
 * `<!-- include examples/quickstart/src/worker.ts ts -->` becomes that file as a code
 * block, and `<!-- install-steps -->` becomes the install steps the homepage shows.
 */
export function expandDirectives(body: string): string {
  return body
    .replace(/^<!-- include (\S+)(?: (\w+))? -->$/gm, (_m, path: string, lang?: string) => {
      const rel = normalize(path);
      if (rel.startsWith("..") || !/^(examples|packages)\//.test(rel)) throw new Error(`docs include outside examples/ or packages/: ${path}`);
      const code = readFileSync(join(repoRoot(), rel), "utf8").trimEnd();
      const fence = code.includes("```") ? "````" : "```";
      return `${fence}${lang ?? ""}\n${code}\n${fence}`;
    })
    .replace(/^<!-- install-steps -->$/gm, () =>
      installSteps.map((s, i) => `### ${i + 1}. ${s.title}\n\n${s.detail}\n\n\`\`\`sh\n${s.code}\n\`\`\``).join("\n\n"),
    );
}

/** `---\nkey: value\n---` at the top of a file. Values are single-line strings. */
export function parseFrontMatter(source: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!m) return { data: {}, body: source };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) data[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { data, body: source.slice(m[0].length) };
}

/** Heading text to a URL fragment: "Retry policy (defaults)" → "retry-policy-defaults". */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;|&#\d+;/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export function renderMarkdown(body: string): { html: string; toc: Doc["toc"] } {
  const toc: Doc["toc"] = [];
  const used = new Map<string, number>();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(this: { parser: { parseInline: (t: Tokens.Heading["tokens"]) => string } }, token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        const base = slugify(token.text) || "section";
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        const id = n === 0 ? base : `${base}-${n}`;
        if (token.depth === 2 || token.depth === 3) toc.push({ id, text: inner.replace(/<[^>]+>/g, ""), depth: token.depth });
        return `<h${token.depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${token.depth}>\n`;
      },
      // Wide tables scroll inside their own box instead of widening the page.
      table(this: unknown, token: Tokens.Table) {
        const cell = (c: Tokens.TableCell, tag: "th" | "td") => {
          const align = c.align ? ` style="text-align:${c.align}"` : "";
          const scope = tag === "th" ? ' scope="col"' : "";
          return `<${tag}${scope}${align}>${(this as { parser: { parseInline: (t: Tokens.TableCell["tokens"]) => string } }).parser.parseInline(c.tokens)}</${tag}>`;
        };
        const head = `<tr>${token.header.map((c) => cell(c, "th")).join("")}</tr>`;
        const rows = token.rows.map((r) => `<tr>${r.map((c) => cell(c, "td")).join("")}</tr>`).join("");
        return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  const html = marked.parse(body, { async: false });
  return { html, toc };
}

let cache: Map<string, Doc> | undefined;

function load(): Map<string, Doc> {
  if (cache) return cache;
  const dir = contentDir();
  const docs = new Map<string, Doc>();
  for (const { section, slugs } of DOC_ORDER) {
    for (const slug of slugs) {
      const file = join(dir, `${slug}.md`);
      if (!existsSync(file)) continue;
      const { data, body } = parseFrontMatter(readFileSync(file, "utf8"));
      if (!data.title) throw new Error(`${slug}.md has no title in its front matter`);
      const { html, toc } = renderMarkdown(expandDirectives(body));
      docs.set(slug, { slug, title: data.title, description: data.description ?? "", section, html, toc });
    }
  }
  cache = docs;
  return docs;
}

export const getDoc = (slug: string): Doc | undefined => load().get(slug);

/** Every page, in sidebar order. */
export const allDocs = (): DocMeta[] => [...load().values()].map(({ slug, title, description, section }) => ({ slug, title, description, section }));

export const docHref = (slug: string) => (slug === "index" ? "/docs" : `/docs/${slug}`);
