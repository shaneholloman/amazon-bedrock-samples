import { DocStatus } from '@bmkb/common';
import type { UploadPhase } from '../store/documents.js';
import { AlertIcon, CheckIcon, SpinnerIcon } from './icons.js';

interface Props {
  phase: UploadPhase;
  status: DocStatus | undefined;
  knowledgeBaseStatus?: string | undefined;
}

interface BadgeSpec {
  label: string;
  className: string;
  icon: 'spin' | 'check' | 'alert' | null;
}

function specFor(
  phase: UploadPhase,
  status: DocStatus | undefined,
  knowledgeBaseStatus?: string,
): BadgeSpec {
  // Terminal states first.
  if (status === DocStatus.INDEXED || phase === 'indexed') {
    return {
      label: 'Indexed',
      className:
        'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
      icon: 'check',
    };
  }
  if (status === DocStatus.FAILED || phase === 'failed') {
    return {
      label: 'Failed',
      className: 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
      icon: 'alert',
    };
  }

  // Granular Bedrock sub-states while PENDING.
  if (status === DocStatus.PENDING && knowledgeBaseStatus) {
    switch (knowledgeBaseStatus) {
      case 'STARTING':
        return {
          label: 'Starting',
          className:
            'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
          icon: 'spin',
        };
      case 'PENDING':
        return {
          label: 'Pending',
          className:
            'bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300',
          icon: 'spin',
        };
      case 'IN_PROGRESS':
        return {
          label: 'In progress',
          className:
            'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300',
          icon: 'spin',
        };
      case 'TEXT_INDEXED':
        return {
          label: 'Text indexed',
          className:
            'bg-teal-100 text-teal-800 dark:bg-teal-500/15 dark:text-teal-300',
          icon: 'spin',
        };
    }
  }

  // Client-side phases (before server responds).
  switch (phase) {
    case 'validating':
      return {
        label: 'Validating',
        className: 'bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-300',
        icon: 'spin',
      };
    case 'uploading':
      return {
        label: 'Uploading',
        className: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
        icon: 'spin',
      };
    case 'submitted':
      return {
        label: 'Submitted',
        className: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
        icon: 'spin',
      };
    case 'queued':
    default:
      return {
        label: 'Queued',
        className: 'bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300',
        icon: null,
      };
  }
}

export function StatusBadge({ phase, status, knowledgeBaseStatus }: Props) {
  const spec = specFor(phase, status, knowledgeBaseStatus);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${spec.className}`}
      role="status"
    >
      {spec.icon === 'spin' && <SpinnerIcon className="h-3 w-3" />}
      {spec.icon === 'check' && <CheckIcon className="h-3 w-3" />}
      {spec.icon === 'alert' && <AlertIcon className="h-3 w-3" />}
      {spec.label}
    </span>
  );
}
