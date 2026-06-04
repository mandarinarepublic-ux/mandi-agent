// api/status.js
// Endpoint de estado — para verificar que el agente está vivo

import { getSessionStats } from '../lib/sessions.js';

export default function handler(req, res) {
  const stats = getSessionStats();

  return res.status(200).json({
    status: 'online',
    agent: 'MANDI v2.0 — Mandarina Republic',
    timestamp: new Date().toISOString(),
    shopify: !!process.env.SHOPIFY_STORE_DOMAIN ? 'connected' : 'not configured',
    anthropic: !!process.env.ANTHROPIC_API_KEY ? 'connected' : 'not configured',
    sessions: stats
  });
}
