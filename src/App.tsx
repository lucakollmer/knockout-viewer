import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CssBaseline,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
  createTheme,
  ThemeProvider,
  useMediaQuery,
} from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';
import RemoveRounded from '@mui/icons-material/RemoveRounded';
import ClearRounded from '@mui/icons-material/ClearRounded';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import ArrowForwardRounded from '@mui/icons-material/ArrowForwardRounded';
import OpenInBrowserRounded from '@mui/icons-material/OpenInBrowserRounded';
import { emptyDirectValues, resolveDirectValues, type DirectField, type DirectValues } from './directInput';
import { type GroupRow } from './groupMath';

const theme = createTheme({
  typography: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    h5: { fontWeight: 700, letterSpacing: '-0.02em' },
    subtitle1: { fontWeight: 600 },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiCard: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
  },
});

type NavigatorStatus = {
  computing: boolean;
  currentR: number | null;
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
    currentR: null,
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
    runIdRef.current += 1;
    const runId = runIdRef.current;
    rowCountRef.current = 0;
    setRows([]);
    setStatus({ computing: true, currentR: exactR ?? 2, lastCompletedR: null, cacheHits: 0, lastDurationMs: null, error: null, exactDone: false });

    const worker = new Worker(new URL('./workers/groupNavigator.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as Record<string, unknown>;
      if (message.runId !== runId) return;
      if (message.type === 'batch') {
        const batchRows = message.rows as GroupRow[];
        setRows((previous) => {
          const next = [...previous, ...batchRows];
          rowCountRef.current = next.length;
          return next;
        });
        setStatus((previous) => ({
          ...previous,
          computing: false,
          currentR: message.r as number,
          lastCompletedR: message.r as number,
          cacheHits: previous.cacheHits + (message.cached ? 1 : 0),
          lastDurationMs: message.durationMs as number,
          exactDone: Boolean(message.done),
        }));
      } else if (message.type === 'progress') {
        setStatus((previous) => ({
          ...previous,
          computing: Boolean(message.computing),
          currentR: message.r as number,
          exactDone: Boolean(message.done),
        }));
      } else if (message.type === 'error') {
        setStatus((previous) => ({ ...previous, computing: false, error: String(message.message) }));
      }
    };
    worker.postMessage({ type: 'start', runId, d, r: exactR, targetRows: 600 });
    return () => worker.terminate();
  }, [d, exactR]);

  const requestMore = useCallback(() => {
    if (exactR !== undefined || status.computing) return;
    workerRef.current?.postMessage({ type: 'more', runId: runIdRef.current, targetRows: rowCountRef.current + 900 });
  }, [exactR, status.computing]);

  return { rows, status, requestMore };
}

function GroupNotation({ row }: { row: GroupRow }) {
  const block = (residue: number, multiplicity: number) => (
    <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
      {residue}
      {multiplicity !== 1 ? <Box component="sup" sx={{ fontSize: '0.72em', ml: 0.15 }}>{multiplicity}</Box> : null}
    </Box>
  );
  return (
    <Typography component="span" variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 550 }}>
      1/{row.r} ({block(row.a, row.n)}, {block(row.b, row.m)}, {block(row.c, row.k)})
    </Typography>
  );
}

function IntegerField({
  label,
  value,
  onChange,
  placeholder,
  onEnter,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onEnter?: () => void;
}) {
  return (
    <TextField
      label={label}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value.replace(/[^0-9-]/g, ''))}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
          onEnter?.();
        }
      }}
      size="small"
      slotProps={{
        htmlInput: {
          inputMode: 'numeric',
          style: { textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
        },
      }}
      fullWidth
    />
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

    let worker: Worker | null = null;
    const timer = window.setTimeout(() => {
      worker = new Worker(new URL('./workers/directCanonicalize.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent) => {
        const message = event.data as { type: string; canonical?: GroupRow | null; message?: string };
        if (message.type === 'result') {
          setCanonical(message.canonical ?? null);
          setCanonicalError(message.canonical ? null : 'This presentation has trivial effective image.');
        } else if (message.type === 'error') {
          setCanonical(null);
          setCanonicalError(message.message ?? 'Canonicalization failed.');
        }
      };
      worker.postMessage({ type: 'canonicalize', requestId: 1, group: resolution.group });
    }, 80);

    return () => {
      window.clearTimeout(timer);
      worker?.terminate();
    };
  }, [resolution.group]);

  const setField = (field: DirectField, value: string) => setValues((previous) => ({ ...previous, [field]: value }));
  const choose = (field: DirectField, value: number) => setField(field, String(value));
  const inferredText = Object.entries(resolution.inferred)
    .map(([field, value]) => `${field}=${value}`)
    .join(', ');

  const renderFields = (fields: DirectField[]) => (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 0.75 }}>
      {fields.map((field) => (
        <IntegerField
          key={field}
          label={field}
          value={values[field]}
          placeholder={resolution.inferred[field] !== undefined ? `auto ${resolution.inferred[field]}` : '—'}
          onChange={(value) => setField(field, value)}
          onEnter={() => { if (canonical) onOpen(canonical); }}
        />
      ))}
    </Box>
  );

  return (
    <Card variant="outlined">
      <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
        <Stack spacing={1.5}>
          <Box>
            <Typography variant="subtitle1">Direct selection</Typography>
            <Typography variant="caption" color="text.secondary">Leave one value blank in either row when it can be inferred.</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.6 }}>Dimension and multiplicities</Typography>
            {renderFields(['d', 'n', 'm', 'k'])}
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.6 }}>Modulus and residues</Typography>
            {renderFields(['r', 'a', 'b', 'c'])}
          </Box>
          {inferredText ? <Typography variant="caption" color="primary.main">Inferred: {inferredText}</Typography> : null}
          {resolution.choice ? (
            <Box>
              <Typography variant="caption" color="text.secondary">{resolution.choice.reason}</Typography>
              <Stack direction="row" useFlexGap flexWrap="wrap" gap={0.6} sx={{ mt: 0.7 }}>
                {resolution.choice.values.slice(0, 18).map((value) => (
                  <Chip key={value} size="small" label={`${resolution.choice?.field}=${value}`} onClick={() => choose(resolution.choice!.field, value)} />
                ))}
                {resolution.choice.values.length > 18 ? <Chip size="small" variant="outlined" label={`+${resolution.choice.values.length - 18} more — enter one`} /> : null}
              </Stack>
            </Box>
          ) : null}
          {resolution.error || canonicalError ? <Alert severity="error" sx={{ py: 0 }}>{resolution.error ?? canonicalError}</Alert> : null}
          {!resolution.error && resolution.hint ? <Alert severity="info" sx={{ py: 0 }}>{resolution.hint}</Alert> : null}
          {canonical ? (
            <Paper variant="outlined" sx={{ p: 1.25, bgcolor: 'action.hover' }}>
              <Typography variant="caption" color="text.secondary">Canonical effective presentation</Typography>
              <Box sx={{ mt: 0.25 }}><GroupNotation row={canonical} /></Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.4 }}>d={canonical.d}, r={canonical.r}; C-first global ordering</Typography>
            </Paper>
          ) : null}
          <Stack direction="row" spacing={1}>
            <Button variant="contained" startIcon={<OpenInBrowserRounded />} disabled={!canonical} onClick={() => { if (canonical) onOpen(canonical); }} fullWidth>
              Open in browser
            </Button>
            <Tooltip title="Clear direct-selection fields">
              <IconButton onClick={() => setValues(emptyDirectValues())} aria-label="Clear direct selection"><ClearRounded /></IconButton>
            </Tooltip>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

const ROW_HEIGHT = 42;
const OVERSCAN = 12;

function VirtualGroupTable({
  rows,
  selectedId,
  onSelect,
  onRequestMore,
  compact,
}: {
  rows: GroupRow[];
  selectedId: string | undefined;
  onSelect: (row: GroupRow) => void;
  onRequestMore: () => void;
  compact: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(540);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => setViewportHeight(viewport.clientHeight || 540);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const index = rows.findIndex((row) => row.id === selectedId);
    const viewport = viewportRef.current;
    if (index < 0 || !viewport) return;
    const rowTop = index * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    if (rowTop < viewport.scrollTop || rowBottom > viewport.scrollTop + viewport.clientHeight) {
      const nextTop = Math.max(0, rowTop - Math.floor(viewport.clientHeight * 0.35));
      viewport.scrollTop = nextTop;
      setScrollTop(nextTop);
    }
  }, [rows, selectedId]);

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
  }, []);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const visibleRows = rows.slice(start, end);
  const gridColumns = compact ? 'minmax(190px, 1fr) 48px 54px' : 'minmax(230px, 1.45fr) repeat(8, minmax(44px, 0.35fr))';
  const headers = compact ? ['Group', 'd', 'r'] : ['Group', 'd', 'r', 'n', 'm', 'k', 'a', 'b', 'c'];

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const top = target.scrollTop;
    const remaining = target.scrollHeight - top - target.clientHeight;
    if (remaining < 1_800) onRequestMore();
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      setScrollTop(top);
    });
  };

  return (
    <Box sx={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: gridColumns,
          minHeight: 38,
          alignItems: 'center',
          px: 1.25,
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'action.hover',
          color: 'text.secondary',
        }}
      >
        {headers.map((header, index) => <Typography key={header} variant="caption" sx={{ textAlign: index === 0 ? 'left' : 'right', fontWeight: 600 }}>{header}</Typography>)}
      </Box>
      <Box
        ref={viewportRef}
        onScroll={handleScroll}
        sx={{
          overflow: 'auto',
          minHeight: 420,
          height: { xs: '58vh', lg: '100%' },
          position: 'relative',
          contain: 'strict',
          scrollbarGutter: 'stable',
        }}
      >
        <Box sx={{ height: rows.length * ROW_HEIGHT, minWidth: compact ? 300 : 760, position: 'relative' }}>
          {visibleRows.map((row, offset) => {
            const index = start + offset;
            const selected = row.id === selectedId;
            const values = compact
              ? [row.d, row.r]
              : [row.d, row.r, row.n, row.m, row.k, row.a, row.b, row.c];
            return (
              <Box
                key={row.id}
                role="button"
                tabIndex={0}
                aria-selected={selected}
                onClick={() => onSelect(row)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(row); }}
                sx={{
                  position: 'absolute',
                  top: index * ROW_HEIGHT,
                  left: 0,
                  right: 0,
                  height: ROW_HEIGHT,
                  display: 'grid',
                  gridTemplateColumns: gridColumns,
                  alignItems: 'center',
                  px: 1.25,
                  borderBottom: 1,
                  borderColor: 'divider',
                  bgcolor: selected ? 'action.selected' : 'background.paper',
                  cursor: 'pointer',
                  '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
                  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
                }}
              >
                <Box sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><GroupNotation row={row} /></Box>
                {values.map((value, valueIndex) => (
                  <Typography key={valueIndex} variant="body2" sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{value}</Typography>
                ))}
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

export default function App() {
  const [dimension, setDimension] = useState(3);
  const [dimensionText, setDimensionText] = useState('3');
  const [exactR, setExactR] = useState<number | undefined>(undefined);
  const [modulusText, setModulusText] = useState('');
  const [selected, setSelected] = useState<GroupRow | null>(null);
  const { rows, status, requestMore } = useGroupNavigator(dimension, exactR);
  const compact = useMediaQuery('(max-width:899px)');

  const commitDimension = useCallback((text = dimensionText) => {
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed < 3) {
      setDimensionText(String(dimension));
      return;
    }
    setDimension(parsed);
    setDimensionText(String(parsed));
    if (selected?.d !== parsed) setSelected(null);
  }, [dimension, dimensionText, selected]);

  const stepDimension = (delta: number) => {
    const next = Math.max(3, dimension + delta);
    setDimension(next);
    setDimensionText(String(next));
    if (selected?.d !== next) setSelected(null);
  };

  const commitModulus = useCallback((text = modulusText) => {
    if (!text.trim()) {
      setExactR(undefined);
      setModulusText('');
      return;
    }
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed < 2) {
      setModulusText(exactR ? String(exactR) : '');
      return;
    }
    setExactR(parsed);
    setModulusText(String(parsed));
    if (selected?.r !== parsed || selected.d !== dimension) setSelected(null);
  }, [dimension, exactR, modulusText, selected]);

  const openDirect = useCallback((row: GroupRow) => {
    setDimension(row.d);
    setDimensionText(String(row.d));
    setExactR(row.r);
    setModulusText(String(row.r));
    setSelected(row);
  }, []);

  const selectedIndex = selected ? rows.findIndex((row) => row.id === selected.id) : -1;
  const selectOffset = (delta: number) => {
    if (rows.length === 0) return;
    const base = selectedIndex >= 0 ? selectedIndex : 0;
    const next = Math.min(rows.length - 1, Math.max(0, base + delta));
    setSelected(rows[next]);
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
        <Box component="header" sx={{ px: { xs: 2, md: 3 }, py: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="h5">Knockout group browser</Typography>
          <Typography variant="body2" color="text.secondary">Canonical effective cyclic SL three-block presentations, generated locally as you navigate.</Typography>
        </Box>
        <Box
          component="main"
          sx={{
            p: { xs: 1.5, md: 2.5 },
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 390px' },
            gap: 2,
            height: { lg: 'calc(100vh - 86px)' },
            minHeight: 0,
          }}
        >
          <Paper variant="outlined" sx={{ minHeight: { xs: 560, lg: 0 }, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ px: 1.5, py: 1.1, borderBottom: 1, borderColor: 'divider' }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} justifyContent="space-between" spacing={1}>
                <Box>
                  <Typography variant="subtitle1">Canonical groups</Typography>
                  <Typography variant="caption" color="text.secondary">Order: r, then k, m, n, a, b, c. Scroll to generate more.</Typography>
                </Box>
                <Stack direction="row" spacing={0.75} alignItems="center" useFlexGap flexWrap="wrap">
                  <Chip size="small" label={`${rows.length.toLocaleString()} loaded`} />
                  {exactR === undefined
                    ? <Chip size="small" variant="outlined" label={status.lastCompletedR ? `through r=${status.lastCompletedR}` : 'starting at r=2'} />
                    : <Chip size="small" variant="outlined" label={`r=${exactR}${status.exactDone ? ' complete' : ''}`} />}
                  {status.cacheHits > 0 ? <Chip size="small" variant="outlined" label={`${status.cacheHits} cached`} /> : null}
                </Stack>
              </Stack>
            </Box>
            {status.computing ? <LinearProgress /> : null}
            {status.error ? <Alert severity="error" sx={{ borderRadius: 0 }}>{status.error}</Alert> : null}
            <VirtualGroupTable rows={rows} selectedId={selected?.id} onSelect={setSelected} onRequestMore={requestMore} compact={compact} />
          </Paper>

          <Stack spacing={1.5} sx={{ minHeight: 0, overflowY: { lg: 'auto' }, pr: { lg: 0.5 } }}>
            <Card variant="outlined">
              <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                <Stack spacing={1.5}>
                  <Box>
                    <Typography variant="subtitle1">Browse</Typography>
                    <Typography variant="caption" color="text.secondary">Choose a dimension; leave r blank for continuous enumeration.</Typography>
                  </Box>
                  <Stack direction="row" spacing={0.75} alignItems="center">
                    <Tooltip title="Previous dimension"><span><IconButton size="small" onClick={() => stepDimension(-1)} disabled={dimension <= 3}><RemoveRounded /></IconButton></span></Tooltip>
                    <TextField
                      label="Dimension d"
                      size="small"
                      value={dimensionText}
                      onChange={(event) => setDimensionText(event.target.value.replace(/\D/g, ''))}
                      onBlur={() => commitDimension()}
                      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                      slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                      fullWidth
                    />
                    <Tooltip title="Next dimension"><IconButton size="small" onClick={() => stepDimension(1)}><AddRounded /></IconButton></Tooltip>
                  </Stack>
                  <Stack direction="row" spacing={0.75} alignItems="flex-start">
                    <TextField
                      label="Modulus r (optional)"
                      size="small"
                      value={modulusText}
                      placeholder="All moduli"
                      onChange={(event) => setModulusText(event.target.value.replace(/\D/g, ''))}
                      onBlur={() => commitModulus()}
                      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                      slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                      helperText="Enter r to jump directly to one modulus; clear it to browse continuously."
                      fullWidth
                    />
                    {exactR !== undefined ? <Tooltip title="Browse all moduli"><IconButton size="small" sx={{ mt: 0.5 }} onClick={() => { setModulusText(''); setExactR(undefined); }} aria-label="Browse all moduli"><ClearRounded fontSize="small" /></IconButton></Tooltip> : null}
                  </Stack>
                  {status.lastDurationMs !== null && status.lastDurationMs > 250 ? <Typography variant="caption" color="text.secondary">Last uncached batch: {(status.lastDurationMs / 1000).toFixed(2)} s</Typography> : null}
                </Stack>
              </CardContent>
            </Card>

            <Card variant="outlined">
              <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                <Typography variant="subtitle1">Selected group</Typography>
                {selected ? (
                  <Stack spacing={1.1} sx={{ mt: 1 }}>
                    <Paper variant="outlined" sx={{ p: 1.25, bgcolor: 'action.hover' }}><GroupNotation row={selected} /></Paper>
                    <Typography variant="caption" color="text.secondary">d={selected.d}, r={selected.r}; n,m,k=({selected.n},{selected.m},{selected.k}); a,b,c=({selected.a},{selected.b},{selected.c})</Typography>
                    <Stack direction="row" spacing={1}>
                      <Button size="small" variant="outlined" startIcon={<ArrowBackRounded />} disabled={selectedIndex <= 0} onClick={() => selectOffset(-1)} fullWidth>Previous</Button>
                      <Button size="small" variant="outlined" endIcon={<ArrowForwardRounded />} disabled={selectedIndex < 0 || selectedIndex >= rows.length - 1} onClick={() => selectOffset(1)} fullWidth>Next</Button>
                    </Stack>
                  </Stack>
                ) : <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>Click a row or use direct selection.</Typography>}
              </CardContent>
            </Card>

            <DirectSelector onOpen={openDirect} />
            <Box sx={{ px: 0.5, pb: 1 }}>
              <Typography variant="caption" color="text.secondary">Enumeration runs entirely in your browser. Generated (d,r) batches are cached locally on this device.</Typography>
            </Box>
          </Stack>
        </Box>
      </Box>
    </ThemeProvider>
  );
}
