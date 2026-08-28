import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import type { LegacyViewerData } from './asetsLegacyAdapter';

const VIEWER_MESSAGE = 'knockout-asets-viewer-data';
const READY_MESSAGE = 'knockout-asets-viewer-ready';

type ViewerMode = 'projection' | 'raw' | 'monomial';

const VIEW_MODES: Array<{ value: ViewerMode; label: string }> = [
  { value: 'projection', label: '2D' },
  { value: 'raw', label: '3D' },
  { value: 'monomial', label: 'Downset' },
];

export default function AsetsLegacyViewer({ data }: { data: LegacyViewerData }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<ViewerMode>('projection');

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

  useEffect(() => {
    if (!ready) return;
    const body = frameRef.current?.contentDocument?.body;
    if (body) body.dataset.viewMode = mode;
  }, [mode, ready]);

  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
      <Tabs
        value={mode}
        onChange={(_event, next: ViewerMode) => setMode(next)}
        variant="fullWidth"
        aria-label="Aset viewer mode"
        sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 44 }}
      >
        {VIEW_MODES.map((item) => (
          <Tab key={item.value} value={item.value} label={item.label} sx={{ minHeight: 44 }} />
        ))}
      </Tabs>
      <Box sx={{ height: { xs: 600, md: 640, xl: 'clamp(500px, calc(100dvh - 300px), 650px)' }, minHeight: 0 }}>
        <iframe
          ref={frameRef}
          title="Generated Asets viewer"
          src="/asets-viewer-v0.3.10-embedded.html"
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            border: 0,
            background: 'transparent',
          }}
        />
      </Box>
    </Paper>
  );
}
