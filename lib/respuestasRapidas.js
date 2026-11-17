// lib/respuestasRapidas.js — Las respuestas rápidas del inbox, como conocimiento
// y como ACCIÓN del agente (17-nov-2026).
//
// Pedido de Rodrigo: "para mí es importante el uso de las respuestas rápidas: ahí
// están las fotos personalizadas de tallas y los procesos de pedir datos y de
// activar la forma de pago". Antes MANDI no sabía que existían y redactaba todo.
//
// Fuente: inbox.respuestas_rapidas (la misma tabla que edita el vendedor en el
// inbox). El agente las ve con un código corto (R1, R2…) y las manda con la tool
// `enviar_respuesta_rapida`. Acá NO se envía nada: se devuelve el id y el inbox la
// manda completa (texto, botones, fotos, audios, carrusel o formulario), igual
// que cuando se manda a mano.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim()

const TTL_MS = 5 * 60_000
const cache = new Map() // cuenta → { at, lista }

/** Lista ordenada de respuestas rápidas activas y habilitadas para la IA. Nunca lanza. */
export async function getRespuestasRapidas(cuenta = 'MANDI') {
  const c = cache.get(cuenta)
  if (c && Date.now() - c.at < TTL_MS) return c.lista
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  try {
    const url = `${SUPABASE_URL}/rest/v1/respuestas_rapidas`
      + `?select=id,texto,grupo,botones,adjuntos,carrusel,formulario`
      + `&cuenta=eq.${cuenta}&activo=eq.true&uso_ia=eq.true`
      + `&order=orden.asc,fecha.desc&limit=200`
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Accept-Profile': 'inbox' },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) { console.error('MANDI respuestas rápidas', res.status); return c?.lista || [] }
    const filas = await res.json()
    const lista = (Array.isArray(filas) ? filas : []).map((r, i) => ({ codigo: `R${i + 1}`, ...r }))
    cache.set(cuenta, { at: Date.now(), lista })
    return lista
  } catch (e) {
    console.error('MANDI respuestas rápidas falló:', e.message)
    return c?.lista || []
  }
}

const arr = (v) => (Array.isArray(v) ? v : [])

/** Qué trae además del texto: "5 fotos · botones: A | B · carrusel: X, Y". */
export function extrasDe(r) {
  const out = []
  const adj = arr(r.adjuntos)
  const fotos = adj.filter(a => a?.tipo === 'imagen').length
  const audios = adj.filter(a => a?.tipo === 'audio').length
  const docs = adj.filter(a => a?.tipo === 'documento').length
  if (fotos) out.push(`${fotos} foto${fotos > 1 ? 's' : ''}`)
  if (audios) out.push(`${audios} nota${audios > 1 ? 's' : ''} de voz`)
  if (docs) out.push(`${docs} documento${docs > 1 ? 's' : ''}`)
  const botones = arr(r.botones).filter(Boolean)
  if (botones.length) out.push(`botones: ${botones.join(' | ')}`)
  const car = arr(r.carrusel)
  if (car.length >= 2) out.push(`carrusel de productos: ${car.map(p => p?.nombre).filter(Boolean).join(', ')}`)
  if (r.formulario) out.push('formulario para llenar datos')
  return out.join(' · ')
}

/** El bloque de texto que va en el prompt (estable → cacheable). */
export function catalogoParaPrompt(lista) {
  if (!lista.length) return ''
  return lista.map((r) => {
    const extras = extrasDe(r)
    const cab = `${r.codigo} [${r.grupo || 'general'}${extras ? ' · ' + extras : ''}]`
    const texto = String(r.texto || '').trim().slice(0, 900) || '(sin texto: solo adjuntos)'
    return `${cab}\n${texto}`
  }).join('\n\n')
}

/** Código (R7) → fila, o null. Tolera minúsculas y espacios. */
export function porCodigo(lista, codigo) {
  const c = String(codigo || '').trim().toUpperCase()
  return lista.find(r => r.codigo === c) || null
}
