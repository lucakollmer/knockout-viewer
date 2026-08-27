import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import type { LegacyViewerData } from './asetsLegacyAdapter';

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
    <Box
      component="iframe"
      ref={frameRef}
      title="Generated Asets viewer"
      src="/asets-viewer-v0.3.10-embedded.html"
      sx={{
        display: 'block',
        width: '100%',
        height: { xs: 1560, md: 1740 },
        border: 0,
        bgcolor: 'background.paper',
        borderRadius: 1.25,
      }}
    />
  );
}
