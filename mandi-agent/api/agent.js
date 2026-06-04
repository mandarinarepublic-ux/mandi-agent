// api/agent.js
// MANDI — Endpoint principal del agente de ventas
// Consume: Make (WhatsApp), WaInbox, Artifact web

import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, needsShopifyLookup, parseIncomingMedia } from '../lib/systemPrompt.js';
import { searchProducts, searchByCollection, getAllProducts } from '../lib/shopify.js';
import { getSession, saveSession } from '../lib/sessions.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ─── AUTENTICACIÓN SIMPLE ─────────────────────────────────────
function isAuthorized(req) {
  const key = req.headers['x-mandi-key'] || req.headers['authorization']?.replace('Bearer ', '');
  return key === process.env.MANDI_API_KEY;
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────
export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized — incluye x-mandi-key header' });
  }

  const {
    phone,           // requerido: número WhatsApp "+5930..."
    message,         // requerido: texto del cliente
    name,            // opcional: nombre del contacto
    image_url,       // opcional: URL de imagen enviada por cliente
    media_id,        // opcional: media_id de WhatsApp Cloud API
    source,          // opcional: 'make' | 'wainbox' | 'artifact'
    reset_session    // opcional: true para borrar historial
  } = req.body || {};

  // Validación
  if (!phone || (!message && !image_url && !media_id)) {
    return res.status(400).json({
      error: 'Faltan campos requeridos: phone y (message o image_url)'
    });
  }

  const startTime = Date.now();

  try {
    // ── 1. SESIÓN ─────────────────────────────────────────────
    const session = reset_session ? { messages: [], meta: {} } : getSession(phone);
    const history = session.messages;

    // ── 2. SHOPIFY CONTEXT ────────────────────────────────────
    let shopifyContext = null;
    let shopifyProducts = [];

    if (needsShopifyLookup(message)) {
      try {
        // Intentar búsqueda específica primero
        let result = await searchProducts(message);

        // Si no encuentra, intentar por colección/franquicia
        if (!result) {
          result = await searchByCollection(message);
        }

        // Si tampoco, traer catálogo general
        if (!result) {
          result = await getAllProducts();
        }

        if (result) {
          shopifyContext = result.context;
          shopifyProducts = result.products;
        }
      } catch (err) {
        console.error('Shopify error:', err.message);
      }
    }

    // ── 3. CONSTRUIR MENSAJE DEL USUARIO ─────────────────────
    const userContent = buildUserContent(message, image_url, media_id, name);

    // ── 4. SYSTEM PROMPT ──────────────────────────────────────
    const systemPrompt = buildSystemPrompt(shopifyContext);

    // ── 5. LLAMAR A CLAUDE ────────────────────────────────────
    const messagesForClaude = [
      ...history,
      { role: 'user', content: userContent }
    ];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: systemPrompt,
      messages: messagesForClaude
    });

    const reply = response.content[0]?.text || '';
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    // ── 6. GUARDAR SESIÓN ─────────────────────────────────────
    const newHistory = [
      ...history,
      { role: 'user', content: typeof userContent === 'string' ? userContent : message || '[imagen]' },
      { role: 'assistant', content: reply }
    ];

    saveSession(phone, newHistory, {
      name,
      source,
      lastMessage: message,
      lastReply: reply.slice(0, 100)
    });

    // ── 7. RESPUESTA ──────────────────────────────────────────
    const elapsed = Date.now() - startTime;

    return res.status(200).json({
      // Para WhatsApp via Make
      reply,
      phone,

      // Metadata
      source: source || 'unknown',
      context_turns: Math.floor(newHistory.length / 2),
      tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
      shopify_products_found: shopifyProducts.length,
      elapsed_ms: elapsed,

      // Productos encontrados (para WaInbox o artifact)
      products: shopifyProducts.length > 0 ? shopifyProducts : undefined
    });

  } catch (error) {
    console.error('MANDI agent error:', error);
    return res.status(500).json({
      error: 'Error interno del agente',
      detail: error.message
    });
  }
}

// ─── CONSTRUIR CONTENT (texto + imagen opcional) ──────────────
function buildUserContent(message, imageUrl, mediaId, name) {
  const hasImage = imageUrl || mediaId;

  // Solo texto
  if (!hasImage) {
    return message || '';
  }

  // Texto + imagen (Claude vision)
  const content = [];

  if (imageUrl) {
    content.push({
      type: 'image',
      source: {
        type: 'url',
        url: imageUrl
      }
    });
  }

  if (message) {
    content.push({
      type: 'text',
      text: message
    });
  } else {
    content.push({
      type: 'text',
      text: name
        ? `${name} envió esta imagen`
        : 'El cliente envió esta imagen'
    });
  }

  return content;
}
