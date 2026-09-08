import { after } from 'next/server';
import { GET as readProduction, POST as saveProduction } from '@/lib/server/wps-production-actions';
import { usesProductionCloud } from '@/lib/server/production-storage';
import { finishProductionSave } from '@/lib/server/production-post-save';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request?: Request) {
  const response = await readProduction(request);
  if (response.ok && usesProductionCloud()) after(() => finishProductionSave());
  return response;
}

export async function POST(request: Request) {
  const copy = usesProductionCloud() ? request.clone() : null;
  const response = await saveProduction(request);
  if (response.ok && copy) {
    const body = await copy.json();
    after(() => finishProductionSave(body));
  }
  return response;
}
