import { fileURLToPath } from 'node:url';

export const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
