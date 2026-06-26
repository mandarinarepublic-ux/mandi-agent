# 🍊 MANDI Agent v2.0
### Agente de Ventas IA — Mandarina Republic

Endpoint serverless en Vercel que conecta Claude Sonnet con Shopify real.
Consume Make (WhatsApp), WaInbox y el artifact web.

---

## 🚀 DEPLOY EN VERCEL (10 minutos)

### 1. Preparar el proyecto

```bash
# Clonar / copiar esta carpeta a tu máquina
cd mandi-agent

# Instalar dependencias
npm install

# Instalar Vercel CLI si no lo tienes
npm i -g vercel
```

### 2. Deploy inicial

```bash
vercel
# Sigue el wizard:
# - Link to existing project? No → crear nuevo
# - Project name: mandi-agent
# - Override settings? No
```

### 3. Variables de entorno en Vercel

Ve a: vercel.com → tu proyecto → Settings → Environment Variables

Agrega estas 4 variables:

| Variable | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | Tu API key de Anthropic |
| `SHOPIFY_STORE_DOMAIN` | `tu-tienda.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | Token Admin de Shopify (ver abajo) |
| `MANDI_API_KEY` | Una clave secreta que tú defines |

### 4. Obtener Shopify Admin Token

1. Ve a tu tienda Shopify → Settings → Apps and sales channels
2. Develop apps → Create an app → Nombre: "MANDI Agent"
3. Configure Admin API scopes: activa `read_products`, `read_inventory`
4. Install app → copia el **Admin API access token** (`shpat_...`)

### 5. Deploy final

```bash
vercel --prod
```

Tu agente queda en: `https://mandi-agent-xxxx.vercel.app`

---

## 📡 ENDPOINTS

### `POST /api/agent` — El agente principal

**Headers:**
```
Content-Type: application/json
x-mandi-key: tu_MANDI_API_KEY
```

**Body (Make → MANDI):**
```json
{
  "phone": "+593991234567",
  "message": "Hola, tienen hoodies de Dragon Ball?",
  "name": "Carlos",
  "source": "make"
}
```

**Body con imagen:**
```json
{
  "phone": "+593991234567",
  "message": "Este es el diseño que busco",
  "image_url": "https://...",
  "source": "wainbox"
}
```

**Respuesta:**
```json
{
  "reply": "¡Hola Carlos! 🔥 Sí tenemos Dragon Ball...",
  "phone": "+593991234567",
  "context_turns": 3,
  "tokens": { "input": 892, "output": 124, "total": 1016 },
  "shopify_products_found": 4,
  "elapsed_ms": 1243,
  "products": [
    {
      "title": "Hoodie Goku SSJ4",
      "price": "$65",
      "available": true,
      "sizes": "S, M, L, XL",
      "image": "https://cdn.shopify.com/...",
      "url": "https://mandarina-republic.myshopify.com/products/hoodie-goku"
    }
  ]
}
```

### `GET /api/status` — Health check
```
GET https://mandi-agent.vercel.app/api/status
x-mandi-key: tu_clave
```

---

## ⚙️ INTEGRACIÓN CON MAKE

### Módulo HTTP en Make:

```
URL: https://mandi-agent.vercel.app/api/agent
Method: POST
Headers:
  Content-Type: application/json
  x-mandi-key: {{tu_clave}}
Body (raw JSON):
{
  "phone": "{{whatsapp_from}}",
  "message": "{{message_text}}",
  "name": "{{contact_name}}",
  "image_url": "{{media_url}}",
  "source": "make"
}
```

El campo `reply` de la respuesta va directo al módulo de envío de WhatsApp.

---

## 🔌 INTEGRACIÓN CON WAINBOX

En `RepublicInbox.jsx` y `App.jsx`, reemplaza la llamada directa a Anthropic por:

```javascript
// En tu función de IA (panel derecho, sugerencias, etc.)
async function callMandiAgent(phone, message, imageUrl = null) {
  const res = await fetch('https://mandi-agent.vercel.app/api/agent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mandi-key': import.meta.env.VITE_MANDI_KEY
    },
    body: JSON.stringify({
      phone,
      message,
      image_url: imageUrl,
      source: 'wainbox'
    })
  });
  const data = await res.json();
  return data.reply;
}
```

Agrega en Vercel (WaInbox): `VITE_MANDI_KEY=tu_misma_clave`

---

## 🎨 INTEGRACIÓN CON ARTIFACT WEB

El artifact HTML de Mandarina Republic ya usa `fetch` a la API de Anthropic directamente.
Para migrarlo al agente:

```javascript
// Reemplaza la función callAgent en el artifact por:
async function callAgent(phone, userMessage) {
  const res = await fetch('https://mandi-agent.vercel.app/api/agent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mandi-key': 'TU_MANDI_KEY'
    },
    body: JSON.stringify({
      phone,
      message: userMessage,
      source: 'artifact'
    })
  });
  return await res.json();
}
```

---

## 🏗️ ESTRUCTURA DEL PROYECTO

```
mandi-agent/
├── api/
│   ├── agent.js      ← Endpoint principal (Make, WaInbox, Artifact)
│   ├── status.js     ← Health check
│   └── session.js    ← Gestión de sesiones
├── lib/
│   ├── systemPrompt.js  ← Prompt del agente + detección de intención
│   ├── shopify.js       ← Integración Shopify Admin API
│   └── sessions.js      ← Memoria de conversaciones en memoria
├── .env.example      ← Variables de entorno
├── vercel.json       ← Config CORS y funciones
└── package.json
```

---

## 💡 PRÓXIMOS PASOS SUGERIDOS

1. **Redis para sesiones persistentes** — Actualmente la memoria vive en RAM de Vercel (se resetea en cold starts). Para producción real, usa Upstash Redis (gratis hasta 10k req/día).

2. **Google Sheets como log** — Guardar cada conversación en Sheets para análisis.

3. **Webhook de Shopify** — Actualizar cache de productos automáticamente cuando cambies stock.

4. **Rate limiting por phone** — Limitar a X mensajes/hora por número.
