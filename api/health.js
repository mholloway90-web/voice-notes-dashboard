// Temporary diagnostic: which password settings this build can see.
// Shows only whether each is set and its length, never the value.
export default function handler(req, res) {
  const info = (v) => (v == null ? 'not set' : `set, ${String(v).trim().length} characters` + (String(v) !== String(v).trim() ? ' (had extra spaces)' : ''));
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    build: (process.env.VERCEL_GIT_COMMIT_SHA || 'unknown').slice(0, 7),
    environment: process.env.VERCEL_ENV || 'unknown',
    DASHBOARD_PASSWORD: info(process.env.DASHBOARD_PASSWORD),
    DASHBOARD_PASSWORD1: info(process.env.DASHBOARD_PASSWORD1)
  });
}
