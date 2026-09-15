export function startBatchWorker(): Promise<{status():{ready:boolean;running:number};close():Promise<void>}>;
