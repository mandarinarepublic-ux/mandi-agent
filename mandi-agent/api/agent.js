// api/agent.js — MANDI Agent v2.1 (catálogo hardcodeado)

import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, parseIncomingMedia } from '../lib/systemPrompt.js';
import { getSession, saveSession } from '../lib/sessions.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function isAuthorized(req) {
  const key = req.headers['x-mandi-key'] || req.headers['authorization']?.replace('Bearer ', '');
  return key === process.env.MANDI_API_KEY;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { phone, message, name, image_url, media_url, source, reset_session } = req.body || {};

  if (!phone || (!message && !image_url && !media_url)) {
    return res.status(400).json({ error: 'Faltan campos: phone y message (o image_url)' });
  }

  const startTime = Date.now();

  try {
    // Sesión
    const session = reset_session ? { messages: [], meta: {} } : getSession(phone);
    const history = session.messages;

    // Construir contenido del usuario
    const imageUrl = image_url || media_url;
    let userContent;

    if (imageUrl) {
      userContent = [
        { type: 'image', source: { type: 'url', url: imageUrl } },
        { type: 'text', text: message || (name ? `${name} envió esta imagen` : 'El cliente envió esta imagen') }
      ];
    } else {
      userContent = message;
    }

    // Llamar a Claude
    const messagesForClaude = [
      ...history,
      { role: 'user', content: userContent }
    ];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: buildSystemPrompt() + (name ? `\n\nNombre del cliente: ${name}` : ''),
      messages: messagesForClaude
    });

    const reply = response.content[0]?.text || '';
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    // Guardar sesión
    const newHistory = [
      ...history,
      { role: 'user', content: typeof userContent === 'string' ? userContent : (message || '[imagen]') },
      { role: 'assistant', content: reply }
    ];
    saveSession(phone, newHistory, { name, source, lastReply: reply.slice(0, 100) });

    return res.status(200).json({
      reply,
      phone,
      source: source || 'unknown',
      context_turns: Math.floor(newHistory.length / 2),
      tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
      elapsed_ms: Date.now() - startTime
    });

  } catch (error) {
    console.error('MANDI error:', error);
    return res.status(500).json({ error: 'Error interno del agente', detail: error.message });
  }
}
