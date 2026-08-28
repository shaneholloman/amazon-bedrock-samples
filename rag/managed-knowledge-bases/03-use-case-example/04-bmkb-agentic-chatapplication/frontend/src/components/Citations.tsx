import type { ChatCitation } from '@bmkb/common';
import { useDocumentsStore } from '../store/documents.js';

/** Resolve a documentId to a human-readable filename from the local document list. */
function useDocumentName(documentId: string | undefined): string | undefined {
  const docs = useDocumentsStore((s) => s.docs);
  if (!documentId) return undefined;
  const doc = docs.find((d) => d.documentId === documentId);
  return doc?.filename;
}

function CitationCard({ citation, index }: { citation: ChatCitation; index: number }) {
  // Try to get the filename from the first reference's documentId.
  const docId = citation.references[0]?.documentId;
  const filename = useDocumentName(docId);

  // Clean up the snippet text — trim and truncate if very long.
  const snippet = citation.text?.trim();
  const displaySnippet =
    snippet && snippet.length > 300 ? snippet.slice(0, 300) + '…' : snippet;

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800/80">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[10px] font-bold text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          {filename && (
            <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
              📄 {filename}
            </p>
          )}
          {displaySnippet && (
            <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400 italic">
              "{displaySnippet}"
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

export function Citations({ citations }: { citations: readonly ChatCitation[] }) {
  if (citations.length === 0) return null;
  return (
    <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs dark:border-slate-700 dark:bg-slate-800/50">
      <summary className="cursor-pointer select-none font-medium text-slate-600 dark:text-slate-300">
        📚 {citations.length} source{citations.length === 1 ? '' : 's'} cited
      </summary>
      <ol className="mt-2 flex flex-col gap-2">
        {citations.map((c, i) => (
          <CitationCard key={i} citation={c} index={i} />
        ))}
      </ol>
    </details>
  );
}
