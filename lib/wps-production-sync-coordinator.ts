export type SyncCoordinatorResult<S, W> = { state: S; wps: W };

/**
 * Keeps the slow independent reads independent. A state snapshot is accepted as soon
 * as it arrives; the WPS branch only controls live-record UI. Older/cancelled calls
 * cannot publish because every callback receives the owning token.
 */
export async function coordinateProductionSync<S, W>(input: {
  signal: AbortSignal;
  isCurrent: () => boolean;
  readState: () => Promise<S>;
  readWps: () => Promise<W>;
  onState: (state: S) => void;
}): Promise<SyncCoordinatorResult<S, W>> {
  // A synchronous reader failure must not prevent the other read from starting.
  const statePromise = Promise.resolve().then(input.readState).then(state => {
    if (!input.signal.aborted && input.isCurrent()) {
      input.onState(state);
    }
    return state;
  });
  const wpsPromise = Promise.resolve().then(input.readWps);
  const [stateResult, wpsResult] = await Promise.allSettled([statePromise, wpsPromise]);
  // Preserve the actual timeout/abort reason for the existing UI error contract.
  if (input.signal.aborted) throw input.signal.reason;
  if (wpsResult.status === 'rejected') throw wpsResult.reason;
  if (stateResult.status === 'rejected') throw stateResult.reason;
  return { state: stateResult.value, wps: wpsResult.value };
}
