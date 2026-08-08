// lib/conversacion.js — MANDI lee el hilo del cliente DIRECTO de Supabase.
//
// Por qué existe: antes la memoria vivía en `lib/sessions.js`, un `Map` en RAM del
// proceso. En Vercel cada invocación puede caer en una instancia distinta, así que
// ese Map llegaba vacío y MANDI no recordaba nada: se re-saludaba a mitad de
// conversación y costó ventas en julio. La memoria no puede vivir en el proceso.
//
// Fuente única de verdad: la tabla `inbox.mensajes` (cuenta=MANDI), la misma que ve
// el inbox. Acá NO se escribe nada: el entrante lo guarda el webhook antes de
// llamarnos y la respuesta la guarda /api/saliente cuando el inbox la envía. Por eso
// MANDI ve también lo que contestó un vendedor humano.
//
// Mapeo: direccion ENTRANTE = cliente (role 'user'); SALIENTE = MANDI o el vendedor
// humano (las dos son la voz de la tienda → role 'assistant').
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim()
const CUENTA = 'MANDI'

// Ojo: `cuenta='MANDI'` cubre los DOS números del inbox (MANDI y REPUBLIC), así que
// un cliente que escribió a los dos ve un solo hilo fusionado. Medido el 8-ago-2026:
// 24 de 1428 clientes (1,7%). Se acepta a propósito — es la misma persona y la misma
// marca — y además el inbox no le manda el canal al agente, así que hoy no hay con
// qué filtrar sin cambiar el contrato con el inbox.

// Contenido legible para mensajes sin texto (imagen/audio/etc), para no mandar
// contenido vacío a la API de Claude (que lo rechaza).
function contenidoDe(row) {
  const t = (row.texto || '').trim()
  if (t) return t
  const b = (row.botones || '').trim()
  if (b) return b
  const tipo = (row.tipo || '').toLowerCase()
  if (row.media_url || /imagen|image|foto|sticker/.test(tipo)) return '[imagen]'
  if (/audio/.test(tipo)) return '[audio]'
  if (/video/.test(tipo)) return '[video]'
  if (/location|ubicaci/.test(tipo)) return '[ubicación]'
  if (/order|pedido/.test(tipo)) return '[pedido]'
  if (/document/.test(tipo)) return '[documento]'
  return '[mensaje]'
}

// Une dos contenidos de un mismo turno. Si los dos son texto, quedan como texto;
// si alguno trae bloques (una imagen, por ejemplo), pasa todo a bloques.
function aBloques(c) {
  if (typeof c === 'string') return [{ type: 'text', text: c }]
  return Array.isArray(c) ? c : []
}

function concatenarContenido(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return `${a}\n${b}`
  return [...aBloques(a), ...aBloques(b)]
}

/**
 * Fusiona mensajes consecutivos del mismo rol en un solo turno.
 *
 * Hace falta porque en WhatsApp la gente manda tres mensajes seguidos, y porque el
 * despertar del cron agrega un turno 'user' sobre un historial que puede terminar
 * en 'user' (medido: 22% de los chats de MANDI). Con el Map viejo eso nunca pasaba
 * — el historial siempre terminaba en 'assistant' —, así que es justo el borde que
 * el cambio de fuente destapa. Dejar la alternancia limpia lo vuelve un no-problema.
 * No muta la entrada.
 */
export function fusionarTurnos(mensajes) {
  const out = []
  for (const m of mensajes) {
    const prev = out[out.length - 1]
    if (!prev || prev.role !== m.role) { out.push({ ...m }); continue }
    prev.content = concatenarContenido(prev.content, m.content)
  }
  return out
}

export async function getConversacion(phone, limite = 10) {
  if (!phone || !SUPABASE_URL || !SUPABASE_KEY) return []
  const last9 = String(phone).replace(/\D/g, '').slice(-9)
  if (!last9) return []

  try {
    // Traemos de más (limite*3) porque luego fusionamos mensajes consecutivos del
    // mismo lado en un solo turno.
    const url = `${SUPABASE_URL}/rest/v1/mensajes`
      + `?select=direccion,tipo,texto,botones,media_url,fecha`
      + `&cuenta=eq.${CUENTA}`
      + `&telefono=like.*${last9}`
      + `&order=fecha.desc`
      + `&limit=${Math.max(6, limite * 3)}`

    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Accept-Profile': 'inbox',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      console.error('MANDI getConversacion supabase', res.status, await res.text().catch(() => ''))
      return []
    }
    const rows = await res.json()
    if (!Array.isArray(rows) || !rows.length) return []

    rows.reverse() // venía DESC (nuevo→viejo) → a cronológico (viejo→nuevo)

    const merged = fusionarTurnos(
      rows.map((row) => ({
        role: row.direccion === 'ENTRANTE' ? 'user' : 'assistant',
        content: contenidoDe(row),
      }))
    )

    // Recortar a ~`limite` turnos y garantizar que arranque en 'user'.
    // `limite` sigue en 10 y no en 20 a propósito: cada turno se reenvía COMPLETO en
    // cada mensaje siguiente, y en ventas por WhatsApp casi nunca hacen falta más.
    let out = merged
    const maxMsgs = limite * 2
    if (out.length > maxMsgs) out = out.slice(-maxMsgs)
    while (out.length && out[0].role === 'assistant') out.shift()
    return out
  } catch (err) {
    // Si Supabase falla, MANDI responde igual — sin memoria ESE turno, pero responde.
    // Un cliente esperando es peor que un bot desmemoriado por un turno.
    console.error('MANDI getConversacion (supabase) falló:', err.message)
    return []
  }
}
