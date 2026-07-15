/** A write failure that must not be mistaken for a command/runtime failure. */
export class StreamWriteError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'StreamWriteError';
    this.cause = cause;
  }
}

/**
 * Write one complete chunk without taking ownership of the stream.
 *
 * Resolution requires both the write callback and, when write() reports
 * backpressure, the matching drain event. The stream is never ended.
 */
export function writeToStream(
  stream: NodeJS.WritableStream,
  chunk: string | Uint8Array,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const prematureCloseError = new Error('Writable stream closed before the write completed');
    const streamState = stream as NodeJS.WritableStream & { closed?: boolean; destroyed?: boolean };
    if (streamState.closed || streamState.destroyed) {
      reject(new StreamWriteError(prematureCloseError));
      return;
    }

    let writeReturned = false;
    let callbackComplete = false;
    let requiresDrain = false;
    let drainSeen = false;
    let settled = false;
    let pendingCallbackError: unknown;
    let pendingCallbackFailure: NodeJS.Immediate | undefined;

    const cleanup = (): void => {
      stream.removeListener('error', onError);
      stream.removeListener('drain', onDrain);
      stream.removeListener('close', onClose);
      if (pendingCallbackFailure) {
        clearImmediate(pendingCallbackFailure);
        pendingCallbackFailure = undefined;
      }
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof StreamWriteError ? error : new StreamWriteError(error));
    };
    const failFromCallback = (error: unknown): void => {
      if (settled) return;
      pendingCallbackError ??= error;
      // A real Node Writable reports an _write callback failure to the public
      // write callback and then emits `error`. Keep the error listener until
      // that paired event has had a chance to arrive, while still bounding
      // non-standard streams that only invoke the callback.
      pendingCallbackFailure ??= setImmediate(() => fail(pendingCallbackError));
    };
    const finish = (): void => {
      if (settled || !writeReturned || !callbackComplete || (requiresDrain && !drainSeen)) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => fail(error);
    const onClose = (): void => fail(pendingCallbackError ?? prematureCloseError);
    const onDrain = (): void => {
      drainSeen = true;
      finish();
    };

    stream.once('error', onError);
    stream.once('drain', onDrain);
    stream.once('close', onClose);
    try {
      requiresDrain = stream.write(chunk, (error?: Error | null) => {
        if (error) {
          failFromCallback(error);
          return;
        }
        callbackComplete = true;
        finish();
      }) === false;
      writeReturned = true;
      if (!requiresDrain) stream.removeListener('drain', onDrain);
      finish();
    } catch (error) {
      fail(error);
    }
  });
}
