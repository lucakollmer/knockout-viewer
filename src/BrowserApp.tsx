import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CssBaseline from '@mui/material/CssBaseline';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { emptyDirectValues, resolveDirectValues, type DirectField, type DirectValues } from './directInput';
import type { GroupRow } from './groupMath';

type NavigatorStatus = {
  computing: boolean;
  lastCompletedR: number | null;
  cacheHits: number;
  lastDurationMs: number | null;
  error: string | null;
  exactDone: boolean;
};

function useGroupNavigator(d: number, exactR?: number) {
  const [rows, setRows] = useState<GroupRow[]>([]);
  const [status, setStatus] = useState<NavigatorStatus>({
    computing: false,
    lastCompletedR: null,
    cacheHits: 0,
    lastDurationMs: null,
    error: null,
    exactDone: false,
  });
  const workerRef = useRef<Worker | null>(null);
  const runIdRef = useRef(0);
  const rowCountRef = useRef(0);

  useEffect(() => {
    workerRef.current?.terminate();
    const runId = ++runIdRef.current;
    rowCountRef.current = 0;
    setRows([]);
    setStatus({ computing: true, lastCompletedR: null, cacheHits: 0, lastDurationMs: null, error: null, exactDone: false });

    const worker = new Worker(new URL('./workers/groupNavigator.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (event) => {
      const message = event.data as Record<string, unknown>;
      if (message.runId !== runId) return;
      if (message.type === 'batch') {
        const incoming = message.rows as GroupRow[];
        setRows((previous) => {
          const next = previous.concat(incoming);
          rowCountRef.current = next.length;
          return next;
        });
        setStatus((previous) => ({
          ...previous,
          computing: false,
          lastCompletedR: message.r as number,
          cacheHits: previous.cacheHits + (message.cached ? 1 : 0),
          lastDurationMs: message.durationMs as number,
          exactDone: Boolean(message.done),
        }));
      } else if (message.type === 'progress') {
        setStatus((previous) => ({ ...previous, computing: Boolean(message.computing), exactDone: Boolean(message.done) }));
      } else if (message.type === 'error') {
        setStatus((previous) => ({ ...previous, computing: false, error: String(message.message) }));
      }
    };
    worker.postMessage({ type: 'start', runId, d, r: exactR, targetRows: 500 });
    return () => worker.terminate();
  }, [d, exactR]);

  const requestMore = useCallback(() => {
    if (exactR !== undefined || status.computing) return;
    workerRef.current?.postMessage({ type: 'more', runId: runIdRef.current, targetRows: rowCountRef.current + 750 });
  }, [exactR, status.computing]);

  return { rows, status, requestMore };
}

function GroupNotation({ row }: { row: GroupRow }) {
  const block = (residue: number, multiplicity: number) => (
    <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
      {residue}
      {multiplicity === 1 ? null : <Box component="sup" sx={{ fontSize: '0.72em', ml: 0.15 }}>{multiplicity}</Box>}
    </Box>
  );
  return (
    <Typography component="span" variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
      1/{row.r} ({block(row.a, row.n)}, {block(row.b, row.m)}, {block(row.c, row.k)})
    </Typography>
  );
}

function DirectSelector({ onOpen }: { onOpen: (row: GroupRow) => void }) {
  const [values, setValues] = useState<DirectValues>(() => emptyDirectValues());
  const resolution = useMemo(() => resolveDirectValues(values), [values]);
  const [canonical, setCanonical] = useState<GroupRow | null>(null);
  const [canonicalError, setCanonicalError] = useState<string | null>(null);

  useEffect(() => {
    setCanonical(null);
    setCanonicalError(null);
    if (!resolution.group) return;
    const worker = new Worker(new URL('./workers/directCanonicalize.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const message = event.data as { type: string; canonical?: GroupRow | null; message?: string };
      if (message.type === 'result') {
        setCanonical(message.canonical ?? null);
        setCanonicalError(message.canonical ? null : 'This presentation has trivial effective image.');
      } else if (message.type === 'error') {
        setCanonicalError(message.message ?? 'Canonicalization failed.');
      }
    };
    worker.postMessage({ type: 'canonicalize', requestId: 1, group: resolution.group });
    return () => worker.terminate();
  }, [resolution.group]);

  const setField = (field: DirectField, value: string) => {
    setValues((previous) => ({ ...previous, [field]: value.replace(/[^0-9-]/g, '') }));
  };

  const inferredText = Object.entries(resolution.inferred).map(([field, value]) => `${field}=${value}`).join(', ');

  const fieldRow = (names: DirectField[]) => (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 0.75 }}>
      {names.map((field) => (
        <TextField
          key={field}
          label={field}
          value={values[field]}
          placeholder={resolution.inferred[field] === undefined ? '—' : `auto ${resolution.inferred[field]}`}
          onChange={(event) => setField(field, event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && canonical) onOpen(canonical); }}
          size="small"
          fullWidth
        />
      ))}
    </Box>
  );

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.25}>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Direct selection</Typography>
            <Typography variant="caption" color="text.secondary">Enter three values in either row and leave the inferable fourth blank.</Typography>
          </Box>
          {fieldRow(['d', 'n', 'm', 'k'])}
          {fieldRow(['r', 'a', 'b', 'c'])}
          {inferredText ? <Typography variant="caption" sx={{ color: 'primary.main' }}>Inferred: {inferredText}</Typography> : null}
          {resolution.choice ? (
            <Box>
              <Typography variant="caption" color="text.secondary">{resolution.choice.reason}</Typography>
              <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                {resolution.choice.values.slice(0, 18).map((value) => (
                  <Chip key={value} size="small" label={`${resolution.choice?.field}=${value}`} onClick={() => setField(resolution.choice!.field, String(value))} />
                ))}
              </Stack>
            </Box>
          ) : null}
          {resolution.error || canonicalError ? <Alert severity="error">{resolution.error ?? canonicalError}</Alert> : null}
          {!resolution.error && resolution.hint ? <Alert severity="info">{resolution.hint}</Alert> : null}
          {canonical ? (
            <Paper variant="outlined" sx={{ p: 1.25, bgcolor: 'action.hover' }}>
              <Typography variant="caption" color="text.secondary">Canonical effective presentation</Typography>
              <Box sx={{ mt: 0.25 }}><GroupNotation row={canonical} /></Box>
            </Paper>
          ) : null}
          <Stack direction="row" spacing={1}>
            <Button variant="contained" disabled={!canonical} onClick={() => canonical && onOpen(canonical)} fullWidth>Open</Button>
            <Button variant="outlined" onClick={() => setValues(emptyDirectValues())}>Clear</Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

const ROW_HEIGHT = 42;
const OVERSCAN = 10;

function VirtualTable({ rows, selected, onSelect, onNeedMore }: {
  rows: GroupRow[];
  selected: GroupRow | null;
  onSelect: (row: GroupRow) => void;
  onNeedMore: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(500);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => setHeight(viewport.clientHeight || 500);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const selectedIndex = selected ? rows.findIndex((row) => row.id === selected.id) : -1;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || selectedIndex < 0) return;
    const top = selectedIndex * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < viewport.scrollTop || bottom > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTo({ top: Math.max(0, top - viewport.clientHeight / 3) });
    }
  }, [selectedIndex]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(start, end);
  const columns = { xs: 'minmax(0,1fr) 56px', md: 'minmax(240px,1fr) repeat(8,56px)' };

  const numberCell = (value: number, always = false) => (
    <Typography variant="body2" sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', display: always ? 'block' : { xs: 'none', md: 'block' } }}>
      {value}
    </Typography>
  );

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: columns, gap: 0.5, px: 1.25, py: 0.8, bgcolor: 'action.hover', borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="caption" sx={{ fontWeight: 700 }}>Group</Typography>
        {['d', 'r', 'n', 'm', 'k', 'a', 'b', 'c'].map((name, index) => (
          <Typography key={name} variant="caption" sx={{ fontWeight: 700, textAlign: 'right', display: index === 1 ? 'block' : { xs: 'none', md: 'block' } }}>{name}</Typography>
        ))}
      </Box>
      <Box
        ref={viewportRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          setScrollTop(element.scrollTop);
          if (element.scrollHeight - element.scrollTop - element.clientHeight < 1200) onNeedMore();
        }}
        sx={{ flex: 1, minHeight: 0, overflowY: 'auto', position: 'relative' }}
      >
        <Box sx={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          {visible.map((row, offset) => {
            const index = start + offset;
            const active = row.id === selected?.id;
            return (
              <Box
                key={row.id}
                tabIndex={0}
                onClick={() => onSelect(row)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(row); }}
                sx={{
                  position: 'absolute', top: index * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT,
                  display: 'grid', gridTemplateColumns: columns, gap: 0.5, alignItems: 'center', px: 1.25,
                  borderBottom: 1, borderColor: 'divider', bgcolor: active ? 'action.selected' : 'background.paper',
                  cursor: 'pointer', '&:hover': { bgcolor: active ? 'action.selected' : 'action.hover' },
                }}
              >
                <Box sx={{ minWidth: 0, overflow: 'hidden' }}><GroupNotation row={row} /></Box>
                {numberCell(row.d)}{numberCell(row.r, true)}{numberCell(row.n)}{numberCell(row.m)}
                {numberCell(row.k)}{numberCell(row.a)}{numberCell(row.b)}{numberCell(row.c)}
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

export default function BrowserApp() {
  const [dimension, setDimension] = useState(3);
  const [dimensionText, setDimensionText] = useState('3');
  const [exactR, setExactR] = useState<number | undefined>();
  const [modulusText, setModulusText] = useState('');
  const [selected, setSelected] = useState<GroupRow | null>(null);
  const { rows, status, requestMore } = useGroupNavigator(dimension, exactR);

  const applyDimension = () => {
    const parsed = Number(dimensionText);
    if (!Number.isSafeInteger(parsed) || parsed < 3) { setDimensionText(String(dimension)); return; }
    setDimension(parsed);
    setDimensionText(String(parsed));
    if (selected?.d !== parsed) setSelected(null);
  };

  const stepDimension = (delta: number) => {
    const next = Math.max(3, dimension + delta);
    setDimension(next);
    setDimensionText(String(next));
    setSelected(null);
  };

  const applyModulus = () => {
    if (!modulusText.trim()) { setExactR(undefined); return; }
    const parsed = Number(modulusText);
    if (!Number.isSafeInteger(parsed) || parsed < 2) { setModulusText(exactR === undefined ? '' : String(exactR)); return; }
    setExactR(parsed);
    setModulusText(String(parsed));
    if (selected?.d !== dimension || selected.r !== parsed) setSelected(null);
  };

  const openDirect = (row: GroupRow) => {
    setDimension(row.d);
    setDimensionText(String(row.d));
    setExactR(row.r);
    setModulusText(String(row.r));
    setSelected(row);
  };

  const selectedIndex = selected ? rows.findIndex((row) => row.id === selected.id) : -1;
  const selectOffset = (delta: number) => {
    if (!rows.length) return;
    const base = selectedIndex < 0 ? 0 : selectedIndex;
    setSelected(rows[Math.max(0, Math.min(rows.length - 1, base + delta))]);
  };

  return (
    <>
      <CssBaseline />
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
        <Box component="header" sx={{ px: { xs: 2, md: 3 }, py: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>Knockout group browser</Typography>
          <Typography variant="body2" color="text.secondary">Canonical effective cyclic SL three-block presentations, generated locally as you navigate.</Typography>
        </Box>
        <Box component="main" sx={{ p: { xs: 1.5, md: 2.5 }, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0,1fr) 390px' }, gap: 2, height: { lg: 'calc(100vh - 86px)' }, minHeight: 0 }}>
          <Paper variant="outlined" sx={{ minHeight: { xs: 560, lg: 0 }, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider' }}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', alignItems: { md: 'center' } }}>
                <Box>
                  <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Canonical groups</Typography>
                  <Typography variant="caption" color="text.secondary">Order: r, then k, m, n, a, b, c. Scroll to generate more.</Typography>
                </Box>
                <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 0.75, alignItems: 'center', justifyContent: { md: 'flex-end' } }}>
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    <Button variant="outlined" size="small" aria-label="Previous dimension" disabled={dimension <= 3} onClick={() => stepDimension(-1)} sx={{ minWidth: 34, px: 1 }}>−</Button>
                    <TextField
                      label="d"
                      value={dimensionText}
                      onChange={(event) => setDimensionText(event.target.value.replace(/\D/g, ''))}
                      onBlur={applyDimension}
                      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                      size="small"
                      sx={{ width: 88 }}
                      slotProps={{ htmlInput: { inputMode: 'numeric', 'aria-label': 'Dimension d' } }}
                    />
                    <Button variant="outlined" size="small" aria-label="Next dimension" onClick={() => stepDimension(1)} sx={{ minWidth: 34, px: 1 }}>+</Button>
                  </Stack>
                  <Chip size="small" label={`${rows.length.toLocaleString()} loaded`} />
                  <Chip size="small" variant="outlined" label={exactR === undefined ? (status.lastCompletedR ? `through r=${status.lastCompletedR}` : 'starting r=2') : `r=${exactR}`} />
                  {status.computing ? <Chip size="small" color="primary" label="generating…" /> : null}
                  {status.cacheHits ? <Chip size="small" variant="outlined" label={`${status.cacheHits} cached`} /> : null}
                </Stack>
              </Stack>
            </Box>
            {status.error ? <Alert severity="error">{status.error}</Alert> : null}
            <VirtualTable rows={rows} selected={selected} onSelect={setSelected} onNeedMore={requestMore} />
          </Paper>

          <Stack spacing={1.5} sx={{ minHeight: 0, overflowY: { lg: 'auto' } }}>
            <Card variant="outlined"><CardContent><Stack spacing={1.25}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Modulus</Typography>
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'flex-start' }}>
                <TextField label="Modulus r (optional)" value={modulusText} placeholder="All moduli" onChange={(event) => setModulusText(event.target.value.replace(/\D/g, ''))} onBlur={applyModulus} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} size="small" fullWidth />
                {exactR === undefined ? null : <Button variant="outlined" onClick={() => { setExactR(undefined); setModulusText(''); setSelected(null); }}>All</Button>}
              </Stack>
              {status.lastDurationMs !== null && status.lastDurationMs > 250 ? <Typography variant="caption" color="text.secondary">Last uncached batch: {(status.lastDurationMs / 1000).toFixed(2)} s</Typography> : null}
            </Stack></CardContent></Card>

            <Card variant="outlined"><CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Selected group</Typography>
              {selected ? <Stack spacing={1} sx={{ mt: 1 }}>
                <Paper variant="outlined" sx={{ p: 1.2, bgcolor: 'action.hover' }}><GroupNotation row={selected} /></Paper>
                <Typography variant="caption" color="text.secondary">d={selected.d}, r={selected.r}; n,m,k=({selected.n},{selected.m},{selected.k}); a,b,c=({selected.a},{selected.b},{selected.c})</Typography>
                <Stack direction="row" spacing={1}>
                  <Button variant="outlined" disabled={selectedIndex <= 0} onClick={() => selectOffset(-1)} fullWidth>Previous</Button>
                  <Button variant="outlined" disabled={selectedIndex < 0 || selectedIndex >= rows.length - 1} onClick={() => selectOffset(1)} fullWidth>Next</Button>
                </Stack>
              </Stack> : <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>Click a row or use direct selection.</Typography>}
            </CardContent></Card>

            <DirectSelector onOpen={openDirect} />
            <Typography variant="caption" color="text.secondary" sx={{ px: 0.5, pb: 1 }}>Enumeration runs entirely in your browser. Generated (d,r) batches are cached locally.</Typography>
          </Stack>
        </Box>
      </Box>
    </>
  );
}
