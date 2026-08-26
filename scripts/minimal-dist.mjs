import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await writeFile('dist/index.html', '<!doctype html><meta charset="utf-8"><title>Diagnostic pass</title><p>Diagnostic stage passed.</p>', 'utf8');
