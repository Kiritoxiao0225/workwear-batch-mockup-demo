import sharp from 'sharp';

/**
 * Uploads are only ever png/jpeg/webp, yet sharp hands any SVG bytes to librsvg before a format
 * check can run. Blocking the loader keeps that parser away from user input for the whole process.
 * Imported once at start-up by the web server (instrumentation.ts) and by each worker entry; the
 * server itself never renders SVG through sharp.
 */
export const BLOCKED_SHARP_OPERATIONS = ['VipsForeignLoadSvg'];

sharp.block({ operation: BLOCKED_SHARP_OPERATIONS });
