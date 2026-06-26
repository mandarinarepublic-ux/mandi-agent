// lib/sessions.js
// Gestión de sesiones en memoria (por número de teléfono)
// En producción puedes migrar esto a Redis o Google Sheets

const sessions = new Map();
const SESSION_TTL = 4 * 60 * 60 * 1000; // 4 horas en ms
// Bajado de 20 a 10: en ventas por WhatsApp casi nunca se necesitan más de
// 10 turnos de contexto, y cada turno extra se reenvía COMPLETO en cada
// mensaje siguiente — menos turnos = menos tokens de entrada en conversaciones largas.
const MAX_TURNS = 10; // máx turnos por sesión antes de resumir

export function getSession(phone) {
  const session = sessions.get(phone);
  if (!session) return { messages: [], meta: {} };

  // Limpiar si expiró
  if (Date.now() - session.lastActivity > SESSION_TTL) {
    sessions.delete(phone);
    return { messages: [], meta: {} };
  }

  return session;
}

export function saveSession(phone, messages, meta = {}) {
  const existing = sessions.get(phone) || { meta: {} };
  sessions.set(phone, {
    messages: trimHistory(messages),
    meta: { ...existing.meta, ...meta },
    lastActivity: Date.now()
  });
}

export function clearSession(phone) {
  sessions.delete(phone);
}

export function getSessionStats() {
  return {
    activeSessions: sessions.size,
    phones: [...sessions.keys()].map(p => p.slice(-4)) // últimos 4 dígitos por privacidad
  };
}

// Mantener historial manejable — guardar últimos MAX_TURNS turnos
function trimHistory(messages) {
  if (messages.length <= MAX_TURNS * 2) return messages;
  // Siempre conservar el primer mensaje (contexto inicial del cliente)
  const first = messages.slice(0, 2);
  const recent = messages.slice(-(MAX_TURNS * 2 - 2));
  return [...first, ...recent];
}

// Limpiar sesiones expiradas periódicamente
setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TTL) {
      sessions.delete(phone);
    }
  }
}, 30 * 60 * 1000); // cada 30 min
