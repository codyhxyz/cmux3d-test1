// GET /session — what runtime this is and which session the caller lands in.
// Also the probe resolveCloudBase() uses to decide that this origin is the minter.
import { cloudRoute } from '../lib/cloud.js';

export const onRequest = cloudRoute('session');
