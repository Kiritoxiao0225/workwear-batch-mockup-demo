export type WorkerScope = 'main' | 'external';
export function workerScope(value?:string):WorkerScope;
export function claimNextTask(owner:string,scope:WorkerScope):Promise<{id:string;workspace:string;kind:string;payload:Record<string,unknown>}|null>;
export function expireTasks(scope:WorkerScope):Promise<{rows:Record<string,unknown>[]} >;
export function startBatchWorker(options?:{scope?:WorkerScope;concurrency?:number;admission?:import('./resource-guard.mjs').AdmissionGate}): Promise<{status():{ready:boolean;running:number;scope:WorkerScope;concurrency:number;automaticWpsSync:boolean;admission:import('./resource-guard.mjs').AdmissionStatus};close():Promise<void>}>;
