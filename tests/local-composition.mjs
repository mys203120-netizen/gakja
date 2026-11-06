// The existing regression suite exercises the explicit single-owner local
// composition. Service-boundary tests select service mode independently.
if (process.env.INTERVIEW_EXECUTION_MODE === undefined) {
  process.env.INTERVIEW_EXECUTION_MODE = 'local-development';
}
