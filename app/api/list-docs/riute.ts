// app/api/list-docs/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function env(n: string) {
  const v = process.env[n];
  if (!v) throw new Error(`ENV ${n} is missing`);
  return v;
}
const supabase = createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

export async function GET() {
  const { data, error } = await supabase.from('documents').select('id').order('created_at', { ascending: false });
  if (error) return NextResponse.json({ ids: [], error: error.message }, { status: 500 });
  return NextResponse.json({ ids: (data || []).map((d) => d.id) });
}
