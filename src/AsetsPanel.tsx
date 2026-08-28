import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AsetsLegacyViewer from './AsetsLegacyViewer';
import { makeLegacyViewerData } from './asetsLegacyAdapter';
import type { DownsetRecord, FamilyTransformCertificate } from './asetsCore';
import type { GroupRow } from './groupMath';
import type {
  AsetsFamilyHeader,
  AsetsFamilyKey,
  AsetsWorkerMessage,
  AsetsWorkerRequest,
} from './asetsProtocol';

type PanelPhase = 'idle' | 'cache' | 'context' | 'compute' | 'finalize' | 'complete' | 'cancelled' | 'cancelling' | 'error';

type PanelState = {
  phase: PanelPhase;
  familyKey: AsetsFamilyKey | null;
  emittedRecords: number;
  header: AsetsFamilyHeader | null;
  cached: boolean;
  error: string | null;
  records: readonly DownsetRecord[];
  certificate: FamilyTransformCertificate | null;
};

const EMPTY_STATE: PanelState = {
  phase: 'idle',
  familyKey: null,
  emittedRecords: 0,
  header: null,
  cached: false,
  error: null,
  records: [],
  certificate: null,
};

function phaseLabel(phase: PanelPhase): string {
  switch (phase) {
    case 'cache': return 'checking cache';
    case 'context': return 'preparing';
    case 'compute': return 'computing';
    case 'finalize': return 'finalizing';
    case 'cancelled': return 'cancelled';
    case 'cancelling': return 'cancelling';
    case 'error': return 'error';
    default: return '';
  }
}

function useAsetsFamily(selected: GroupRow | null) {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const busyRef = useRef(false);
  const [state, setState] = useState<PanelState>(EMPTY_STATE);

  const createWorker = useCallback((): Worker => {
    const worker = new Worker(new URL('./workers/asets.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<AsetsWorkerMessage>) => {
      const message = event.data;
      if (message.requestId !== requestIdRef.current) return;
      if (message.type === 'status') {
        setState((previous) => ({
          ...previous,
          phase: message.phase,
          familyKey: message.familyKey,
          certificate: message.certificate,
          emittedRecords: message.emittedRecords,
          error: null,
        }));
      } else if (message.type === 'chunk') {
        setState((previous) => ({
          ...previous,
          familyKey: message.familyKey,
          records: [...previous.records, ...message.records],
          emittedRecords: previous.records.length + message.records.length,
          cached: message.cached,
        }));
      } else if (message.type === 'complete') {
        busyRef.current = false;
        setState((previous) => ({
          ...previous,
          phase: 'complete',
          familyKey: message.familyKey,
          certificate: message.certificate,
          emittedRecords: message.header.downsetTotal,
          header: message.header,
          cached: message.cached,
          error: null,
        }));
      } else if (message.type === 'cancelled') {
        busyRef.current = false;
        setState((previous) => ({ ...previous, phase: 'cancelled' }));
      } else if (message.type === 'error') {
        busyRef.current = false;
        setState((previous) => ({ ...previous, phase: 'error', error: message.message }));
      }
    };
    worker.onerror = (event) => {
      if (workerRef.current !== worker) return;
      busyRef.current = false;
      setState((previous) => ({
        ...previous,
        phase: 'error',
        error: event.message || 'Asets worker failed.',
      }));
    };
    return worker;
  }, []);

  const replaceWorker = useCallback((): Worker => {
    workerRef.current?.terminate();
    workerRef.current = null;
    busyRef.current = false;
    return createWorker();
  }, [createWorker]);

  useEffect(() => {
    createWorker();
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      busyRef.current = false;
    };
  }, [createWorker]);

  useEffect(() => {
    let worker = workerRef.current ?? createWorker();
    const requestId = ++requestIdRef.current;
    if (!selected) {
      if (busyRef.current) worker = replaceWorker();
      busyRef.current = false;
      setState(EMPTY_STATE);
      return;
    }

    if (busyRef.current) worker = replaceWorker();
    busyRef.current = true;
    setState({ ...EMPTY_STATE, phase: 'cache' });
    const request: AsetsWorkerRequest = {
      type: 'compute',
      requestId,
      r: selected.r,
      residues: [selected.a, selected.b, selected.c],
      groupId: selected.id,
      includeRecords: true,
    };
    worker.postMessage(request);
  }, [selected, createWorker, replaceWorker]);

  const cancel = () => {
    if (!workerRef.current || !busyRef.current) return;
    requestIdRef.current += 1;
    replaceWorker();
    setState((previous) => ({ ...previous, phase: 'cancelled' }));
  };

  return { state, cancel };
}

export default function AsetsPanel({ selected }: { selected: GroupRow | null }) {
  const { state, cancel } = useAsetsFamily(selected);
  const running = ['cache', 'context', 'compute', 'finalize', 'cancelling'].includes(state.phase);
  const header = state.header;
  const performanceData = header?.performance;
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    startedAtRef.current = null;
    setElapsedMs(0);
  }, [selected?.id]);

  useEffect(() => {
    if (!running) {
      if (state.phase === 'idle') {
        startedAtRef.current = null;
        setElapsedMs(0);
      }
      return;
    }
    if (startedAtRef.current === null) startedAtRef.current = performance.now();
    const update = () => setElapsedMs(performance.now() - (startedAtRef.current ?? performance.now()));
    update();
    const interval = window.setInterval(update, 100);
    return () => window.clearInterval(interval);
  }, [running, state.phase, selected?.id]);
  const viewerData = useMemo(() => {
    if (!selected || state.phase !== 'complete' || !header || !state.certificate) return null;
    if (state.records.length !== header.downsetTotal) return null;
    return makeLegacyViewerData(selected, state.records, state.certificate);
  }, [selected, state.phase, state.records, state.certificate, header]);

  let summary = selected ? phaseLabel(state.phase) : 'select a group';
  if (state.phase === 'complete' && header) {
    summary = `${header.downsetTotal.toLocaleString()} A-sets`;
    if (state.cached) summary += ' · cached';
    else if (performanceData) summary += ` · ${performanceData.totalWorkerComputeMs.toFixed(1)} ms`;
    if (header.noncoherentTotal) summary += ` · ${header.noncoherentTotal} noncoherent`;
  } else if (running && state.emittedRecords > 0) {
    summary = `${phaseLabel(state.phase)} · ${state.emittedRecords.toLocaleString()}`;
  }
  if (running) summary = `${summary} · ${(elapsedMs / 1000).toFixed(1)} s`;

  const loadingViewer = state.phase === 'complete' && header && state.records.length !== header.downsetTotal;

  return (
    <Paper variant="outlined" sx={{ minWidth: 0, overflow: 'hidden' }}>
      <Box sx={{ px: 1.5, py: 0.9, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Asets</Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>{summary}</Typography>
          {running ? <Button size="small" variant="text" onClick={cancel}>Cancel</Button> : null}
        </Stack>
      </Box>
      {running || loadingViewer ? <LinearProgress /> : null}
      {state.error ? <Alert severity="error" sx={{ borderRadius: 0 }}>{state.error}</Alert> : null}
      {state.phase === 'cancelled' ? <Alert severity="info" sx={{ borderRadius: 0 }}>Aset computation cancelled.</Alert> : null}
      {viewerData ? <AsetsLegacyViewer data={viewerData} /> : null}
    </Paper>
  );
}
