import { createApi } from './api.js';
import { init } from './app.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const api = await createApi(SUPABASE_URL, SUPABASE_ANON_KEY);
init(api, document);
