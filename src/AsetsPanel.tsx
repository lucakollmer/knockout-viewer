import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
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
};

const EMPTY_STATE: PanelState = {
  phase: 'idle',
  familyKey: null,
  emittedRecords: 0,
  header: null,
  cached: false,
  error: null,
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
  const [state, setState] = useState<PanelState>(EMPTY_STATE);

  useEffect(() => {
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
          emittedRecords: message.emittedRecords,
          error: null,
        }));
      } else if (message.type === 'chunk') {
        setState((previous) => ({
          ...previous,
          familyKey: message.familyKey,
          emittedRecords: previous.emittedRecords + message.records.length,
          cached: message.cached,
        }));
      } else if (message.type === 'complete') {
        setState({
          phase: 'complete',
          familyKey: message.familyKey,
          emittedRecords: message.header.downsetTotal,
          header: message.header,
          cached: message.cached,
          error: null,
        });
      } else if (message.type === 'cancelled') {
        setState((previous) => ({ ...previous, phase: 'cancelled' }));
      } else if (message.type === 'error') {
        setState((previous) => ({ ...previous, phase: 'error', error: message.message }));
      }
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const requestId = ++requestIdRef.current;
    if (!selected) {
      const cancel: AsetsWorkerRequest = { type: 'cancel' };
      worker.postMessage(cancel);
      setState(EMPTY_STATE);
      return;
    }
    setState({ ...EMPTY_STATE, phase: 'cache' });
    const request: AsetsWorkerRequest = {
      type: 'compute',
      requestId,
      r: selected.r,
      residues: [selected.a, selected.b, selected.c],
      groupId: selected.id,
    };
    worker.postMessage(request);
  }, [selected]);

  const cancel = () => {
    const worker = workerRef.current;
    if (!worker || state.phase === 'idle' || state.phase === 'complete') return;
    const request: AsetsWorkerRequest = { type: 'cancel', requestId: requestIdRef.current };
    worker.postMessage(request);
    setState((previous) => ({ ...previous, phase: 'cancelling' }));
  };

  return { state, cancel };
}

export default function AsetsPanel({ selected }: { selected: GroupRow | null }) {
  const { state, cancel } = useAsetsFamily(selected);
  const running = ['cache', 'context', 'compute', 'finalize', 'cancelling'].includes(state.phase);
  const header = state.header;
  const performanceData = header?.performance;
  const family = state.familyKey ? `r=${state.familyKey[1]} · (${state.familyKey.slice(2).join(', ')})` : null;

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1}>
          <Stack direction="row" useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 0.75 }}>
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Asets</Typography>
              <Typography variant="caption" color="text.secondary">Exact portable family engine · local worker/cache</Typography>
            </Box>
            {selected ? <Chip size="small" variant="outlined" label={phaseLabel(state.phase)} /> : null}
          </Stack>

          {!selected ? (
            <Typography variant="body2" color="text.secondary">Select a group to load or compute its canonical Aset family.</Typography>
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

              {header?.normalizedResultDigest ? (
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                  digest {header.normalizedResultDigest.slice(0, 16)}…
                </Typography>
              ) : null}

              {performanceData && !state.cached ? (
                <Typography variant="caption" color="text.secondary">
                  worker {performanceData.totalWorkerComputeMs.toFixed(0)} ms · context {performanceData.modulusContextSetupMs.toFixed(0)} ms · CSP {performanceData.candidateCspEnumerationMs.toFixed(0)} ms · geometry {performanceData.geometryMs.toFixed(0)} ms
                </Typography>
              ) : null}
              {performanceData && state.cached ? (
                <Typography variant="caption" color="text.secondary">IndexedDB read {performanceData.indexedDbReadMs.toFixed(1)} ms</Typography>
              ) : null}

              {running ? <Button size="small" variant="outlined" onClick={cancel}>Cancel</Button> : null}
            </>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
