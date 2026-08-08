// GET /mint?shellId=face-1 — one presigned WebSocket URL, good for 300 seconds, for one
// shell in one session on the one runtime this deployment is configured for.
import { cloudRoute } from '../lib/cloud.js';

export const onRequest = cloudRoute('mint');
