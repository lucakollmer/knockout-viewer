import Box from '@mui/material/Box';
import AsetsBenchmarkPage from './AsetsBenchmarkPage';
import BrowserApp from './BrowserApp';

export default function App() {
  if (new URLSearchParams(window.location.search).get('benchmark') === 'asets') {
    return <AsetsBenchmarkPage />;
  }

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        overflowX: 'hidden',
        '& main > .MuiBox-root:first-child': {
          gap: 0,
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          overflow: 'hidden',
          bgcolor: 'background.paper',
        },
        '& main > .MuiBox-root:first-child > .MuiPaper-root': {
          border: 0,
          borderRadius: 0,
          boxShadow: 'none',
        },
        '& main > .MuiBox-root:first-child > .MuiPaper-root + .MuiPaper-root': {
          borderTop: 1,
          borderColor: 'divider',
        },
        '@media (min-width: 1200px)': {
          '& main > .MuiBox-root:first-child > .MuiPaper-root + .MuiPaper-root': {
            borderTop: 0,
            borderLeft: 1,
            borderColor: 'divider',
          },
        },
        '@media (min-width: 1536px)': {
          '& main': {
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
            alignItems: 'start',
          },
          '& main > .MuiBox-root': {
            minWidth: 0,
          },
        },
      }}
    >
      <BrowserApp />
    </Box>
  );
}
