/** Runs once when the server process starts, before any request. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  await import('./lib/server/sharp-policy');
  // Requests last as long as their own timeout says, not Node fetch's 300 s (long-request.ts).
  (await import('./lib/server/long-request')).installLongRequests();
}
