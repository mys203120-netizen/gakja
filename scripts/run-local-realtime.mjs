import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', quiet: true });
if (process.env.NODE_ENV === 'production' ||
    process.env.INTERVIEW_EXECUTION_MODE && process.env.INTERVIEW_EXECUTION_MODE !== 'local-development') {
  throw new Error('LOCAL_COMPOSITION_UNAVAILABLE');
}
process.env.INTERVIEW_EXECUTION_MODE = 'local-development';
await import('../server/realtime.ts');
