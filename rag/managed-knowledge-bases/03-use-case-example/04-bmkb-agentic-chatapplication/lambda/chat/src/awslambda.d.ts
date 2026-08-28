/**
 * Ambient declarations for the AWS Lambda response-streaming runtime globals.
 *
 * These are injected by the managed Node.js Lambda runtime when a function is
 * configured with `InvokeMode: RESPONSE_STREAM` (typically via a Function URL).
 * They are NOT part of @types/aws-lambda, so we declare the minimal surface we
 * use here. See: https://docs.aws.amazon.com/lambda/latest/dg/response-streaming-tutorial.html
 */

import type { Writable } from 'node:stream';

declare global {
  /** Node Writable augmented with HTTP metadata setters in the streaming runtime. */
  interface ResponseStream extends Writable {
    setContentType(contentType: string): void;
  }

  namespace awslambda {
    namespace HttpResponseStream {
      /** Prepend HTTP status/headers metadata to a response stream. */
      function from(
        underlyingStream: ResponseStream,
        prelude: {
          statusCode?: number;
          headers?: Record<string, string>;
          cookies?: string[];
        },
      ): ResponseStream;
    }

    /** Wrap a streaming handler so the runtime hands it a ResponseStream. */
    function streamifyResponse<TEvent = unknown>(
      handler: (
        event: TEvent,
        responseStream: ResponseStream,
        context: unknown,
      ) => Promise<void>,
    ): (event: TEvent, responseStream: ResponseStream, context: unknown) => Promise<void>;
  }

  // eslint-disable-next-line no-var
  var awslambda:
    | {
        streamifyResponse: typeof awslambda.streamifyResponse;
        HttpResponseStream: typeof awslambda.HttpResponseStream;
      }
    | undefined;
}

export {};
