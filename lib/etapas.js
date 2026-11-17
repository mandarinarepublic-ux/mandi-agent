// lib/etapas.js — La venta por ETAPAS (17-nov-2026).
//
// Idea tomada de SalesGPT (detectar en qué punto va la conversación y actuar según
// eso), adaptada al proceso real de Mandarina: interés → modelo → talla → datos →
// pago. Rodrigo: "que MANDI sepa manejar o mejorar su enfoque en relación a la etapa".
//
// El agente declara la etapa en la PRIMERA línea de su respuesta ("ETAPA: talla").
// Esa línea se quita antes de mandarle nada al cliente y queda en el registro, para
// medir dónde se caen las ventas. Sale más barato que una tool: no cuesta otra
// llamada a Claude.

export const ETAPAS = ['interes', 'modelo', 'talla', 'datos', 'pago', 'posventa', 'otro']

// Cómo se llaman en el inbox las etapas que marca el vendedor.
const DEL_INBOX = {
  cotizando: 'está cotizando (aún no cierra)',
  esperando_pago: 'ya dio sus datos o aceptó: falta que pague',
  falta_pedido: 'ya pagó: falta registrar el pedido (lo hace una persona)',
  postventa: 'ya compró: es posventa',
}

/** Texto para el prompt con lo que el inbox sabe del chat. '' si no hay nada. */
export function contextoDeFicha(ficha) {
  if (!ficha) return ''
  const out = []
  const e = DEL_INBOX[String(ficha.etapa || '')]
  if (e) out.push(`Etapa marcada por el equipo en el inbox: ${e}.`)
  if (String(ficha.id_venta || '').trim()) out.push('Este cliente ya tiene al menos un pedido registrado.')
  if (String(ficha.deuda_nota || '').trim()) out.push(`Pendiente anotado por el equipo: ${String(ficha.deuda_nota).slice(0, 120)}`)
  return out.join('\n')
}

/** Bloque estable del prompt (va dentro de la parte cacheada). */
export const PROMPT_ETAPAS = `

## ETAPAS DE LA VENTA
Antes de responder, ubica en qué etapa está ESTE cliente leyendo toda la conversación (y la etapa marcada por el equipo, si aparece). Tu trabajo es llevarlo a la SIGUIENTE etapa, una a la vez. No te saltes pasos ni vuelvas atrás.

- interes: saluda o pregunta algo general y aún no hay un modelo claro. Meta: saber qué personaje o prenda busca. Muestra el carrusel o la respuesta rápida de la franquicia que nombre; si no nombra ninguna, el catálogo. No hables de pago todavía.
- modelo: ya eligió o señaló un modelo. Meta: definir la talla (y el color si aplica). Confirma el modelo en una línea y manda la guía de tallas de ESA prenda si duda. No vuelvas a mandar el catálogo.
- talla: ya hay modelo y talla. Meta: cerrar. Usa la respuesta de cómo asegurar el pedido y pide sus datos con el formulario. Si duda por precio, deriva a una persona (los descuentos no los decides tú).
- datos: ya dio sus datos o dijo que quiere comprar. Meta: que pague. Manda las formas de pago; cuando elija, la cuenta que corresponde. No pidas otra vez datos que ya dio.
- pago: dice que ya pagó o manda el comprobante. Meta: tranquilidad. Agradece, dile que el equipo confirma el pago enseguida y deriva a una persona. No sigas vendiendo.
- posventa: ya compró y pregunta por su pedido, un cambio o un reclamo. Deriva a una persona; puedes mandar la respuesta de seguimiento del pedido si pregunta dónde está.
- otro: nada de lo anterior (proveedores, spam, número equivocado). Responde corto o deriva.

Reglas de etapa:
- Si el cliente retrocede (cambia de modelo, pide ver otros), acompáñalo: vuelve a esa etapa sin repetir lo ya enviado.
- Responde SIEMPRE lo que preguntó antes de empujar al siguiente paso.
- Una sola pregunta por mensaje, la que hace avanzar la etapa.

FORMATO OBLIGATORIO: la primera línea de tu respuesta final es exactamente "ETAPA: " y una de estas palabras: interes, modelo, talla, datos, pago, posventa, otro. El cliente no ve esa línea. Debajo va tu mensaje (o solo OK si la respuesta rápida ya lo dice todo).`

/**
 * Separa la línea "ETAPA: x" del mensaje para el cliente.
 * Tolerante: mayúsculas, tildes, asteriscos o que venga en otra línea. Si no viene,
 * etapa = '' y el texto queda intacto (nunca se le manda "ETAPA:" al cliente).
 */
export function separarEtapa(texto) {
  const lineas = String(texto || '').split('\n')
  let etapa = ''
  const resto = []
  for (const l of lineas) {
    const m = l.normalize('NFD').replace(/[̀-ͯ]/g, '').match(/^[\s*_#>-]*etapa[*_\s]*[:=-][*_\s]*([a-z]+)/i)
    if (m) {
      const e = m[1].toLowerCase()
      if (!etapa && ETAPAS.includes(e)) etapa = e
      continue // la línea NUNCA llega al cliente, sea válida o no
    }
    resto.push(l)
  }
  return { etapa, texto: resto.join('\n').trim() }
}
