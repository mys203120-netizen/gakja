export async function register(){
  if(process.env.NEXT_RUNTIME==='nodejs'){
    const {startInterviewRealtimeMaintenance}=await import('./lib/realtime-interview-maintenance');
    startInterviewRealtimeMaintenance();
  }
}
