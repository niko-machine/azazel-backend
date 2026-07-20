const supabase = require('./supabase');

// Verifies the Bearer token against Supabase Auth and attaches req.userId.
// Works regardless of whether the client used to create it holds the anon
// or service_role key — auth.getUser() validates the token itself, not the
// client's own credentials.
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'missing token' });
  }

  const token = authHeader.replace('Bearer ', '');
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return res.status(401).json({ error: 'invalid token' });
  }

  req.userId = data.user.id;
  next();
}

module.exports = requireAuth;
