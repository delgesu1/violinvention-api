const { createClient } = require('@supabase/supabase-js');

// Get Supabase configuration from environment variables
const supabaseUrl = process.env.SUPABASE_URL || 'https://kjasupumfueszswakasl.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY; // We'll need the service key for backend verification

if (!supabaseUrl) {
  throw new Error('SUPABASE_URL is required');
}

if (!supabaseServiceKey) {
  console.warn('SUPABASE_SERVICE_KEY is not set - using anon key as fallback (not recommended for production)');
}

// Create Supabase client with service role key for backend operations
const supabase = createClient(
  supabaseUrl,
  supabaseServiceKey || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqYXN1cHVtZnVlc3pzd2FrYXNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU1ODMwNDQsImV4cCI6MjA3MTE1OTA0NH0.3tRkmm_XIsE-dT086cDQBLa2yG6BopBYG-44nwqPIes',
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

module.exports = {
  supabase,
  supabaseUrl,
};