import { gradeSupabaseKeepalive } from '../../_lib/supabase-keepalive.mjs';

export default (ctx) => gradeSupabaseKeepalive(ctx, { variant: 'train' });
