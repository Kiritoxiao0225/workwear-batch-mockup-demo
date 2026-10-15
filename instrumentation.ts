/** Runs once when the server process starts, before any request. */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./lib/server/sharp-policy');
}
