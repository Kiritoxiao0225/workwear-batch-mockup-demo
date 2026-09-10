/** Unknown/failed jobs stay visible but do not spin a fast poll forever. */
export function artworkPollDelay(jobs: { status: string }[], hidden: boolean) {
  const running = jobs.some(job => ['queued', 'running', 'saving'].includes(job.status));
  return hidden ? running ? 15_000 : 60_000 : running ? 2500 : 30_000;
}
