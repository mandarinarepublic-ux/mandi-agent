// api/session.js
// Ver el hilo que MANDI está usando como memoria, para depurar.
//
// Antes esto leía el `Map` en RAM de `lib/sessions.js`. Ese Map se borró: era la
// causa de que MANDI no recordara nada (en serverless cada invocación puede caer en
// otra instancia, así que llegaba vacío). Ahora este endpoint lee exactamente lo
// mismo que lee el agente, así que sirve para ver qué está viendo MANDI de verdad.
//
// Junto con el Map se fueron dos cosas:
//   · `meta` ({name, source, lastReply}) — lo escribía el agente y lo leía SOLO este
//     endpoint; nada más en este repo ni en los inbox ni en el CRM lo consultaba.
//   · DELETE (limpiar la sesión) — ya no hay nada por proceso que limpiar. El
//     historial vive en el inbox y ahí no se borra desde acá. Para arrancar un turno
//     sin memoria sigue estando `reset_session` en /api/agent.

import { getConversacion } from '../lib/conversacion.js';

function isAuthorized(req) {
  const key = req.headers['x-mandi-key'] || req.headers['authorization']?.replace('Bearer ', '');
  const esperada = process.env.MANDI_API_KEY;
  // Falla CERRADO: antes, sin MANDI_API_KEY configurada, `undefined === undefined`
  // dejaba pasar a cualquiera — y acá se sirven conversaciones de clientes reales.
  if (!key || !esperada) return false;
  return key === esperada;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // POST — ver el historial que el agente usaría para este teléfono
  if (req.method === 'POST') {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Falta phone' });
    const history = await getConversacion(phone, 10);
    return res.status(200).json({
      phone,
      fuente: 'supabase:inbox.mensajes(cuenta=MANDI)',
      turns: Math.floor(history.length / 2),
      history
    });
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    return res.status(410).json({
      error: 'Ya no existen sesiones en memoria',
      detalle: 'La memoria de MANDI vive en el inbox (Supabase). Usa POST con {phone} para ver el hilo.'
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
