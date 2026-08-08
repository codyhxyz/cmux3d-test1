// GET /prepare — the one /invocations call that materialises /mnt/workspace and returns the
// face -> terminal_id map. Every face blocks on it; no shell may open before it answers.
import { cloudRoute } from '../lib/cloud.js';

export const onRequest = cloudRoute('prepare');
