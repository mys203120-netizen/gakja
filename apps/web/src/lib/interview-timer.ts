// A short server lease bounds elapsed time even if a browser disappears offline.
export const INTERVIEW_LEASE_MS = 30_000;
export type InterviewTimer = {elapsedMs?: number; activeSince?: number | null; timerLeaseUntil?: number | null; paused?: boolean};
export function stoppedInterviewTimer(data: InterviewTimer, now = Date.now()) {
  const end = data.timerLeaseUntil == null ? Number(data.activeSince || now) : Math.min(now, data.timerLeaseUntil);
  return {elapsedMs: Number(data.elapsedMs || 0) + (!data.paused && data.activeSince != null ? Math.max(0, end - data.activeSince) : 0), activeSince: null, timerLeaseUntil: null};
}
export function settledInterviewTimer(data: InterviewTimer, now = Date.now()) {
  // Legacy sessions have no presence evidence: preserve saved time, not days of absence.
  if (!data.paused && data.activeSince != null && data.timerLeaseUntil == null) return {elapsedMs:Number(data.elapsedMs||0),activeSince:null,timerLeaseUntil:null,paused:true};
  return !data.paused && data.timerLeaseUntil != null && now >= data.timerLeaseUntil
    ? {...stoppedInterviewTimer(data, now), paused: true}
    : data;
}
export function renewInterviewTimer(data: InterviewTimer, now = Date.now()) {
  const settled = settledInterviewTimer(data, now);
  return settled.paused ? settled : {...settled, timerLeaseUntil: now + INTERVIEW_LEASE_MS};
}
