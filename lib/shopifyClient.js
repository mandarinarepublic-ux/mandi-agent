// lib/shopifyClient.js
// Cliente directo a Shopify Admin API (GraphQL) para Mandarina Republic.
// Usa client credentials grant (Dev Dashboard app "MANDI Token").
// Maneja caché y renovación automática del token (expira cada 24h).
//
// Variables de entorno requeridas (configurar en Vercel):
//   SHOPIFY_SHOP            -> "3cnrr9-sy"
//   SHOPIFY_CLIENT_ID       -> Client ID de la app en dev.shopify.com/dashboard
//   SHOPIFY_CLIENT_SECRET   -> Client secret de la misma app

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

// Caché en memoria del token. En Vercel (serverless) esto se pierde entre
// invocaciones frías, igual que pasa hoy con sessions.js — el efecto aquí
// es solo una llamada extra ocasional para renovar el token, no un
// problema de UX para el cliente (a diferencia del historial de chat).
let cachedToken = null;
let tokenExpiresAt = 0;

export function isConfigured() {
  return Boolean(SHOP && CLIENT_ID && CLIENT_SECRET);
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const response = await fetch(
    `https://${SHOP}.myshopify.com/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(5000)
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify token request falló: HTTP ${response.status} — ${text}`);
  }

  const { access_token, expires_in } = await response.json();
  cachedToken = access_token;
  tokenExpiresAt = Date.now() + expires_in * 1000;
  return cachedToken;
}

export async function graphql(query, variables = {}) {
  if (!isConfigured()) {
    throw new Error('Shopify directo no configurado (faltan variables de entorno)');
  }

  const token = await getToken();

  const response = await fetch(
    `https://${SHOP}.myshopify.com/admin/api/2026-01/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(8000)
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify GraphQL request falló: HTTP ${response.status} — ${text}`);
  }

  const { data, errors } = await response.json();
  if (errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(errors)}`);
  }
  return data;
}

// ── BUSCAR PRODUCTOS — reemplaza al webhook de Make MANDI_SHOPIFY_QUERY ────
// Devuelve el mismo formato de texto que ya espera agent.js, para que el
// resto del código (parsing de la respuesta, conteo de productos) no
// necesite cambiar.
//
// MEJORA vs. el webhook de Make: incluye precio de comparación (descuento
// real) y stock numérico exacto por variante, no solo disponible/no
// disponible.
export async function buscarProductosDirecto(keyword) {
  const query = `
    query buscarProductos($q: String!) {
      products(first: 5, query: $q, sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            title
            handle
            descriptionHtml
            images(first: 1) { edges { node { url } } }
            options { name values }
            variants(first: 10) {
              edges {
                node {
                  price
                  compareAtPrice
                  inventoryQuantity
                  availableForSale
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphql(query, { q: keyword });
  const edges = data.products.edges;

  if (edges.length === 0) {
    return { productos: null, count: 0 };
  }

  const lineas = edges.map(({ node }) => {
    const variantePrincipal = node.variants.edges[0]?.node;
    const precio = variantePrincipal?.price || '?';
    const precioComparacion = variantePrincipal?.compareAtPrice;
    const descuentoTexto = precioComparacion && precioComparacion !== precio
      ? ` (antes $${precioComparacion})`
      : '';

    const tallas = node.options.map(o => `${o.name}: ${o.values.join(' / ')}`).join(' | ');
    const imagen = node.images.edges[0]?.node.url || '';
    const descripcion = (node.descriptionHtml || '').replace(/<[^>]*>/g, '').trim().slice(0, 200);
    const url = `https://mandarinaec.com/products/${node.handle}`;

    return `PRODUCTO: ${node.title} | PRECIO: $${precio}${descuentoTexto} | TALLAS: ${tallas} | IMAGEN: ${imagen} | URL: ${url} | DESCRIPCION: ${descripcion}`;
  });

  return { productos: lineas.join(' ||| '), count: edges.length };
}
