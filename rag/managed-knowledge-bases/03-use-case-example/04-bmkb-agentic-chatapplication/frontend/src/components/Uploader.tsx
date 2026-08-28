import { useCallback, useId, useRef, useState } from 'react';
import { useDocumentsStore } from '../store/documents.js';
import { ACCEPT_ATTR, formatBytes, INLINE_MAX_BYTES, S3_MAX_FILE_BYTES } from '../lib/files.js';
import { UploadIcon } from './icons.js';
import { SUPPORTED_EXTENSIONS } from '@bmkb/common';

export function Uploader() {
  const uploadFiles = useDocumentsStore((s) => s.uploadFiles);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      void uploadFiles(Array.from(fileList));
    },
    [uploadFiles],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload files. Drag and drop, or activate to browse."
        aria-describedby={`${inputId}-help`}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={[
          'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition',
          dragging
            ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10'
            : 'border-slate-300 hover:border-brand-400 dark:border-slate-700 dark:hover:border-brand-500',
        ].join(' ')}
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
          <UploadIcon className="h-6 w-6" />
        </span>
        <div>
          <p className="text-sm font-medium">
            Drag &amp; drop files here, or{' '}
            <span className="text-brand-600 dark:text-brand-400">browse</span>
          </p>
          <p id={`${inputId}-help`} className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {SUPPORTED_EXTENSIONS.join('  ')} · up to {formatBytes(S3_MAX_FILE_BYTES)} each
          </p>
        </div>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="sr-only"
          onChange={(e) => {
            handleFiles(e.target.files);
            // Reset so selecting the same file again re-triggers change.
            e.target.value = '';
          }}
        />
      </div>
      <p className="mt-2 text-center text-[11px] text-slate-400 dark:text-slate-500">
        Files up to {formatBytes(INLINE_MAX_BYTES)} are sent inline; larger files use a presigned
        S3 upload.
      </p>
    </div>
  );
}
