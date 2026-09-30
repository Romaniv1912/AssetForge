/**
 * Minimal typing for a dedicated worker's global scope. The project compiles
 * against the DOM lib (the UI), and mixing in the `webworker` lib would
 * produce conflicting global declarations.
 */
export interface WorkerScope<In, Out> {
  onmessage: ((event: MessageEvent<In>) => void) | null;
  postMessage(message: Out, transfer?: Transferable[]): void;
}

export function workerScope<In, Out>(): WorkerScope<In, Out> {
  return self as unknown as WorkerScope<In, Out>;
}
