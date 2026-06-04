// api/session.js
// Gestión de sesiones: ver y limpiar

import { getSession, clearSession, getSessionStats } from '../lib/sessions.js';

function isAuthorized(req) {
  const key = req.headers['x-mandi-key'] || req.headers['authorization']?.replace('Bearer ', '');
  return key === process.env.MANDI_API_KEY;
}

export default function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // GET — ver stats de sesiones
  if (req.method === 'GET') {
    return res.status(200).json(getSessionStats());
  }

  // DELETE — limpiar sesión de un teléfono
  if (req.method === 'DELETE') {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Falta phone' });
    clearSession(phone);
    return res.status(200).json({ cleared: phone });
  }

  // POST — ver historial de una sesión
  if (req.method === 'POST') {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Falta phone' });
    const session = getSession(phone);
    return res.status(200).json({
      phone,
      turns: Math.floor(session.messages.length / 2),
      meta: session.meta,
      history: session.messages
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
