import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocPage } from "@/components/docs/DocPage";
import { getDoc } from "@/lib/docs";

export function generateMetadata(): Metadata {
  const doc = getDoc("index");
  return { title: doc ? `${doc.title}: documentation` : "Documentation", description: doc?.description };
}

export default function DocsHome() {
  const doc = getDoc("index");
  if (!doc) notFound();
  return <DocPage doc={doc} />;
}
