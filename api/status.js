// api/status.js
// Endpoint de estado — para verificar que el agente está vivo

export default function handler(req, res) {
  // `sessions` ya no se reporta: contaba las sesiones del `Map` en RAM, y en
  // serverless ese número era por instancia — decía "0 sesiones" con el bot
  // conversando, o "3" cuando había cientos. Un dato que engaña es peor que ninguno.
  //
  // En su lugar se reporta si la memoria REAL está conectada. Esta es la lámpara que
  // faltaba: el proyecto tenía KV/Redis configurado hace semanas sin que una sola
  // línea de código lo usara, y no había forma de notarlo desde afuera.
  const memoriaOk = !!(process.env.SUPABASE_URL
    && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY));

  return res.status(200).json({
    status: 'online',
    agent: 'MANDI v2.0 — Mandarina Republic',
    timestamp: new Date().toISOString(),
    shopify: !!process.env.SHOPIFY_STORE_DOMAIN ? 'connected' : 'not configured',
    anthropic: !!process.env.ANTHROPIC_API_KEY ? 'connected' : 'not configured',
    memoria: memoriaOk ? 'supabase:inbox.mensajes' : 'NO CONFIGURADA (MANDI responderá sin memoria)'
  });
}
