import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocPage } from "@/components/docs/DocPage";
import { allDocs, getDoc } from "@/lib/docs";

/** Every page is built ahead of time; unknown slugs are 404s. */
export const dynamicParams = false;

export function generateStaticParams() {
  return allDocs()
    .filter((d) => d.slug !== "index")
    .map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const doc = getDoc((await params).slug);
  return doc ? { title: doc.title, description: doc.description } : {};
}

export default async function DocsSlugPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = slug === "index" ? undefined : getDoc(slug);
  if (!doc) notFound();
  return <DocPage doc={doc} />;
}
