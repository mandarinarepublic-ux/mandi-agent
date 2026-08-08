// api/agent.js — MANDI Agent v4.1
// Arquitectura: Claude con tools → MANDI decide cuándo consultar Shopify
// v4.1: buscar_productos ahora intenta Shopify DIRECTO primero (más rápido,
// más datos: stock real, descuentos), y cae a Make como respaldo si falla.
// Log de decisiones → Google Sheets MANDI_LOGS

import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from '../lib/systemPrompt.js';
import { getSession, saveSession } from '../lib/sessions.js';
import { logDecision, initSheet } from '../lib/logger.js';
import { isConfigured as shopifyDirectoConfigurado, buscarProductosDirecto } from '../lib/shopifyClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAKE_SHOPIFY_WEBHOOK = 'https://hook.us2.make.com/irqcoe515xt1ijtn9w1nrp83xdmhn493';

// Inicializar headers de la hoja al arrancar
initSheet().catch(() => {});

// ── GUÍAS DE TALLAS ───────────────────────────────────────────────────────
const GUIAS_TALLAS = {
  hoodie:    'https://cdn.shopify.com/s/files/1/0689/5832/2781/files/MEDIDAS_CAMISETAS_NINOS_ADMINISTRADOR-02.png?v=1746666338',
  chaqueta:  'https://cdn.shopify.com/s/files/1/0689/5832/2781/files/MEDIDAS_CAMISETAS_NINOS_ADMINISTRADOR-02.png?v=1746666338',
  camiseta:  'https://cdn.shopify.com/s/files/1/0689/5832/2781/files/MEDIDAS_MANDARINA-01.png?v=1746666339',
  general:   'https://cdn.shopify.com/s/files/1/0689/5832/2781/files/MEDIDAS_CAMISETAS_NINOS_ADMINISTRADOR-02.png?v=1746666338'
};

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
    name: 'obtener_guia_tallas',
    description: `Devuelve la imagen correcta de guía de tallas según el tipo de prenda.
Usar cuando el cliente pregunta por medidas, tallas, cuál talla elegir, o cómo saber su talla.
Siempre úsala en contexto: si estaban hablando de hoodies, usa hoodie. Si de camisetas, usa camiseta.`,
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          enum: ['hoodie', 'chaqueta', 'camiseta', 'general'],
          description: 'Tipo de prenda: hoodie/chaqueta para sudaderas y chaquetas, camiseta para remeras, general si no está claro'
        }
      },
      required: ['tipo']
    }
  }
];

// ── BUSCAR PRODUCTOS VÍA MAKE (respaldo) ───────────────────────────────────
async function buscarProductosViaMake(keyword) {
  const res = await fetch(MAKE_SHOPIFY_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword, phone: 'mandi_tool' }),
    signal: AbortSignal.timeout(8000)
  });

  if (!res.ok) throw new Error(`Make webhook respondió ${res.status}`);

  const data = await res.json();
  if (!data?.productos) throw new Error('Make webhook sin productos');

  return data.productos;
}

// ── EJECUTAR TOOL ───────────────────────────────────────────────────────────
async function executeTool(toolName, toolInput, tiendaId = 'MANDARINA') {
  if (toolName === 'buscar_productos') {
    const { keyword } = toolInput;

    // 1) Intentar Shopify DIRECTO primero, si está configurado para esta tienda
    if (shopifyDirectoConfigurado(tiendaId)) {
      try {
        const { productos, count } = await buscarProductosDirecto(keyword, tiendaId);
        if (productos) {
          console.log(`${tiendaId}: Shopify directo OK — ${count} productos para "${keyword}"`);
          return { productos, keyword, fuente: 'shopify_directo' };
        }
        return { error: 'Sin productos para: ' + keyword, fuente: 'shopify_directo' };
      } catch (err) {
        console.error(`${tiendaId}: Shopify directo falló, usando Make de respaldo:`, err.message);
      }
    }

    // 2) Respaldo: webhook de Make (comportamiento original — solo Mandarina)
    try {
      const productos = await buscarProductosViaMake(keyword);
      return { productos, keyword, fuente: 'make_webhook' };
    } catch (err) {
      return { error: 'Error consultando Shopify: ' + err.message };
    }
  }

  if (toolName === 'obtener_guia_tallas') {
    const { tipo } = toolInput;
    const url = GUIAS_TALLAS[tipo] || GUIAS_TALLAS.general;
    return { imagen_guia: url, tipo };
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
    const session = reset_session ? { messages: [], meta: {} } : getSession(phone);
    const history = session.messages;

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

    // System prompt
    let systemPrompt = buildSystemPrompt(tiendaId);
    if (name) systemPrompt += `\n\nNombre del cliente: ${name}`;
    // Inyectar contexto de Shopify si viene de Make (ya buscado por el escenario)
    if (shopify_context && shopify_context.trim()) {
      systemPrompt += `\n\n## 🛒 PRODUCTOS DISPONIBLES EN TIENDA (datos reales de Shopify):\n${shopify_context}\n\n⚠️ IMPORTANTE: Estos productos YA FUERON encontrados en Shopify. ÚSALOS DIRECTAMENTE sin llamar la tool buscar_productos. Si el cliente pregunta por uno de estos, confirma precio, tallas y cierra la venta YA.`;
    }

    // Mensajes para Claude
    const apiMessages = [
      ...history,
      { role: 'user', content: userContent }
    ];

    // ── PRIMERA LLAMADA A CLAUDE ────────────────────────────────────────────
    let response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: systemPrompt,
      tools: MANDI_TOOLS,
      messages: apiMessages
    });

    let totalInputTokens = response.usage?.input_tokens || 0;
    let totalOutputTokens = response.usage?.output_tokens || 0;

    // ── AGENTIC LOOP: ejecutar tools si MANDI las pidió ────────────────────
    // Guardamos los mensajes intermedios para el historial completo
    const intermediateMessages = [];

    while (response.stop_reason === 'tool_use') {
      const toolUseBlock = response.content.find(b => b.type === 'tool_use');
      if (!toolUseBlock) break;

      toolUsada = toolUseBlock.name;
      keywordShopify = toolUseBlock.input?.keyword || '';
      clasificacion = 'PRODUCTO';

      console.log(`MANDI tool: ${toolUsada} → "${keywordShopify}"`);

      // Ejecutar la tool
      const toolResult = await executeTool(toolUseBlock.name, toolUseBlock.input, tiendaId);
      if (toolResult.productos) {
        productosEncontrados = toolResult.productos.split(' ||| ').length;
      }
      if (toolResult.fuente) {
        fuenteProductos = toolResult.fuente;
      }

      // Mensaje assistant con el tool_use
      const assistantToolMsg = { role: 'assistant', content: response.content };

      // Mensaje user con el tool_result
      const toolResultMessage = {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseBlock.id,
          content: JSON.stringify(toolResult)
        }]
      };

      // Guardamos estos mensajes para el historial
      intermediateMessages.push(assistantToolMsg, toolResultMessage);

      // Segunda llamada con el resultado de la tool
      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: systemPrompt,
        tools: MANDI_TOOLS,
        messages: [
          ...apiMessages,
          ...intermediateMessages
        ]
      });

      totalInputTokens += response.usage?.input_tokens || 0;
      totalOutputTokens += response.usage?.output_tokens || 0;
    }

    // ── RESPUESTA FINAL ──────────────────────────────────────────────────────
    const replyBlock = response.content.find(b => b.type === 'text');
    const reply = replyBlock?.text || '';

    if (!toolUsada) clasificacion = 'OTRO';

    // Guardar historial limpio — sin tool_use/tool_result blocks
    // En su lugar guardamos el catálogo consultado como contexto de texto plano
    // Así MANDI recuerda qué productos mostró sin romper el formato de la API
    // En el despertar del cron NO guardamos la instruccion de reanudacion en el historial:
    // no la dijo el cliente, y si quedara guardada asi el bot la veria como un mensaje real
    // en el siguiente turno y podria responderle a ella o mencionarla. Guardamos en su lugar
    // un marcador corto y neutro que deja constancia de que ese turno fue un seguimiento
    // automatico, sin inventar que el cliente escribio algo. Mantenemos el turno (en vez de
    // omitirlo) para no dejar dos turnos de assistant seguidos, que rompe el formato de la API.
    const userMsg = { role: 'user', content: esSeguimiento ? '[seguimiento automatico]' : (typeof userContent === 'string' ? userContent : (message || '[imagen]')) };
    const assistantFinalMsg = { role: 'assistant', content: reply };

    const newHistory = [...history, userMsg];

    // Si hubo una tool call, inyectar el catálogo como contexto de sistema
    // en forma de mensaje user/assistant para que MANDI lo tenga en cuenta
    if (intermediateMessages.length > 0) {
      // Extraer el tool_result con los productos
      const toolResultMsg = intermediateMessages.find(m =>
        m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
      );
      if (toolResultMsg) {
        const toolContent = toolResultMsg.content[0]?.content || '';
        // Guardarlo como contexto limpio: user pregunta, assistant confirma catálogo
        newHistory.push({
          role: 'assistant',
          content: `[CATÁLOGO CONSULTADO EN SHOPIFY para esta conversación: ${toolContent}]`
        });
        newHistory.push({
          role: 'user',
          content: 'ok, basándote en ese catálogo responde mi pregunta anterior'
        });
      }
    }

    newHistory.push(assistantFinalMsg);
    saveSession(phone, newHistory, { name, source, lastReply: reply.slice(0, 100) });

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
      keyword: keywordShopify,
      productos_encontrados: productosEncontrados,
      fuente_productos: fuenteProductos,
      context_turns: Math.floor(newHistory.length / 2),
      tokens: { input: totalInputTokens, output: totalOutputTokens },
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
