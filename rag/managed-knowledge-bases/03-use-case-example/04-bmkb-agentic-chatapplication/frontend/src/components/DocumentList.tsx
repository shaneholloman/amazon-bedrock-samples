import { DocStatus, IngestPath } from '@bmkb/common';
import { useDocumentsStore, type TrackedDocument } from '../store/documents.js';
import { formatBytes } from '../lib/files.js';
import { StatusBadge } from './StatusBadge.js';
import { FileIcon, TrashIcon } from './icons.js';

function PathHint({ path }: { path: IngestPath | undefined }) {
  if (!path) return null;
  const inline = path === IngestPath.INLINE;
  return (
    <span
      className="rounded border border-slate-200 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:text-slate-400"
      title={inline ? 'Sent inline (≤ 6 MB)' : 'Uploaded via presigned S3 URL'}
    >
      {inline ? 'inline' : 's3'}
    </span>
  );
}

function ProgressBar({ value, active }: { value: number; active: boolean }) {
  return (
    <div
      className="h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full transition-all duration-300 ${
          active ? 'bg-brand-500' : 'bg-emerald-500'
        }`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

function DocumentRow({ doc }: { doc: TrackedDocument }) {
  const deleteDoc = useDocumentsStore((s) => s.deleteDoc);
  const remove = useDocumentsStore((s) => s.remove);
  const active =
    doc.phase === 'uploading' || doc.phase === 'validating' || doc.phase === 'queued';
  const showBar = active || (doc.phase === 'submitted' && doc.progress < 100);
  const isDeleted = doc.status === DocStatus.DELETED;

  return (
    <li className="animate-fade-in rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-slate-400 dark:text-slate-500">
          <FileIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className={`truncate text-sm font-medium ${isDeleted ? 'line-through text-slate-400' : ''}`} title={doc.filename}>
              {doc.filename}
            </p>
            {isDeleted ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500 dark:bg-slate-700/40 dark:text-slate-400">
                Deleted
              </span>
            ) : (
              <StatusBadge phase={doc.phase} status={doc.status} knowledgeBaseStatus={doc.knowledgeBaseStatus} />
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>{formatBytes(doc.sizeBytes)}</span>
            <PathHint path={doc.ingestPath} />
            {doc.documentId && (
              <span className="truncate font-mono text-[10px]" title={doc.documentId}>
                {doc.documentId}
              </span>
            )}
          </div>
          {showBar && (
            <div className="mt-2">
              <ProgressBar value={doc.progress} active={active} />
            </div>
          )}
          {doc.phase === 'failed' && doc.failureReason && !isDeleted && (
            <p className="mt-1.5 text-xs text-rose-600 dark:text-rose-400" role="alert">
              {doc.failureReason}
            </p>
          )}
        </div>
        {isDeleted ? (
          <button
            type="button"
            onClick={() => remove(doc.localId)}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label={`Remove ${doc.filename} from the list`}
            title="Remove from list"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => deleteDoc(doc.localId)}
            className="rounded-md p-1 text-slate-400 hover:bg-rose-100 hover:text-rose-600 dark:hover:bg-rose-900/30 dark:hover:text-rose-400"
            aria-label={`Delete ${doc.filename} from knowledge base`}
            title="Delete from knowledge base"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        )}
      </div>
    </li>
  );
}

export function DocumentList() {
  const docs = useDocumentsStore((s) => s.docs);
  const clearFinished = useDocumentsStore((s) => s.clearFinished);
  const hasFinished = docs.some((d) => d.phase === 'indexed' || d.phase === 'failed');

  if (docs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400 dark:border-slate-800 dark:text-slate-500">
        No documents yet. Uploaded files and their indexing status appear here.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-600 dark:text-slate-300">
          Documents <span className="text-slate-400">({docs.length})</span>
        </h3>
        {hasFinished && (
          <button
            type="button"
            onClick={clearFinished}
            className="text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            Clear finished
          </button>
        )}
      </div>
      <ul className="bmkb-scroll flex max-h-[42vh] flex-col gap-2 overflow-y-auto pr-1">
        {docs.map((doc) => (
          <DocumentRow key={doc.localId} doc={doc} />
        ))}
      </ul>
    </div>
  );
}
