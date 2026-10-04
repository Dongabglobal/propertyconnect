import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

export function checkPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

export function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

// Express middleware: reads "Authorization: Bearer <token>", attaches req.userId / req.userRole
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    req.userRole = payload.role;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }
}
