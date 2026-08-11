export default function handler(req, res) {
  const names = Object.keys(process.env)
    .filter((n) => n.toUpperCase().includes('SUPABASE'))
    .sort();

  const report = names.map((name) => {
    const value = process.env[name] || '';
    const exposedToBrowser = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_)/.test(name);

    let role = 'unknown';
    if (!value) {
      role = 'EMPTY';
    } else if (value.startsWith('sb_secret_')) {
      role = 'new-style secret key';
    } else if (value.startsWith('sb_publishable_')) {
      role = 'new-style publishable key';
    } else if (value.startsWith('http')) {
      role = 'url (not a key)';
    } else {
      const parts = value.split('.');
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(
            Buffer.from(parts[1], 'base64').toString('utf8')
          );
          role = payload.role || 'jwt with no role claim';
        } catch {
          role = 'jwt payload unreadable';
        }
      } else {
        role = 'not a jwt';
      }
    }

    return { name, exposedToBrowser, role, length: value.length };
  });

  res.status(200).json({ count: report.length, supabaseEnvVars: report });
}
