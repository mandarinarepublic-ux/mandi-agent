// lib/respuestaFinal.js — Última revisión de lo que sale al cliente (17-nov-2026).
//
// Medido en el modo sombra con chats reales de MANDI:
//   · "Qué tallas tienen?" → el agente contestó "OK" SIN haber mandado ninguna
//     respuesta rápida. Ese "OK" le habría llegado solo al cliente.
//   · Derivó a una persona y no le dijo nada al cliente (Aleksander, UK): el
//     cliente se queda esperando sin saber que alguien lo va a atender.
// Estas reglas valen aunque el modelo se equivoque: por eso van en código y no
// solo en el prompt. Módulo PURO.

export const AVISO_DERIVAR = '¡Gracias! 🧡 Alguien del equipo te confirma enseguida.'

const esRelleno = (t) => /^(ok|okay|okey|listo|vale)[.!]*$/i.test(String(t || '').trim())

/**
 * @param {{ reply: string, enviadas: string[], derivar: string }} r
 * @returns {{ reply: string, derivar: string }}
 */
export function ajustarRespuestaFinal({ reply = '', enviadas = [], derivar = '' } = {}) {
  let texto = String(reply || '').trim()
  let deriva = String(derivar || '').trim()

  if (esRelleno(texto)) {
    texto = ''
    // "OK" sin haber mandado nada = el agente no supo qué contestar. Nunca se le
    // manda ese "OK" al cliente: el chat queda para una persona.
    if (!enviadas.length && !deriva) deriva = 'el agente no supo qué responder'
  }

  // Derivó y no dijo nada → el cliente recibe SIEMPRE una línea de aviso.
  // Si ya va una respuesta rápida, esa es la respuesta: no se agrega nada.
  if (deriva && !texto && !enviadas.length) texto = AVISO_DERIVAR

  return { reply: texto, derivar: deriva }
}
