/// <reference lib="webworker" />
import { canonicalizePresentation, groupRow, type Group8 } from '../groupMath';

type Request = { type: 'canonicalize'; requestId: number; group: Group8 };

self.onmessage = (event: MessageEvent<Request>) => {
  const { requestId, group } = event.data;
  try {
    const canonical = canonicalizePresentation(group);
    self.postMessage({
      type: 'result',
      requestId,
      canonical: canonical ? groupRow(canonical) : null,
    });
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
