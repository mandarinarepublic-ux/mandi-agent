// lib/shopifyClient.js
// Cliente directo a Shopify Admin API (GraphQL) — multi-tienda.
// Soporta MANDARINA y INDSTORE con sus propias credenciales.
//
// Variables de entorno requeridas (Vercel):
//   MANDARINA:
//     SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
//   INDSTORE:
//     IND_SHOPIFY_SHOP, IND_SHOPIFY_CLIENT_ID, IND_SHOPIFY_CLIENT_SECRET

// Config por tienda
const TIENDA_CONFIG = {
  MANDARINA: {
    shop:         process.env.SHOPIFY_SHOP,
    clientId:     process.env.SHOPIFY_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
    storeUrl:     'https://mandarinaec.com',
  },
  INDSTORE: {
    shop:         process.env.IND_SHOPIFY_SHOP,
    clientId:     process.env.IND_SHOPIFY_CLIENT_ID,
    clientSecret: process.env.IND_SHOPIFY_CLIENT_SECRET,
    storeUrl:     'https://indlovers.com',
  },
};

// Mantener cache de token por tienda
const tokenCache = {}; // { TIENDA: { token, expiresAt } }

// Backward compat — default Mandarina
const SHOP          = process.env.SHOPIFY_SHOP;
const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

// Caché en memoria del token por tienda.
let cachedToken = null;
let tokenExpiresAt = 0;

export function isConfigured(tienda = 'MANDARINA') {
  const cfg = TIENDA_CONFIG[tienda] || TIENDA_CONFIG.MANDARINA;
  return Boolean(cfg.shop && cfg.clientId && cfg.clientSecret);
}

async function getToken(tienda = 'MANDARINA') {
  const cfg = TIENDA_CONFIG[tienda] || TIENDA_CONFIG.MANDARINA;

  if (tokenCache[tienda]?.token && Date.now() < tokenCache[tienda].expiresAt - 60_000) {
    return tokenCache[tienda].token;
  }

  const response = await fetch(
    `https://${cfg.shop}.myshopify.com/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
      signal: AbortSignal.timeout(5000)
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify token request falló (${tienda}): HTTP ${response.status} — ${text}`);
  }

  const { access_token, expires_in } = await response.json();
  tokenCache[tienda] = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
  return access_token;
}

export async function graphql(query, variables = {}, tienda = 'MANDARINA') {
  if (!isConfigured(tienda)) {
    throw new Error(`Shopify directo no configurado para ${tienda} (faltan variables de entorno)`);
  }

  const cfg = TIENDA_CONFIG[tienda] || TIENDA_CONFIG.MANDARINA;
  const token = await getToken(tienda);

  const response = await fetch(
    `https://${cfg.shop}.myshopify.com/admin/api/2026-01/graphql.json`,
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
    throw new Error(`Shopify GraphQL request falló (${tienda}): HTTP ${response.status} — ${text}`);
  }

  const { data, errors } = await response.json();
  if (errors?.length) {
    throw new Error(`Shopify GraphQL errors (${tienda}): ${JSON.stringify(errors)}`);
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
export async function buscarProductosDirecto(keyword, tienda = 'MANDARINA') {
  const cfg = TIENDA_CONFIG[tienda] || TIENDA_CONFIG.MANDARINA;

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

  const data = await graphql(query, { q: keyword }, tienda);
  const edges = data.products.edges;

  if (edges.length === 0) {
    return { productos: null, count: 0 };
  }

  const lineas = edges.map(({ node }) => {
    const variantePrincipal = node.variants.edges[0]?.node;
    const precio = variantePrincipal?.price || '?';
    const precioComparacion = variantePrincipal?.compareAtPrice;
    const descuentoTexto = precioComparacion && precioComparacion !== precio
      ? ` (antes ${precioComparacion})`
      : '';

    const tallas = node.options.map(o => `${o.name}: ${o.values.join(' / ')}`).join(' | ');
    const imagen = node.images.edges[0]?.node.url || '';
    const descripcion = (node.descriptionHtml || '').replace(/<[^>]*>/g, '').trim().slice(0, 200);
    const url = `${cfg.storeUrl}/products/${node.handle}`;

    return `PRODUCTO: ${node.title} | PRECIO: ${precio}${descuentoTexto} | TALLAS: ${tallas} | IMAGEN: ${imagen} | URL: ${url} | DESCRIPCION: ${descripcion}`;
  });

  return { productos: lineas.join(' ||| '), count: edges.length };
}
