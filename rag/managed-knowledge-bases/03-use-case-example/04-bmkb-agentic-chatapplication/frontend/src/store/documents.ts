import { create } from 'zustand';
import {
  DocStatus,
  IngestPath,
  type DocStatusRecord,
  type UploadRequest,
} from '@bmkb/common';
import {
  BmkbApiError,
  deleteDocumentApi,
  getBatchStatus,
  listDocuments,
  putToPresignedUrl,
  uploadDocument,
} from '../lib/api.js';
import { fileToBase64, resolveContentType, validateFile } from '../lib/files.js';

/** UI-only lifecycle for a single file as it moves through upload → ingest. */
export type UploadPhase =
  | 'queued'
  | 'validating'
  | 'uploading' // sending bytes (inline body or S3 PUT)
  | 'submitted' // accepted by /upload, now PENDING ingest
  | 'indexed'
  | 'failed';

export interface TrackedDocument {
  /** Stable client id for list keys (independent of server documentId). */
  readonly localId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  phase: UploadPhase;
  /** 0..100 for the byte-transfer portion (inline submit or S3 PUT). */
  progress: number;
  ingestPath: IngestPath | undefined;
  documentId: string | undefined;
  status: DocStatus | undefined;
  knowledgeBaseStatus: string | undefined;
  failureReason: string | undefined;
  createdAt: string | undefined;
  updatedAt: string | undefined;
}

interface DocumentsState {
  docs: TrackedDocument[];
  polling: boolean;
  loaded: boolean;
  /** Load existing documents from the server on app init. */
  loadDocuments: () => Promise<void>;
  /** Validate + upload a batch of files for the authenticated user. */
  uploadFiles: (files: File[]) => Promise<void>;
  /** Poll /status for any non-terminal documents of the current user. */
  poll: () => Promise<void>;
  /** Delete a document from the KB (keeps it in list as "Deleted"). */
  deleteDoc: (localId: string) => void;
  /** Remove a single tracked document from the list (client-side only, after delete). */
  remove: (localId: string) => void;
  /** Clear documents that have reached a terminal state. */
  clearFinished: () => void;
  /** Reset the whole list (e.g. on sign-out / user switch). */
  reset: () => void;
}

let idSeq = 0;
function nextLocalId(): string {
  idSeq += 1;
  return `f${Date.now().toString(36)}-${idSeq}`;
}

function phaseFromStatus(status: DocStatus): UploadPhase {
  switch (status) {
    case DocStatus.INDEXED:
      return 'indexed';
    case DocStatus.FAILED:
      return 'failed';
    case DocStatus.PENDING:
    default:
      return 'submitted';
  }
}

export const useDocumentsStore = create<DocumentsState>((set, get) => ({
  docs: [],
  polling: false,
  loaded: false,

  loadDocuments: async () => {
    if (get().loaded) return;
    try {
      const batch = await listDocuments();
      const loaded: TrackedDocument[] = batch.documents.map((rec) => ({
        localId: nextLocalId(),
        filename: rec.filename,
        sizeBytes: rec.sizeBytes,
        contentType: '',
        phase: phaseFromStatus(rec.status),
        progress: 100,
        ingestPath: rec.ingestPath,
        documentId: rec.documentId,
        status: rec.status,
        knowledgeBaseStatus: rec.knowledgeBaseStatus,
        failureReason: rec.failureReason,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
      }));
      set((s) => ({
        loaded: true,
        docs: [...loaded, ...s.docs.filter((d) => !loaded.some((l) => l.documentId === d.documentId))],
      }));
    } catch {
      // Non-fatal: user can still upload; list just won't pre-populate.
      set({ loaded: true });
    }
  },

  uploadFiles: async (files) => {
    if (files.length === 0) return;

    // Seed tracked entries for every selected file up front (instant feedback).
    const seeded: TrackedDocument[] = files.map((file) => ({
      localId: nextLocalId(),
      filename: file.name,
      sizeBytes: file.size,
      contentType: resolveContentType(file),
      phase: 'queued',
      progress: 0,
      ingestPath: undefined,
      documentId: undefined,
      status: undefined,
      knowledgeBaseStatus: undefined,
      failureReason: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    }));
    set((s) => ({ docs: [...seeded, ...s.docs] }));

    const patch = (localId: string, next: Partial<TrackedDocument>): void =>
      set((s) => ({
        docs: s.docs.map((d) => (d.localId === localId ? { ...d, ...next } : d)),
      }));

    // Upload sequentially: the backend enforces the real TPS/concurrency caps,
    // and serial uploads keep the per-file progress UI honest + simple.
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const tracked = seeded[i];
      if (!file || !tracked) continue;
      const { localId } = tracked;

      patch(localId, { phase: 'validating' });
      const verdict = validateFile(file);
      if (!verdict.ok) {
        patch(localId, { phase: 'failed', failureReason: verdict.error ?? 'invalid file' });
        continue;
      }
      patch(localId, { ingestPath: verdict.ingestPath, progress: 5 });

      try {
        const inline = verdict.ingestPath === IngestPath.INLINE;
        patch(localId, { phase: 'uploading' });

        const request: UploadRequest = {
          filename: file.name,
          contentType: verdict.contentType as UploadRequest['contentType'],
          sizeBytes: file.size,
          ...(inline ? { contentBase64: await fileToBase64(file) } : {}),
        };
        patch(localId, { progress: inline ? 60 : 20 });

        const resp = await uploadDocument(request);

        if (resp.ingestPath === IngestPath.S3 && resp.uploadUrl) {
          patch(localId, { documentId: resp.documentId, progress: 40 });
          await putToPresignedUrl(resp.uploadUrl, file);
        }

        patch(localId, {
          phase: phaseFromStatus(resp.status),
          progress: 100,
          documentId: resp.documentId,
          status: resp.status,
          ingestPath: resp.ingestPath,
          createdAt: resp.createdAt,
        });
      } catch (err) {
        const message =
          err instanceof BmkbApiError
            ? `${err.apiError?.code ?? err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : 'upload failed';
        patch(localId, { phase: 'failed', progress: 100, failureReason: message });
      }
    }

    // Kick a poll so PENDING rows start reconciling immediately.
    void get().poll();
  },

  poll: async () => {
    if (get().polling) return;
    const pending = get().docs.filter(
      (d) => d.documentId && d.phase !== 'indexed' && d.phase !== 'failed',
    );
    if (pending.length === 0) return;

    set({ polling: true });
    try {
      const docIds = pending.map((d) => d.documentId as string);
      const batch = await getBatchStatus(docIds);
      const byId = new Map<string, DocStatusRecord>(
        batch.documents.map((r) => [r.documentId, r]),
      );
      set((s) => ({
        docs: s.docs.map((d) => {
          if (!d.documentId) return d;
          const rec = byId.get(d.documentId);
          if (!rec) return d;
          return {
            ...d,
            status: rec.status,
            knowledgeBaseStatus: rec.knowledgeBaseStatus,
            phase: phaseFromStatus(rec.status),
            ingestPath: rec.ingestPath,
            ...(rec.failureReason !== undefined ? { failureReason: rec.failureReason } : {}),
            updatedAt: rec.updatedAt,
          };
        }),
      }));
    } catch {
      // Transient poll failures are non-fatal; the next tick retries.
    } finally {
      set({ polling: false });
    }
  },

  deleteDoc: (localId) => {
    const doc = get().docs.find((d) => d.localId === localId);
    if (!doc?.documentId) return;
    // Mark as deleted in the UI immediately.
    set((s) => ({
      docs: s.docs.map((d) =>
        d.localId === localId
          ? { ...d, status: DocStatus.DELETED, phase: 'failed' as UploadPhase }
          : d,
      ),
    }));
    // Delete from KB + DynamoDB in the background.
    void deleteDocumentApi(doc.documentId).catch(() => {/* best-effort */});
  },

  remove: (localId) => set((s) => ({ docs: s.docs.filter((d) => d.localId !== localId) })),

  clearFinished: () =>
    set((s) => ({
      docs: s.docs.filter((d) => d.phase !== 'indexed' && d.phase !== 'failed'),
    })),

  reset: () => set({ docs: [] }),
}));
