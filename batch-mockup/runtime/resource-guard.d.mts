export type AdmissionStatus = { paused: boolean; reason: string | null; rssMiB?: number; availableMiB?: number; reserveMiB?: number; rssPauseMiB?: number };
export type AdmissionGate = { check(): AdmissionStatus; status(): AdmissionStatus };
export function createAdmissionGate(options?: { sample?: () => { available: number; total: number; rss: number }; draining?: () => boolean; rssMiB?: number; reserveMiB?: number }): AdmissionGate;
export function systemMemory(): { available: number; total: number };
