import { getImage } from '../../../../../http/handlers';
export const runtime = 'nodejs';
export async function GET(request: Request, context: {
    params: Promise<{
        id: string;
    }>;
}) { return getImage(request, (await context.params).id); }
