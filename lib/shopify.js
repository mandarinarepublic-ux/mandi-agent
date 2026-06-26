// lib/shopify.js — Shopify Admin GraphQL API

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

async function adminGraphQL(query, variables = {}) {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    console.error('Shopify: missing env vars');
    return null;
  }
  try {
    const url = `https://${SHOPIFY_STORE}/admin/api/2024-10/graphql.json`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN
      },
      body: JSON.stringify({ query, variables })
    });
    const text = await res.text();
    if (!res.ok) {
      console.error('Shopify GraphQL error:', res.status, text.slice(0, 200));
      return null;
    }
    return JSON.parse(text);
  } catch (err) {
    console.error('Shopify fetch error:', err.message);
    return null;
  }
}

function extractKeyword(message) {
  if (!message) return null;
  const lower = message.toLowerCase();
  const franchises = [
    'dragon ball','goku','vegeta','naruto','one piece','luffy','digimon',
    'ben 10','tortugas ninja','tmnt','power rangers','red ranger','white ranger',
    'black ranger','pink ranger','blue ranger','yellow ranger',
    'x-men','wolverine','magneto','gambito','ciclope','spiderman','deadpool',
    'superman','smallville','thundercats','mortal kombat','kirby',
    'snoopy','rugrats','reptar','ranma','plaza sesamo','padrinos',
    'star wars','caballeros','zodiaco','samurai','kenshin',
    'antisocial','lilo','stitch','donkey kong','fantasticos','galactus',
    'minecraft','pokemon','pikachu'
  ];
  for (const f of franchises) {
    if (lower.includes(f)) return f;
  }
  return null;
}

export async function searchProducts(message) {
  const keyword = extractKeyword(message);
  if (!keyword) return null;
  console.log('Shopify: searching keyword:', keyword);

  const gql = `
    query($query: String!) {
      products(first: 5, query: $query) {
        nodes {
          title
          handle
          images(first: 1) { nodes { url } }
          priceRangeV2 { minVariantPrice { amount } }
          variants(first: 5) {
            nodes { title inventoryQuantity }
          }
        }
      }
    }
  `;

  let data = await adminGraphQL(gql, { query: `title:*${keyword}*` });

  if (!data?.data?.products?.nodes?.length) {
    const firstWord = keyword.split(' ')[0];
    data = await adminGraphQL(gql, { query: `title:*${firstWord}*` });
  }

  if (!data?.data?.products?.nodes?.length) {
    console.log('Shopify: no products found');
    return null;
  }

  console.log('Shopify: found', data.data.products.nodes.length, 'products');
  return formatProducts(data.data.products.nodes);
}

function formatProducts(products) {
  const lines = products.map(p => {
    const price = `$${parseFloat(p.priceRangeV2?.minVariantPrice?.amount || 0).toFixed(2)}`;
    const image = p.images?.nodes?.[0]?.url || null;
    const variants = p.variants?.nodes || [];
    const available = variants.some(v => v.inventoryQuantity > 0);
    const sizes = variants
      .map(v => v.title)
      .filter(t => t !== 'Default Title')
      .slice(0, 5)
      .join(', ');

    return {
      title: p.title,
      price,
      available,
      sizes: sizes || 'Disponible',
      image,
      url: `https://${SHOPIFY_STORE}/products/${p.handle}`
    };
  });

  const context = lines.map(p =>
    `• ${p.title} — ${p.price} | ${p.available ? 'En stock' : 'Agotado'} | Tallas: ${p.sizes}\n  Imagen: ${p.image || 'sin imagen'}`
  ).join('\n\n');

  return { context, products: lines };
}
