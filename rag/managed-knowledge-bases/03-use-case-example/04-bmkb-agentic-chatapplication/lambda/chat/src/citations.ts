/**
 * Map Bedrock Agent Runtime citation shapes to the @bmkb/common `ChatCitation`
 * contract. Pure functions, no I/O — unit-testable.
 */

import type { Citation, RetrievedReference } from '@aws-sdk/client-bedrock-agent-runtime';
import type { ChatCitation, ChatCitationReference } from '@bmkb/common';

/** Extract a document id from a retrieved reference's source location, if any. */
function documentIdOf(ref: RetrievedReference): string | undefined {
  const loc = ref.location;
  if (loc === undefined) {
    return undefined;
  }
  // CUSTOM data source (our inline ingest path) carries the document id here.
  const customId = loc.customDocumentLocation?.id;
  if (typeof customId === 'string' && customId.length > 0) {
    return customId;
  }
  return undefined;
}

/** Extract an S3 URI from a retrieved reference's source location, if any. */
function s3UriOf(ref: RetrievedReference): string | undefined {
  const uri = ref.location?.s3Location?.uri;
  return typeof uri === 'string' && uri.length > 0 ? uri : undefined;
}

/** Extract the cited snippet text from a retrieved reference, if any. */
function snippetOf(ref: RetrievedReference): string | undefined {
  const text = ref.content?.text;
  return typeof text === 'string' && text.length > 0 ? text : undefined;
}

function toReference(ref: RetrievedReference): ChatCitationReference {
  const documentId = documentIdOf(ref);
  const s3Uri = s3UriOf(ref);
  const snippet = snippetOf(ref);
  // exactOptionalPropertyTypes: only include keys that are present.
  const out: { documentId?: string; s3Uri?: string; snippet?: string } = {};
  if (documentId !== undefined) {
    out.documentId = documentId;
  }
  if (s3Uri !== undefined) {
    out.s3Uri = s3Uri;
  }
  if (snippet !== undefined) {
    out.snippet = snippet;
  }
  return out;
}

/** Map a single Bedrock Citation to the contract shape. */
export function mapCitation(citation: Citation): ChatCitation {
  const text = citation.generatedResponsePart?.textResponsePart?.text ?? '';
  const references = (citation.retrievedReferences ?? []).map(toReference);
  return { text, references };
}

/** Map a list of Bedrock Citations to the contract shape. */
export function mapCitations(citations: readonly Citation[] | undefined): ChatCitation[] {
  if (citations === undefined || citations.length === 0) {
    return [];
  }
  return citations.map(mapCitation);
}
