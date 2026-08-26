import Box from '@mui/material/Box';
import BrowserApp from './BrowserApp';

export default function App() {
  return (
    <Box
      sx={{
        minHeight: '100dvh',
        overflowX: 'hidden',
        '& main > .MuiStack-root': {
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          scrollbarGutter: 'stable',
        },
        '& main > .MuiStack-root > *': {
          flexShrink: 0,
        },
        '@media (max-height: 720px)': {
          '& main': {
            height: 'auto',
            minHeight: 'calc(100dvh - 86px)',
          },
          '& main > .MuiStack-root': {
            overflowY: 'visible',
          },
          '& main > .MuiPaper-root': {
            minHeight: 420,
          },
        },
      }}
    >
      <BrowserApp />
    </Box>
  );
}
