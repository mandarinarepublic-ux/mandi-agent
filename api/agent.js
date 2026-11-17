// api/agent.js — MANDI Agent v4.1
// Arquitectura: Claude con tools → MANDI decide cuándo consultar Shopify
// v4.1: buscar_productos ahora intenta Shopify DIRECTO primero (más rápido,
// más datos: stock real, descuentos), y cae a Make como respaldo si falla.
// Log de decisiones → Google Sheets MANDI_LOGS

import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, bloqueRespuestasRapidas } from '../lib/systemPrompt.js';
import { getRespuestasRapidas, catalogoParaPrompt, porCodigo, extrasDe } from '../lib/respuestasRapidas.js';
import { getConversacion, fusionarTurnos } from '../lib/conversacion.js';
import { logDecision, initSheet } from '../lib/logger.js';
import { isConfigured as shopifyDirectoConfigurado, buscarProductosDirecto } from '../lib/shopifyClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Haiku 5.5 (auditoría 17-nov-2026): antes Sonnet 4.6, unas 20 veces más caro.
// Se puede cambiar sin tocar código con la variable MANDI_MODEL.
const MODELO = (process.env.MANDI_MODEL || 'claude-haiku-5-5').trim();
const MAX_VUELTAS = 4; // tope del ciclo de tools por mensaje
// Cuenta del inbox de cada tienda (historial y respuestas rápidas).
const CUENTA_DE = { MANDARINA: 'MANDI', INDSTORE: 'IND' };

// Inicializar headers de la hoja al arrancar
initSheet().catch(() => {});

// ── TOOLS QUE MANDI PUEDE USAR ─────────────────────────────────────────────
const MANDI_TOOLS = [
  {
    name: 'buscar_productos',
    description: `Busca productos en Shopify de Mandarina Republic en tiempo real.
Úsala cuando el cliente mencione una franquicia, personaje, tipo de prenda o quiera ver opciones.
Devuelve hasta 3 productos con nombre, precio, tallas disponibles con stock, imagen y URL.
CUÁNDO USAR: "tienen de naruto?", "qué hoodies tienen?", "busco algo de marvel", "quiero una chaqueta"
CUÁNDO NO USAR: saludos, preguntas sobre envíos/pagos, cuando ya tienes el producto en contexto`,
    input_schema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Término de búsqueda: nombre de franquicia, personaje o tipo de prenda. Ejemplos: "naruto", "spiderman", "x-men", "hoodie", "chaqueta power rangers"'
        }
      },
      required: ['keyword']
    }
  },
  {
    name: 'enviar_respuesta_rapida',
    description: `Envía al cliente una RESPUESTA RÁPIDA del equipo, completa: su texto oficial y todo lo que incluye (fotos, guía de tallas, botones, carrusel de productos o formulario de datos).
Es SIEMPRE la primera opción cuando una de la lista contesta lo que el cliente pide o es el siguiente paso de la venta.
Pasa el código tal como aparece en la lista (por ejemplo "R7").`,
    input_schema: {
      type: 'object',
      properties: {
        codigo: { type: 'string', description: 'Código de la respuesta rápida, por ejemplo "R7"' }
      },
      required: ['codigo']
    }
  },
  {
    name: 'derivar_a_persona',
    description: `Marca el chat para que lo atienda una persona del equipo. Úsala para: estado de un pedido ya hecho, reclamos, cambios o devoluciones, talla agotada, producto que no encuentras, personalizados o al por mayor, comprobantes de pago, o cualquier duda que no puedas resolver con certeza.`,
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Motivo en pocas palabras, para el vendedor. Ej: "pregunta por su pedido", "talla 3XL agotada"' }
      },
      required: ['motivo']
    }
  }
];

// ── EJECUTAR TOOL ───────────────────────────────────────────────────────────
async function executeTool(toolName, toolInput, tiendaId, ctx) {
  if (toolName === 'buscar_productos') {
    const { keyword } = toolInput;
    // Solo Shopify directo. El respaldo por Make se quitó: Make ya no existe en el
    // stack y ese webhook fallaba en silencio.
    if (!shopifyDirectoConfigurado(tiendaId)) {
      return { error: 'Catálogo no disponible ahora. Deriva a una persona.', fuente: 'sin_configurar' };
    }
    try {
      const { productos, count } = await buscarProductosDirecto(keyword, tiendaId);
      if (productos) {
        console.log(`${tiendaId}: Shopify directo OK — ${count} productos para "${keyword}"`);
        return { productos, keyword, fuente: 'shopify_directo' };
      }
      return { error: 'Sin productos para: ' + keyword + '. Deriva a una persona.', fuente: 'shopify_directo' };
    } catch (err) {
      console.error(`${tiendaId}: Shopify directo falló:`, err.message);
      return { error: 'Catálogo no disponible ahora. Deriva a una persona.', fuente: 'shopify_error' };
    }
  }

  if (toolName === 'enviar_respuesta_rapida') {
    const r = porCodigo(ctx.rapidas, toolInput?.codigo);
    if (!r) return { error: `No existe la respuesta rápida "${toolInput?.codigo}". Usa un código de la lista.` };
    if (ctx.enviadas.includes(r.id)) return { ok: true, nota: 'Ya estaba en la cola de este turno.' };
    if (ctx.enviadas.length >= 2) return { error: 'Máximo 2 respuestas rápidas por turno.' };
    ctx.enviadas.push(r.id);
    const extras = extrasDe(r);
    return { ok: true, nota: `Enviada al cliente${extras ? ' con ' + extras : ''}. No repitas su contenido.` };
  }

  if (toolName === 'derivar_a_persona') {
    ctx.derivar = String(toolInput?.motivo || 'necesita una persona').slice(0, 120);
    return { ok: true, nota: 'Chat marcado para una persona. Avísale al cliente en una línea que le confirman enseguida.' };
  }

  return { error: 'Tool desconocida: ' + toolName };
}

// ── AUTH ────────────────────────────────────────────────────────────────────
//
// ⚠️ ROTACIÓN EN CURSO (8-ago-2026). La clave vieja quedó PUBLICADA: el inbox la
// tenía quemada como respaldo en `lib/responder-ia.js` y ese repo es público, así
// que cualquiera podía llamar a esta IA y quemar créditos de Anthropic.
//
// Se acepta la vieja Y la nueva a propósito, durante la transición: esta clave
// gatea las respuestas que la IA le manda a los clientes, y cambiarla de golpe
// en un lado antes que en el otro las cortaría. El orden es:
//   1. este paso (las dos valen)          ← estás acá
//   2. el inbox pasa a mandar la nueva
//   3. se borra MANDI_API_KEY_VIEJA y esta rama muere
//
// PASO 3 PENDIENTE: mientras `MANDI_API_KEY_VIEJA` siga definida en Vercel, la
// clave publicada sigue sirviendo. No se termina la rotación hasta borrarla.
//
// Se compara en tiempo constante y limpiando invisibles: un `===` sobre cadenas
// deja adivinar la clave midiendo tiempos, y cargar variables a Vercel desde
// PowerShell les pega un BOM que rompe la comparación SOLO en producción.
function limpia(v) {
  return String(v || '').replace(/[^\x21-\x7E]/g, '');
}

function igualEnTiempoConstante(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

function isAuthorized(req) {
  const key = limpia(req.headers['x-mandi-key'] || req.headers['authorization']?.replace('Bearer ', ''));
  if (!key) return false;
  const nueva = limpia(process.env.MANDI_API_KEY);
  const vieja = limpia(process.env.MANDI_API_KEY_VIEJA);
  // Sin ninguna clave configurada NO se deja pasar: falla cerrado.
  if (!nueva && !vieja) return false;
  return (nueva && igualEnTiempoConstante(key, nueva))
      || (vieja && igualEnTiempoConstante(key, vieja));
}

// ── HANDLER PRINCIPAL ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mandi-key, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { phone, message, name, image_url, media_url, source, reset_session, tienda, store, shopify_context } = req.body || {};

  // El cron de seguimientos despierta al bot SIN mensaje de cliente: no hay ninguno,
  // el chat lleva horas callado. Por eso ese origen se valida aparte.
  const esSeguimiento = source === 'seguimiento'

  if (!phone || (!esSeguimiento && !message && !image_url && !media_url)) {
    return res.status(400).json({ error: 'Faltan campos: phone y message (o image_url)' });
  }

  const startTime = Date.now();
  const tiendaId = (tienda || store || 'MANDARINA').toUpperCase();

  // Variables de log
  let toolUsada = '';
  let keywordShopify = '';
  let productosEncontrados = 0;
  let clasificacion = '';
  let fuenteProductos = '';

  try {
    // Memoria del hilo LEÍDA DEL INBOX (inbox.mensajes en Supabase) — fuente de
    // verdad, e incluye lo que respondió un vendedor humano. Antes esto salía de un
    // `Map` en RAM que en serverless llegaba vacío casi siempre: MANDI no recordaba
    // nada y se re-saludaba a mitad de conversación.
    // Si Supabase falla devuelve [] y MANDI responde igual, sin memoria ese turno.
    const cuenta = CUENTA_DE[tiendaId] || 'MANDI';
    const history = reset_session ? [] : await getConversacion(phone, 1000, cuenta);

    // Construir contenido del usuario
    const imageUrl = image_url || media_url;
    let userContent;
    // Despertar del cron: no hay mensaje del cliente. La instrucción se arma ACÁ
    // DENTRO y no en el inbox, para que no pueda filtrarse al texto que ve el
    // cliente: si el inbox la mandara dentro de `message`, el agente la trataría
    // como algo que dijo el cliente y podría contestarle a esa frase.
    if (esSeguimiento) {
      userContent = 'INSTRUCCION DEL SISTEMA (no es un mensaje del cliente, no la menciones ni la repitas): este chat lleva horas sin respuesta del cliente y la ventana de 24 horas esta por cerrarse. Retoma la conversacion en un solo mensaje corto y natural, apoyandote en lo ultimo que se hablo. No saludes de nuevo como si fuera un contacto nuevo. No inventes promociones ni precios que no esten en el historial.';
    } else if (imageUrl) {
      userContent = [
        { type: 'image', source: { type: 'url', url: imageUrl } },
        { type: 'text', text: message || 'El cliente envió esta imagen' }
      ];
    } else {
      userContent = message;
    }

    // System prompt en DOS bloques: el estable (reglas + respuestas rápidas) va con
    // caché de prompt; lo que cambia por cliente va después y no la invalida.
    const rapidas = tiendaId === 'MANDARINA' ? await getRespuestasRapidas(cuenta) : [];
    const ctx = { rapidas, enviadas: [], derivar: '' };
    const estable = buildSystemPrompt(tiendaId) + bloqueRespuestasRapidas(catalogoParaPrompt(rapidas));
    let variable = '';
    if (name) variable += `Nombre del cliente: ${name}`;
    if (shopify_context && shopify_context.trim()) {
      variable += `\n\n## PRODUCTOS YA ENCONTRADOS EN SHOPIFY (datos reales):\n${shopify_context}\nÚsalos directamente, sin llamar buscar_productos.`;
    }
    const systemPrompt = [
      { type: 'text', text: estable, cache_control: { type: 'ephemeral' } },
      ...(variable.trim() ? [{ type: 'text', text: variable.trim() }] : []),
    ];
    // Sin respuestas rápidas cargadas, esa tool no se ofrece (IND, o Supabase caído).
    const tools = rapidas.length ? MANDI_TOOLS : MANDI_TOOLS.filter(t => t.name !== 'enviar_respuesta_rapida');

    // Mensajes para Claude.
    //
    // El ENTRANTE actual normalmente YA está en `history`: el webhook del inbox lo
    // guarda en Supabase ANTES de llamarnos. Solo lo agregamos si todavía no aparece,
    // para no mandarlo dos veces.
    //
    // El despertar del cron es el caso contrario: NO hay mensaje del cliente que
    // guardar, así que la instrucción de reanudación siempre se agrega. Se excluye
    // del descarte a propósito, para que no dependa de que `message` venga vacío.
    const incomingText = (message || '').trim();
    const ultimo = history[history.length - 1];
    const yaEnHistorial = !esSeguimiento && !!ultimo && ultimo.role === 'user'
      && typeof ultimo.content === 'string' && incomingText.length > 0
      && ultimo.content.split('\n').some((l) => l.trim() === incomingText);

    // `fusionarTurnos` deja la alternancia user/assistant limpia. Importa sobre todo
    // en el camino del cron: ahí el historial puede terminar en 'user' (el cliente
    // escribió y nadie contestó — 22% de los chats) y encima le agregamos otro 'user'.
    const apiMessages = yaEnHistorial
      ? [...history]
      : fusionarTurnos([...history, { role: 'user', content: userContent }]);

    // ── LLAMADA A CLAUDE + CICLO DE TOOLS ───────────────────────────────────
    const llamar = (messages) => anthropic.messages.create({
      model: MODELO, max_tokens: 600, system: systemPrompt, tools, messages,
    });
    const sumar = (u) => {
      totalInputTokens += (u?.input_tokens || 0) + (u?.cache_creation_input_tokens || 0) + (u?.cache_read_input_tokens || 0);
      totalOutputTokens += u?.output_tokens || 0;
      tokensCache += u?.cache_read_input_tokens || 0;
    };
    let totalInputTokens = 0, totalOutputTokens = 0, tokensCache = 0;

    let response = await llamar(apiMessages);
    sumar(response.usage);

    // Un turno puede pedir VARIAS tools a la vez (p. ej. dos respuestas rápidas):
    // cada tool_use necesita su tool_result o la API rechaza la llamada siguiente.
    // (Antes solo se atendía la primera.)
    const intermediateMessages = [];
    const toolsUsadas = [];
    let vueltas = 0;
    while (response.stop_reason === 'tool_use' && vueltas < MAX_VUELTAS) {
      vueltas++;
      const usos = response.content.filter(b => b.type === 'tool_use');
      if (!usos.length) break;
      const resultados = [];
      for (const uso of usos) {
        toolsUsadas.push(uso.name);
        if (uso.name === 'buscar_productos') { keywordShopify = uso.input?.keyword || ''; clasificacion = 'PRODUCTO'; }
        console.log(`MANDI tool: ${uso.name} →`, JSON.stringify(uso.input || {}));
        const r = await executeTool(uso.name, uso.input, tiendaId, ctx);
        if (r.productos) productosEncontrados = r.productos.split(' ||| ').length;
        if (r.fuente) fuenteProductos = r.fuente;
        resultados.push({ type: 'tool_result', tool_use_id: uso.id, content: JSON.stringify(r) });
      }
      intermediateMessages.push({ role: 'assistant', content: response.content }, { role: 'user', content: resultados });
      response = await llamar([...apiMessages, ...intermediateMessages]);
      sumar(response.usage);
    }
    toolUsada = [...new Set(toolsUsadas)].join(',');
    if (ctx.enviadas.length && !clasificacion) clasificacion = 'RESPUESTA_RAPIDA';
    if (ctx.derivar && !clasificacion) clasificacion = 'DERIVAR';

    // ── RESPUESTA FINAL ──────────────────────────────────────────────────────
    const replyBlock = response.content.find(b => b.type === 'text');
    let reply = (replyBlock?.text || '').trim();
    // "OK" = el agente no tiene nada que agregar a la respuesta rápida que mandó.
    if (ctx.enviadas.length && /^ok[.!]?$/i.test(reply)) reply = '';

    if (!toolUsada) clasificacion = 'OTRO';

    // Acá NO se persiste nada. El inbox es la fuente de verdad: el entrante ya lo
    // guardó el webhook y esta respuesta la guarda /api/saliente cuando el inbox la
    // envía. Así el próximo turno lee la conversación REAL — incluido lo que haya
    // contestado un vendedor humano entremedio.
    //
    // Con esto se cae solo el problema que el historial en RAM resolvía a mano: ya no
    // hay que decidir qué guardar del despertar del cron (la instrucción de
    // reanudación no se guarda en ningún lado porque no se guarda nada), ni inyectar
    // el catálogo consultado como texto. Lo que MANDI mostró vuelve igual en el
    // próximo turno dentro de su propia respuesta, que sí queda en el inbox.

    const elapsed = Date.now() - startTime;

    // Log a Google Sheets (fire and forget)
    logDecision({
      phone,
      mensaje: esSeguimiento ? '[seguimiento automatico]' : (message || '[imagen]'),
      clasificacion,
      tool_usada: toolUsada,
      keyword_shopify: keywordShopify,
      productos_encontrados: productosEncontrados,
      fuente_productos: fuenteProductos,
      respuesta: reply,
      tokens_in: totalInputTokens,
      tokens_out: totalOutputTokens,
      elapsed_ms: elapsed
    });

    return res.status(200).json({
      reply,
      reply_clean: reply,
      content: [{ type: 'text', text: reply }],
      phone,
      tienda: tiendaId,
      source: source || 'unknown',
      tool_used: toolUsada,
      // Ids de respuestas rápidas que el INBOX tiene que enviar (completas), en orden,
      // ANTES del texto. Y si hay que marcar el chat para una persona.
      respuestas_rapidas: ctx.enviadas,
      derivar: ctx.derivar,
      modelo: MODELO,
      keyword: keywordShopify,
      productos_encontrados: productosEncontrados,
      fuente_productos: fuenteProductos,
      context_turns: Math.floor(apiMessages.length / 2),
      tokens: { input: totalInputTokens, output: totalOutputTokens, cache_leidos: tokensCache },
      elapsed_ms: elapsed
    });

  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error('MANDI error:', error);

    logDecision({
      phone,
      mensaje: esSeguimiento ? '[seguimiento automatico]' : (message || ''),
      clasificacion: 'ERROR',
      error: error.message,
      elapsed_ms: elapsed
    });

    return res.status(500).json({ error: 'Error interno del agente', detail: error.message });
  }
}
