import { useEffect, useRef, useState } from 'react';
import type { LegacyViewerData } from './asetsLegacyAdapter';

// Keep the embedded legacy visualizer isolated from the generated-data engine.
// Preview review branch intentionally preserves the validated runtime behavior.
const VIEWER_MESSAGE = 'knockout-asets-viewer-data';
const READY_MESSAGE = 'knockout-asets-viewer-ready';

export default function AsetsLegacyViewer({ data }: { data: LegacyViewerData }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.data?.type === READY_MESSAGE) setReady(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!ready) return;
    frameRef.current?.contentWindow?.postMessage(
      { type: VIEWER_MESSAGE, data },
      window.location.origin,
    );
  }, [data, ready]);

  return (
    <iframe
      ref={frameRef}
      title="Generated Asets viewer"
      src="/asets-viewer-v0.3.10-embedded.html"
      style={{
        display: 'block',
        width: '100%',
        height: '1740px',
        border: 0,
        background: 'transparent',
        borderRadius: '10px',
      }}
    />
  );
}
