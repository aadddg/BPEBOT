import { createSso } from '@/lib/sso';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ action: string }> };
export async function GET(request: Request, context: Context) {
  const { action } = await context.params;
  try {
    if (action === 'start') return createSso().start();
    if (action === 'callback') return await createSso().callback(request);
    return new Response(null, { status: 404 });
  } catch { return Response.json({ error: 'Platform SSO is not configured or unavailable.' }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
}
export async function POST(request: Request, context: Context) {
  if ((await context.params).action !== 'logout') return new Response(null, { status: 404 });
  try { return await createSso().logout(request); }
  catch { return Response.json({ error: 'Platform SSO is unavailable.' }, { status: 503 }); }
}
