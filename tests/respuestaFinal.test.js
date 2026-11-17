import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ajustarRespuestaFinal, AVISO_DERIVAR } from '../lib/respuestaFinal.js'

// Casos medidos en el modo sombra con chats reales de MANDI (17-nov-2026).
test('"OK" sin respuesta rápida (Lo, "Qué tallas tienen?") → nada al cliente salvo el aviso, y a una persona', () => {
  const r = ajustarRespuestaFinal({ reply: 'OK', enviadas: [], derivar: '' })
  assert.equal(r.derivar, 'el agente no supo qué responder')
  assert.equal(r.reply, AVISO_DERIVAR)
})

test('"OK" después de una respuesta rápida (Power Rangers) → solo va la rápida', () => {
  assert.deepEqual(ajustarRespuestaFinal({ reply: 'OK', enviadas: ['d0f7'], derivar: '' }), { reply: '', derivar: '' })
})

test('derivó en silencio (Aleksander, UK) → el cliente recibe el aviso', () => {
  const r = ajustarRespuestaFinal({ reply: '', enviadas: [], derivar: 'envío a UK' })
  assert.deepEqual(r, { reply: AVISO_DERIVAR, derivar: 'envío a UK' })
})

test('derivó con su propio texto (Jostyn, comprobante) → no se toca', () => {
  const t = '¡Gracias Jostyn! 🧡 Recibimos tu comprobante y alguien del equipo te confirma el pago enseguida.'
  assert.deepEqual(ajustarRespuestaFinal({ reply: t, enviadas: [], derivar: 'comprobante' }), { reply: t, derivar: 'comprobante' })
})

test('derivó junto con una rápida (Alejandro) sin texto → no se agrega aviso', () => {
  assert.deepEqual(ajustarRespuestaFinal({ reply: '', enviadas: ['a4be'], derivar: 'talla niño' }), { reply: '', derivar: 'talla niño' })
})

test('sin nada que decir y sin derivar (Produbanco, ya tiene los datos) → silencio', () => {
  assert.deepEqual(ajustarRespuestaFinal({ reply: '', enviadas: [], derivar: '' }), { reply: '', derivar: '' })
})
