import { WorkbenchClient } from '@/components/workbench-client';

type WorkbenchPageProps = {
  searchParams: Promise<{ taskId?: string }>;
};

export default async function WorkbenchPage({ searchParams }: WorkbenchPageProps) {
  const params = await searchParams;
  return <WorkbenchClient requestedTaskId={params.taskId ?? null} />;
}
