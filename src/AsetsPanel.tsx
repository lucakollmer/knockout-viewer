import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
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
    case 'context': return 'preparing modulus';
    case 'compute': return 'computing';
    case 'finalize': return 'finalizing';
    case 'complete': return 'complete';
    case 'cancelled': return 'cancelled';
    case 'cancelling': return 'cancelling';
    case 'error': return 'error';
    default: return 'idle';
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
  const family = state.familyKey ? `r=${state.familyKey[1]} · (${state.familyKey.slice(2).join(', ')})` : null;
  const viewerData = useMemo(() => {
    if (!selected || state.phase !== 'complete' || !header || !state.certificate) return null;
    if (state.records.length !== header.downsetTotal) return null;
    return makeLegacyViewerData(selected, state.records, state.certificate);
  }, [selected, state.phase, state.records, state.certificate, header]);

  return (
    <Stack spacing={1.5}>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={1}>
            <Stack direction="row" useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 0.75 }}>
              <Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Asets</Typography>
                <Typography variant="caption" color="text.secondary">Exact browser generation · v0.3.10 visualizer · local cache</Typography>
              </Box>
              {selected ? <Chip size="small" variant="outlined" label={phaseLabel(state.phase)} /> : null}
            </Stack>

            {!selected ? (
              <Typography variant="body2" color="text.secondary">Select a group to generate and inspect its Asets.</Typography>
            ) : (
              <>
                {family ? <Typography variant="caption" color="text.secondary">Canonical family: {family}</Typography> : null}
                {running ? <LinearProgress /> : null}
                {state.error ? <Alert severity="error">{state.error}</Alert> : null}
                {state.phase === 'cancelled' ? <Alert severity="info">Aset computation cancelled.</Alert> : null}

                <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                  {state.cached ? <Chip size="small" color="success" label="cached" /> : null}
                  {state.emittedRecords > 0 ? <Chip size="small" label={`${state.emittedRecords.toLocaleString()} records`} /> : null}
                  {header ? <Chip size="small" variant="outlined" label={`${header.coherentTotal} coherent`} /> : null}
                  {header?.noncoherentTotal ? <Chip size="small" variant="outlined" label={`${header.noncoherentTotal} noncoherent`} /> : null}
                </Stack>

                {performanceData && !state.cached ? (
                  <Typography variant="caption" color="text.secondary">
                    worker {performanceData.totalWorkerComputeMs.toFixed(1)} ms · context {performanceData.modulusContextSetupMs.toFixed(1)} ms · CSP {performanceData.candidateCspEnumerationMs.toFixed(1)} ms · geometry {performanceData.geometryMs.toFixed(1)} ms · IndexedDB write {performanceData.indexedDbWriteMs.toFixed(1)} ms
                  </Typography>
                ) : null}
                {performanceData && state.cached ? (
                  <Typography variant="caption" color="text.secondary">IndexedDB family read {performanceData.indexedDbReadMs.toFixed(1)} ms</Typography>
                ) : null}

                {state.phase === 'complete' && header && state.records.length !== header.downsetTotal ? (
                  <Alert severity="warning">Aset records are still loading for visualization.</Alert>
                ) : null}
                {running ? <Button size="small" variant="outlined" onClick={cancel}>Cancel</Button> : null}
              </>
            )}
          </Stack>
        </CardContent>
      </Card>
      {viewerData ? <AsetsLegacyViewer data={viewerData} /> : null}
    </Stack>
  );
}
