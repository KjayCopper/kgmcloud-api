const express = require('express');const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const http = require('http');
const https = require('https');


const app = express();
app.use(express.json());


const pool = mysql.createPool({
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
});


const APP_URL = process.env.APP_URL || 'https://kgmcloud.co.uk';


let VAT_RATE = 20;
let VAT_ENABLED = false;
let VAT_RATES = {};
let STAFF_DISCOUNT_PERCENT = 0;

const EXTRA_RATES = { AU: 10, NZ: 15, JP: 10, NO: 25, CH: 8.1, CA: 5, IL: 17, SG: 9, KR: 10, TR: 20, IN: 18 };


let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    connectionOptions: { lookup: require('node:dns').lookup },
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}


/* ---------- email templates ---------- */

const fs = require('fs');
const path = require('path');

const EMAIL_TEMPLATE_DIR = path.join(__dirname, 'email-templates');
const EMAIL_TEMPLATE_CACHE = {};

function loadEmailTemplate(name) {
  if (!EMAIL_TEMPLATE_CACHE[name]) {
    EMAIL_TEMPLATE_CACHE[name] = fs.readFileSync(path.join(EMAIL_TEMPLATE_DIR, name + '.html'), 'utf8');
  }
  return EMAIL_TEMPLATE_CACHE[name];
}

function renderEmailTemplate(name, vars) {
  let html = loadEmailTemplate(name);
  for (const [key, value] of Object.entries(vars || {})) {
    html = html.split('{' + key + '}').join(value == null ? '' : String(value));
  }
  return html;
}

function currencySymbol(currency) {
  return currency === 'GBP' ? '£' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : (currency || 'GBP') + ' ';
}


/* Never let a single bad request tear the whole API down. */
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));


const pendingCheckouts = new Map();


function slugify(str) {
  let base = String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  if (!base) base = 'product';
  return base;
}


async function uniqueSlug(db, name, currentId) {
  const base = slugify(name);
  const take = async (s) => {
    const [rows] = currentId
      ? await db.query('SELECT id FROM products WHERE slug=? AND id<>?', [s, currentId])
      : await db.query('SELECT id FROM products WHERE slug=?', [s]);
    return rows.length > 0;
  };
  let n = 2;
  let candidate = base;
  while (await take(candidate)) candidate = `${base}-${n++}`;
  return candidate;
}


function vatOf(gross) {
  const net = Math.round((gross / (1 + VAT_RATE / 100)) * 100) / 100;
  const vat = Math.round((gross - net) * 100) / 100;
  return { net, vat };
}


function vatCalc(country, totalGross) {
  if (!VAT_ENABLED) return { rate: 0, net: totalGross, vat: 0, gross: totalGross };
  const homeRate = Number(VAT_RATE) || 20;
  const map = VAT_RATES || {};
  let rate = Number(map[country]);
  if (!(rate >= 0)) rate = country === 'GB' ? homeRate : 0;
  rate = Number(rate) || 0;
  const ratio = (1 + rate / 100) / (1 + homeRate / 100);
  const gross = Math.round(totalGross * ratio * 100) / 100;
  const net = rate > 0 ? Math.round((gross / (1 + rate / 100)) * 100) / 100 : gross;
  const vat = Math.round((gross - net) * 100) / 100;
  return { rate, net, vat, gross };
}


function getJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(new Error('request timeout')));
  });
}


function getClientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '');
  const first = fwd.split(',')[0].trim();
  if (first) return first;
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null;
}


async function geoCountry(ip) {
  if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.')) return 'GB';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return null;
  try {
    const data = await getJson('https://ipwho.is/' + encodeURIComponent(ip));
    const code = String(data.country_code || '').toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) return code;
  } catch (e) {
    console.error('geo lookup failed:', e.message);
  }
  return null;
}


async function refreshVatRates() {
  const map = { ...EXTRA_RATES };
  try {
    const data = await getJson('https://euvatrates.com/rates.json?rate_type=standard');
    for (const [code, r] of Object.entries((data && data.rates) || {})) {
      const v = Number(r && r.standard_rate);
      if (Number.isFinite(v) && v > 0) map[String(code).toUpperCase()] = v;
    }
  } catch (e) {
    console.error('vat rate refresh failed:', e.message);
  }
  map.GB = Number(VAT_RATE) || 20;
  VAT_RATES = map;
  try {
    const [r] = await pool.query(`SELECT value FROM settings WHERE \`key\`='vat_rates'`);
    if (r.length) await pool.query(`UPDATE settings SET \`value\`=? WHERE \`key\`='vat_rates'`, [JSON.stringify(map)]);
    else await pool.query(`INSERT INTO settings (\`key\`, \`value\`) VALUES ('vat_rates', ?)`, [JSON.stringify(map)]);
  } catch (e) {
    console.error('vat rate cache save failed:', e.message);
  }
  return VAT_RATES;
}


const TOS_SECTIONS = [
  {
    title: '1. About KGM Cloud',
    body: 'KGM Cloud supplies digital products and tools for Roblox roleplay servers, led by KGM-ELS, a fully customisable emergency lighting system with Vehicle-to-Vehicle (V2V) synchronisation. Our trading details are: KGM Cloud (a trading name) operated by Kieran McCrudden at 75 Norman Rise, Livingston, West Lothian EH54 6LZ. You can contact us at Info@kgmcloud.co.uk or using the support tools inside your account. KGM Cloud is a trader providing digital content to consumers.',
  },
  {
    title: '2. Definitions',
    body: 'In these Terms the following words have these meanings:',
    points: [
      'Account: the customer account you create on the KGM Cloud website.',
      'We / Us / Our: KGM Cloud, the trader supplying the products.',
      'You / Your: the person using the website, creating an account, or purchasing a product.',
      'Product: any digital content, system, script, configuration pack, tool, documentation or licence supplied by us.',
      'Order: a request to purchase one or more Products placed by you at checkout.',
      'Digital Content: any product supplied to you in electronic form, including downloads and licence keys.',
      'Licence: the permission granted to you to use a Product in accordance with these Terms and any applicable product terms.',
      'Process, Services and Licencing: definitions are provided where they appear below.',
    ],
  },
  {
    title: '3. Your KGM Cloud Account',
    body: 'Some Products require an account so that you can manage your purchases, downloads and licences. When creating an account you must provide accurate and complete information, and you must keep it up to date. You are responsible for keeping your login details confidential, and for all activity that happens through your account. You must be at least 13 years old to use this site or create an account; if you are under 16 you confirm that your parent or guardian has agreed to these Terms on your behalf. We may refuse to register, or suspend, an account in accordance with section 12.',
  },
  {
    title: '4. Products',
    body: 'Our Products are digital only; no physical goods are shipped. Each Product listing describes what you are buying, its requirements, and any licence or account requirements. Prices shown are in pounds sterling (GBP) and include VAT applying to the order where required by law. Product listings and pricing may change at any time, but the price you pay is the price shown at the moment you place your Order. Following successful payment, that price is fixed for that Order.',
  },
  {
    title: '5. Orders and Payments',
    body: 'When you place an Order you are making an offer to purchase the Products in your cart. A contract is formed when we accept your payment successfully. Payment is processed securely through our payment provider (SumUp). You must not use the Services in breach of our Acceptable Use terms. We may decline or refuse to accept an Order in certain circumstances, including where we suspect fraud, misuse or a breach of these Terms. Discount codes may be applied to Orders subject to the rules shown when the code is created; a code is only consumed on successful payment.',
  },
  {
    title: '6. Digital Delivery',
    body: 'Once your payment is confirmed, we begin supplying the Digital Content immediately. Products are delivered to your Account: you will get access to downloads, configuration packs, documentation and, where applicable, the licence keys issued to your Account. Where a product requires a licence, the key is generated and linked to your Account during the Order. If delivery is interrupted or fails, we will re-send or restore your access without additional charge. The consent you give at checkout (see section 7) applies to every Order.',
  },
  {
    title: '7. Digital Content and Cancellation',
    body: 'Under the Consumer Contracts (Information, Cancellation and Additional Charges) Regulations 2013 you normally have 14 days from placing an Order to cancel it. Because our Products are digital content supplied immediately, that right is lost once supply begins where you have given express consent and acknowledged that you lose the right to cancel. At checkout you are asked to give that express consent and acknowledgement: by ticking the consent box you agree that supply begins immediately after payment, you consent to supply during the 14-day cooling-off period, and you waive the right to cancel once the Product has been delivered. Full details are in our Digital Products, Cancellation & Refunds policy.',
  },
  {
    title: '8. Refunds and Consumer Rights',
    body: 'Because of the express consent in section 7, refunds are not available for Digital Content that has been supplied. This does not affect your statutory rights under the Consumer Rights Act 2015: if a Product is faulty, defective, broken or not as described, you are entitled to a repair, a replacement or a refund as provided by law, and we will honour that. Where a refund is due, it will be issued to the original payment method unless you agree otherwise. Nothing in these Terms removes or limits any rights you have as a consumer under the laws of the United Kingdom.',
  },
  {
    title: '9. Product Licences',
    body: 'Products that require a licence are issued to you as a licence key linked to your Account. A licence is personal to you and non-transferable. Each licence key may be linked to up to the number of Roblox games shown for that product (by default a maximum of three linked games at one time); if you change games, your used slot is freed when you unlink a game. You may use a licensed Product only for your own purposes. You may not resell, redistribute, sublicense, share, publish or give away a licence key, a Product, or the files or documentation that make up a Product.',
  },
  {
    title: '10. Intellectual Property',
    body: 'All Products, and all source code, scripts, assets, files, documentation, branding, names and trademarks associated with KGM Cloud, are owned by or licensed to KGM Cloud. Buying a Product grants you only the limited licence described in these Terms; it does not transfer ownership, and you acquire no other rights to the underlying intellectual property. You may not copy, modify, create derivative works from, reverse engineer, decompile or otherwise extract source code or assets from a Product, except where we have expressly allowed it in the Product documentation.',
  },
  {
    title: '11. Acceptable Use',
    body: 'When using the website, your Account or our Products you must not:',
    points: [
      'resell, redistribute, sublicense or give away our Products or files, or offer them as part of another product or service;',
      'share, publish or allow others to use your licence keys;',
      'bypass, crack, disable or interfere with any licence or DRM controls, or help others to do so;',
      'reverse engineer, decompile or extract source code from any Product;',
      'use our Products in a way that breaks the Roblox Terms of Use, or the terms of any platform your servers run on;',
      'use the website or your Account to commit fraud, misrepresent who you are, or interfere with the service.',
    ],
  },
  {
    title: '12. Account, Licence and Service Enforcement',
    body: 'If you breach these Terms, including the Acceptable Use rules, we may take any of the following steps, in our reasonable judgement: issue a warning; suspend or terminate your Account; revoke or suspend a licence key or access to a Product; or cancel an Order without a refund where the breach has caused the Order to be lost or misused. We are not obliged to do this in any particular order. Genuinely faulty or misdescribed Products are handled under section 8 and are not affected by this section. If you believe action has been taken against you in error, contact us and we will review it.',
  },
  {
    title: '13. Third-Party Services',
    body: 'Our Products run on the Roblox platform. Roblox Corporation is not a party to these Terms, and the operation of your servers and games on Roblox is subject to the Roblox Terms of Use and Community Rules. If your Roblox account or a server is affected by Roblox own enforcement, that is between you and Roblox; we are not responsible for third-party platform actions. Payments are processed by SumUp, whose terms apply to the payment transaction itself. Links to third parties on our site are not endorsements, and we are not responsible for their content.',
  },
  {
    title: '14. Website and Service Availability',
    body: 'We aim to keep the website, checkout and Account features available and reliable, but we do not guarantee that they will be uninterrupted or error-free. We may carry out maintenance and scheduled downtime, and we may update products, documentation and features at any time. Where an interruption to our own systems prevents you from downloading a product you have bought, we will restore access as soon as reasonably possible.',
  },
  {
    title: '15. Liability',
    body: 'Nothing in these Terms limits or excludes our liability for death or personal injury caused by our negligence, for fraud or fraudulent misrepresentation, or for anything that cannot lawfully be limited or excluded for a consumer in the United Kingdom. To the extent permitted by law, and subject to your statutory rights in section 8, our total liability to you for any loss arising out of or in connection with these Terms or an Order will not exceed the amount you paid for the Products concerned. We are not liable for indirect or consequential losses such as lost profits, lost data, or interruptions to your Roblox servers, except where that would be unlawful. Products are provided using reasonable care and skill; you are responsible for using them in line with their documentation.',
  },
  {
    title: '16. Changes to KGM Cloud and These Terms',
    body: 'We may update the Products, the website and these Terms from time to time. Where a change to these Terms affects you, we will tell you (for example by email or an in-account announcement) before it takes effect, and you may cancel any continuing use of your Account or the service if you do not agree. The Terms in force at the time an Order is placed apply to that Order. Continuing to use the site or your Account after a change takes effect means you accept the updated Terms.',
  },
  {
    title: '17. Governing Law and Jurisdiction',
    body: 'These Terms are governed by the laws of the United Kingdom as they apply in England and Wales, Scotland, and Northern Ireland, and they give consumers in each of those jurisdictions the same rights. Nothing removes any statutory protection that applies to you where you live. If a dispute arises, you may bring proceedings in the courts of the country in which you live, and we submit to the jurisdiction of the courts of the United Kingdom.',
  },
  {
    title: '18. Complaints and Contact',
    body: 'If you are unhappy about anything, contact us first and we will do our best to resolve it. You can reach us at Info@kgmcloud.co.uk or through the support tools in your Account, and we will respond as soon as possible. If we cannot resolve a complaint, you can get free, independent advice from your local consumer advice service: Citizens Advice (England and Wales), Consumer Advice Scotland (Scotland), or Consumerline (Northern Ireland). These organisations may refer matters to Trading Standards where appropriate, and this does not affect any rights you have to seek a remedy through the courts.',
  },
  {
    title: '19. General Terms',
    body: 'These Terms (together with the Digital Products, Cancellation & Refunds policy, the Cookie Policy and any product documentation) form the entire agreement between you and us about your use of the website and your Orders. If any part of these Terms is found to be invalid or unenforceable, the rest continues to apply. Our failure to enforce a term is not a waiver of it. We may transfer our rights and obligations under these Terms to another business as part of a sale or reorganisation, but that will not affect your rights. Nothing in these Terms creates rights for any third party.',
  },
];

const DIGITAL_SECTIONS = [
  {
    title: '1. What you are buying',
    body: 'All products supplied by KGM Cloud are digital content: downloadable software, scripts, systems, configuration packs, licences and other electronic files delivered to your account. No physical goods are shipped.',
  },
  {
    title: '2. Immediate supply of digital content',
    body: 'Once we have successfully received your payment, we begin supplying the digital content immediately. Download access, unless it is already available to you, is made available in your account as soon as practical after payment is confirmed. Because of this, the following express consent applies to every order.',
  },
  {
    title: '3. Express consent and waiver of the right to cancel',
    body: 'Under the Consumer Contracts (Information, Cancellation and Additional Charges) Regulations 2013 you normally have 14 days from placing an order to cancel it (the "cooling-off period"). For digital content, that right is lost once supply begins if you have given express consent to supply starting immediately and you acknowledge that you lose the right to cancel.',
  },
  {
    title: '4. What your consent means in practice',
    body: 'By ticking the consent box at checkout you confirm, on every order: (a) you agree that supply of the digital content begins immediately after your payment is accepted; (b) you give your express consent to the supply beginning during the 14-day cooling-off period; and (c) you acknowledge that, because you do so, you waive your right to cancel the order under the 14-day cooling-off provisions once supply has begun.',
  },
  {
    title: '5. Cancellation before supply begins',
    body: 'A cancellation request made before your purchase has been fully processed and the digital content supplied may be honoured where possible. Because supply of digital content happens automatically on successful payment, the practical window for this is very short. Once download access, a licence key or the digital files have been made available to you, supply is treated as having begun.',
  },
  {
    title: '6. No refunds after delivery',
    body: 'Refunds are therefore not available for orders for digital content that has been supplied, because the 14-day right to cancel has been expressly waived as described above. This does not affect your statutory rights under the Consumer Rights Act 2015: if digital content is faulty, defective or not as described, you remain entitled to a repair, replacement or a refund as provided by law.',
  },
  {
    title: '7. Faulty or misdescribed content',
    body: 'If a product is broken, incomplete, or does not match its listing, contact us and we will investigate. Where the issue is confirmed, we will repair or replace the content, or provide a refund, in accordance with the Consumer Rights Act 2015. Nothing in this policy removes your statutory rights.',
  },
  {
    title: '8. How to contact us',
    body: 'For any enquiry about this policy, or to report a problem with a purchase, use the account tools or contact our support team. We will respond as soon as possible.',
  },
  {
    title: '9. How the law applies across the United Kingdom',
    body: 'Consumer protection law for digital content applies across the whole of the United Kingdom. The Consumer Rights Act 2015 and the Consumer Contracts (Information, Cancellation and Additional Charges) Regulations 2013 give you the same rights in every part of the UK, whether you live in:',
    points: [
      'England and Wales, enforced through the County Court;',
      'Scotland, enforceable through the Sheriff Court, with independent consumer advice available from Consumer Advice Scotland;',
      'Northern Ireland, enforced through the County Court, with consumer advice available from Consumerline.',
    ],
  },
  {
    title: '10. Governing law',
    body: 'This policy is governed by the laws of the United Kingdom as they apply in England and Wales, Scotland, and Northern Ireland. Nothing in this policy limits or removes any of your statutory rights in any part of the United Kingdom.',
  },
];

async function seedLegalSettings() {
  const seeds = [
    ['tos_updated_at', '2026-09-19'],
    ['digital_policy_updated_at', '2026-09-19'],
    ['tos_sections', JSON.stringify(TOS_SECTIONS)],
    ['digital_policy_sections', JSON.stringify(DIGITAL_SECTIONS)],
  ];
  for (const [key, value] of seeds) {
    try {
      const [r] = await pool.query(`SELECT value FROM settings WHERE \`key\`=?`, [key]);
      if (!r.length) await pool.query(`INSERT INTO settings (\`key\`, \`value\`) VALUES (?,?)`, [key, value]);
    } catch (e) {
      console.error('legal settings seed failed:', key, e.message);
    }
  }
}

async function loadLegalSettings() {
  const out = {
    tos_updated_at: '2026-09-19',
    digital_policy_updated_at: '2026-09-19',
    tos_sections: TOS_SECTIONS,
    digital_policy_sections: DIGITAL_SECTIONS,
  };
  try {
    const [rows] = await pool.query(`SELECT \`key\`, \`value\` FROM settings WHERE \`key\` IN ('tos_updated_at','digital_policy_updated_at','tos_sections','digital_policy_sections')`);
    for (const r of rows) {
      if (r.key === 'tos_sections' || r.key === 'digital_policy_sections') {
        try { out[r.key] = JSON.parse(r.value); } catch { /* keep default */ }
      } else {
        out[r.key] = r.value;
      }
    }
  } catch (e) {
    console.error('legal settings load failed:', e.message);
  }
  return out;
}


function priceInfo(p) {
  let effective = Number(p.price) || 0;
  let display = '£' + effective.toFixed(2);
  let compare_at = null;
  let original = Number(p.price) || 0;
  if (p.on_sale && p.sale_price != null) {
    compare_at = display;
    effective = Number(p.sale_price);
    display = '£' + effective.toFixed(2);
  } else if (p.on_sale && p.discount_percent != null) {
    compare_at = display;
    effective = effective * (1 - (Number(p.discount_percent) / 100));
    display = '£' + effective.toFixed(2);
  }
  let ex_vat = effective;
  let vat_amount = null;
  if (VAT_ENABLED) {
    const { net, vat } = vatOf(effective);
    ex_vat = net;
    vat_amount = vat;
  }
  return { price: display, compare_at, price_value: effective, price_ex_vat: ex_vat, vat_amount, compare_at_value: original };
}


async function sendVerificationEmail(email, token, firstname) {
  if (!transporter) {
    console.log('SMTP not configured — skipping email for', email);
    return false;
  }
  const link = `${APP_URL}/verify-email?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
  const html = renderEmailTemplate('VerificationTemplate', {
    FIRSTNAME: firstname,
    VERIFY_URL: link,
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Verify your KGM Cloud account',
    html,
  });
  return true;
}


const ROLE_RANK = {
  customer: 0,
  cx_member: 1,
  product_developer: 1,
  media_member: 1,
  people_specialist: 1,
  cx_manager: 2,
  product_manager: 2,
  media_manager: 2,
  people_manager: 2,
  operations_director: 3,
  managing_director: 4,
};


function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
  pool.query('SELECT id, firstname, surname, email, role, marketing_opt_in, dob FROM users WHERE id=?', [payload.id])
    .then(async ([rows]) => {
      if (!rows.length) return void res.status(401).json({ error: 'Invalid token' });
      const u = rows[0];
      const { ids: permission_ids, permissions } = await getUserPermissions(u.id, u.role || null);
      req.user = {
        id: u.id,
        email: u.email,
        firstname: u.firstname,
        role: u.role || null,
        is_staff: u.role != null,
        marketing_opt_in: u.marketing_opt_in,
        dob: u.dob || null,
        permission_ids,
        permissions,
      };
      next();
    })
    .catch(() => res.status(500).json({ error: 'Database error' }));
}


function staff(req, res, next) {
  if (req.user.role == null || req.user.role === 'customer') return res.status(403).json({ error: 'Staff only' });
  next();
}


function perm(...needed) {
  return (req, res, next) => {
    const perms = req.user?.permissions || [];
    const ids = req.user?.permission_ids || [];
    const ok = needed.some((n) =>
      typeof n === 'number' ? ids.includes(n) : perms.includes(n)
    );
    if (!ok) {
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    next();
  };
}


async function getUserPermissions(userId, roleId) {
  const permIds = new Set();
  const addCsv = (csv) => {
    if (!csv) return;
    String(csv).split(',').map(Number).filter(Boolean).forEach((id) => permIds.add(id));
  };
  const [u] = await pool.query('SELECT team, permissions AS direct_permissions FROM users WHERE id=?', [userId]);
  if (!u.length) return { ids: [], permissions: [] };
  addCsv(u[0].direct_permissions);
  if (roleId) {
    const [r] = await pool.query('SELECT permissions FROM roles WHERE id=?', [roleId]);
    if (r.length) addCsv(r[0].permissions);
  }
  if (u[0].team) {
    const teamIds = String(u[0].team).split(',').map(Number).filter(Boolean);
    if (teamIds.length) {
      const [tRows] = await pool.query('SELECT permissions FROM teams WHERE id IN (?)', [teamIds]);
      for (const t of tRows) addCsv(t.permissions);
    }
  }
  if (!permIds.size) return { ids: [], permissions: [] };
  const [names] = await pool.query(
    'SELECT id, permission_name FROM permissions WHERE id IN (?)',
    [[...permIds]]
  );
  const namesById = new Map(names.map((n) => [n.id, n.permission_name]));
  const ids = [...permIds].sort((a, b) => a - b);
  return {
    ids,
    permissions: ids.map((id) => namesById.get(id)).filter(Boolean),
  };
}


async function init() {
  const c = await pool.getConnection();


  try {
    const [srows] = await c.query(`SELECT value FROM settings WHERE \`key\`='vat_rate'`);
    VAT_RATE = srows.length ? Number(srows[0].value) || 20 : 20;
  } catch (e) {
    VAT_RATE = 20;
  }

  try {
    const [erows] = await c.query(`SELECT value FROM settings WHERE \`key\`='vat_enabled'`);
    VAT_ENABLED = erows.length ? String(erows[0].value) === '1' : false;
  } catch (e) {
    VAT_ENABLED = false;
  }

  try {
    const [rrows] = await c.query(`SELECT value FROM settings WHERE \`key\`='vat_rates'`);
    try { VAT_RATES = rrows.length ? (JSON.parse(rrows[0].value) || {}) : {}; }
    catch (e) { VAT_RATES = {}; }
  } catch (e) {
    VAT_RATES = {};
  }
  refreshVatRates().catch((e) => console.error('vat rate refresh failed:', e.message));
  seedLegalSettings().catch((e) => console.error('legal settings seed failed:', e.message));

  try {
    await c.query(`INSERT INTO settings (\`key\`, \`value\`) VALUES ('staff_discount_percent', '0')
      ON DUPLICATE KEY UPDATE \`key\`=\`key\``);
  } catch (e) { /* settings table may not exist yet */ }
  await loadStaffDiscountPercent();


  const [colCheck] = await c.query(`SHOW COLUMNS FROM users LIKE 'role'`);
  if (!colCheck.length) {
    await c.query('ALTER TABLE users ADD COLUMN role INT NULL');
  }


  const [mgCol] = await c.query(`SHOW COLUMNS FROM products LIKE 'max_games_per_license'`);
  if (!mgCol.length) {
    await c.query(`ALTER TABLE products ADD COLUMN max_games_per_license INT DEFAULT 3`);
  }
  await c.query(`UPDATE products SET max_games_per_license=3 WHERE max_games_per_license IS NULL OR max_games_per_license<1`);
  await c.query(
    `UPDATE licenses l JOIN products p ON p.id=l.product_id
     SET l.max_games=p.max_games_per_license WHERE p.max_games_per_license IS NOT NULL`);


  try {
    await c.query(`ALTER TABLE tickets
      MODIFY status ENUM('open','awaiting_cx','awaiting_customer','resolved','closed') NOT NULL DEFAULT 'open'`);
  } catch (e) { /* pre-ticket-release databases have no tickets table yet */ }

  try {
    const [col] = await c.query(`SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'tickets' AND column_name = 'transaction_id'`);
    if (Number(col[0].n) === 0) {
      await c.query(`ALTER TABLE tickets ADD COLUMN transaction_id VARCHAR(128) NULL DEFAULT NULL AFTER customer_id`);
    }
  } catch (e) { /* pre-ticket-release databases have no tickets table yet */ }

  try {
    const [col] = await c.query(`SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'tickets' AND column_name = 'resolved_at'`);
    if (Number(col[0].n) === 0) {
      await c.query(`ALTER TABLE tickets ADD COLUMN resolved_at TIMESTAMP NULL DEFAULT NULL`);
    }
    /* Backfill resolution time from updated_at so tickets resolved before this column existed
       still count towards the weekly metric. Runs every boot, safe to repeat. */
    await c.query(`UPDATE tickets SET resolved_at = updated_at
      WHERE status IN ('resolved','closed') AND resolved_at IS NULL`);
  } catch (e) { /* pre-ticket-release databases have no tickets table yet */ }

  try {
    const [col] = await c.query(`SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'ticket_messages' AND column_name = 'is_note'`);
    if (Number(col[0].n) === 0) {
      await c.query(`ALTER TABLE ticket_messages ADD COLUMN is_note TINYINT(1) NOT NULL DEFAULT 0`);
    }
  } catch (e) { /* pre-ticket-release databases have no ticket_messages table yet */ }

  try {
    const [col] = await c.query(`SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'company_chat_messages' AND column_name = 'team_id'`);
    if (Number(col[0].n) === 0) {
      await c.query(`ALTER TABLE company_chat_messages ADD COLUMN team_id INT NULL DEFAULT 0`);
    }
  } catch (e) { /* pre-chat-release databases have no company_chat_messages table yet */ }

  try {
    const [col] = await c.query(`SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'company_announcements' AND column_name = 'team_id'`);
    if (Number(col[0].n) === 0) {
      await c.query(`ALTER TABLE company_announcements ADD COLUMN team_id INT NULL DEFAULT 0`);
    }
  } catch (e) { /* pre-announcements-release databases have no company_announcements table yet */ }

  c.release();
  console.log('database ready');
}


/* ---- public auth ---- */


app.post('/api/auth/register', async (req, res) => {
  const { firstname, surname, email, password, tos, marketing_opt_in } = req.body;
  if (!firstname || !surname || !email || !password || password.length < 8)
    return res.status(400).json({ error: 'firstname, surname, email and password (min 8 chars) required' });
  if (!tos)
    return res.status(400).json({ error: 'You must accept the Terms of Service to create an account' });
  const hash = await bcrypt.hash(password, 10);
  const token = crypto.randomBytes(32).toString('hex');
  try {
    await pool.query(
      'INSERT INTO users (firstname, surname, email, password_hash, email_token, tos, marketing_opt_in) VALUES (?,?,?,?,?,1,?)',
      [firstname, surname, email, hash, token, marketing_opt_in ? 1 : 0]
    );
    let emailed = false;
    try {
      emailed = await sendVerificationEmail(email, token, firstname);
    } catch (e) {
      console.error('email send failed:', e.message);
    }
    res.json({ ok: true, email_sent: emailed });
  } catch { res.status(409).json({ error: 'Email already registered' }); }
});


app.post('/api/auth/verify-email', async (req, res) => {
  const { email, token } = req.body;
  if (!email || !token) return res.status(400).json({ error: 'email and token required' });
  const [rows] = await pool.query('SELECT id FROM users WHERE email=? AND email_token=?', [email, token]);
  if (!rows.length) return res.status(400).json({ error: 'Invalid or expired verification link' });
  await pool.query('UPDATE users SET email_verified=1, email_token=NULL WHERE email=?', [email]);
  res.json({ ok: true });
});


app.post('/api/auth/resend-verification', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const [rows] = await pool.query('SELECT firstname, email_verified, email_token FROM users WHERE email=?', [email]);
  if (!rows.length) return res.status(404).json({ error: 'No account found for that email' });
  if (rows[0].email_verified) return res.status(400).json({ error: 'Email already verified' });
  const token = rows[0].email_token || crypto.randomBytes(32).toString('hex');
  if (!rows[0].email_token) {
    await pool.query('UPDATE users SET email_token=? WHERE email=?', [token, email]);
  }
  let emailed = false;
  try {
    emailed = await sendVerificationEmail(email, token, rows[0].firstname);
  } catch (e) {
    console.error('email send failed:', e.message);
  }
  res.json({ ok: true, email_sent: emailed });
});


app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const [rows] = await pool.query('SELECT * FROM users WHERE email=?', [email]);
  if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
  if (!(await bcrypt.compare(password, rows[0].password_hash)))
    return res.status(401).json({ error: 'Invalid credentials' });
  if (!rows[0].email_verified) return res.status(403).json({ error: 'Email not verified' });
  const { ids: permission_ids, permissions } = await getUserPermissions(rows[0].id, rows[0].role || null);
  const is_staff = rows[0].role != null;
  const home_team_id = null;
  const team_ids = [];
  const managed_team_ids = [];
  const token = jwt.sign(
    { id: rows[0].id, email: rows[0].email, role: rows[0].role || null, home_team_id, team_ids, managed_team_ids, permissions },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({ token, user: { id: rows[0].id, firstname: rows[0].firstname, surname: rows[0].surname, email: rows[0].email, role: rows[0].role || null, is_staff, marketing_opt_in: !!rows[0].marketing_opt_in, home_team_id, team_ids, managed_team_ids, permission_ids, permissions }, purchases: [] });
});


app.get('/api/auth/me', auth, async (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      firstname: req.user.firstname,
      surname: req.user.surname,
      email: req.user.email,
      role: req.user.role,
      is_staff: req.user.is_staff,
      marketing_opt_in: !!req.user.marketing_opt_in,
      dob: req.user.dob || null,
      home_team_id: null,
      team_ids: [],
      managed_team_ids: [],
      permission_ids: req.user.permission_ids,
      permissions: req.user.permissions,
    },
  });
});




/* ---- public catalog ---- */


app.get('/api/categories', async (_req, res) => {
  const [rows] = await pool.query('SELECT id, name, slug FROM categories ORDER BY name ASC');
  res.json(rows);
});


app.get('/api/settings', async (_req, res) => {
  await loadStaffDiscountPercent();
  res.json({ vat_rate: VAT_RATE, vat_enabled: VAT_ENABLED, vat_inclusive: VAT_ENABLED, vat_rates: VAT_RATES, staff_discount_percent: STAFF_DISCOUNT_PERCENT });
});


app.get('/api/geo/country', async (req, res) => {
  try {
    const ip = getClientIp(req);
    const code = await geoCountry(ip);
    res.json({ country: code || null });
  } catch (e) {
    console.error('geo country lookup failed:', e.message);
    res.json({ country: null });
  }
});


app.post('/api/settings/refresh-vat-rates', auth, staff, perm(33), async (_req, res) => {
  await refreshVatRates();
  res.json({ ok: true, vat_rates: VAT_RATES });
});


app.put('/api/settings', auth, staff, perm(33), async (req, res) => {
  const save = async (key, val) => {
    const [r] = await pool.query(`SELECT value FROM settings WHERE \`key\`=?`, [key]);
    if (r.length) await pool.query(`UPDATE settings SET \`value\`=? WHERE \`key\`=?`, [val, key]);
    else await pool.query(`INSERT INTO settings (\`key\`, \`value\`) VALUES (?,?)`, [key, val]);
  };
  const vat_enabled = !!req.body.vat_enabled;
  let vat_rate = Number(req.body.vat_rate);
  if (!Number.isFinite(vat_rate) || vat_rate < 0 || vat_rate > 100) vat_rate = VAT_RATE;
  let vat_rates = req.body.vat_rates;
  const isRateMap = vat_rates && typeof vat_rates === 'object' && !Array.isArray(vat_rates);
  vat_rates = isRateMap ? vat_rates : VAT_RATES;
  let staff_discount_percent = Number(req.body.staff_discount_percent);
  if (!Number.isFinite(staff_discount_percent) || staff_discount_percent < 0 || staff_discount_percent > 100) {
    staff_discount_percent = STAFF_DISCOUNT_PERCENT;
  }
  VAT_ENABLED = vat_enabled;
  VAT_RATE = vat_rate;
  VAT_RATES = vat_rates;
  STAFF_DISCOUNT_PERCENT = staff_discount_percent;
  for (const [key, val] of [
    ['vat_enabled', vat_enabled ? '1' : '0'],
    ['vat_rate', String(vat_rate)],
    ['vat_rates', JSON.stringify(vat_rates)],
    ['staff_discount_percent', String(staff_discount_percent)],
  ]) {
    try {
      await save(key, val);
    } catch (e) {
      console.error(`settings save '${key}' failed:`, e.message);
    }
  }
  res.json({ ok: true, vat_rate: VAT_RATE, vat_enabled: VAT_ENABLED, vat_inclusive: VAT_ENABLED, vat_rates: VAT_RATES, staff_discount_percent: STAFF_DISCOUNT_PERCENT });
});


app.get('/api/staff/discounts/customers', auth, staff, perm(35), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const like = `%${q}%`;
  const [rows] = await pool.query(
    `SELECT id, firstname, surname, email FROM users
     WHERE firstname LIKE ? OR surname LIKE ? OR email LIKE ?
     ORDER BY id DESC LIMIT 8`,
    [like, like, like]
  );
  res.json(rows);
});


app.get('/api/staff/discounts', auth, staff, perm(34), async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT d.id, d.code, d.type, d.value, d.user_id, d.max_uses, d.uses_count,
              d.per_user_limit, d.valid_from, d.valid_to, d.active, d.revoked_at, d.revoked_reason,
              d.revoked_by, d.created_at,
              u.firstname AS user_firstname, u.surname AS user_surname, u.email AS user_email,
              rv.firstname AS revoked_by_firstname, rv.surname AS revoked_by_surname
       FROM discount_codes d
       LEFT JOIN users u ON u.id = d.user_id
       LEFT JOIN users rv ON rv.id = d.revoked_by
       ORDER BY d.created_at DESC`
    );
    res.json(rows.map((r) => ({ ...r, active: !!r.active })));
  } catch (e) {
    console.error('list discounts failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/staff/discounts', auth, staff, perm(35), async (req, res) => {
  try {
    const type = String(req.body.type || 'percent') === 'fixed' ? 'fixed' : 'percent';
    const value = Math.round(Number(req.body.value) * 100) / 100;
    if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'Enter a discount value' });
    if (type === 'percent' && value > 100) return res.status(400).json({ error: 'Percentage cannot exceed 100' });
    const user_id = Number(req.body.user_id) ? Number(req.body.user_id) : null;
    if (user_id && user_id === req.user.id) {
      return res.status(400).json({ error: 'You cannot create a discount code for yourself' });
    }
    let max_uses = Number(req.body.max_uses);
    max_uses = Number.isInteger(max_uses) && max_uses > 0 ? max_uses : null;
    let per_user_limit = Number(req.body.per_user_limit);
    per_user_limit = Number.isInteger(per_user_limit) && per_user_limit > 0 ? per_user_limit : null;
    const validFrom = req.body.valid_from ? new Date(req.body.valid_from) : null;
    const validTo = req.body.valid_to ? new Date(req.body.valid_to) : null;
    if ((validFrom && Number.isNaN(validFrom.getTime())) || (validTo && Number.isNaN(validTo.getTime()))) {
      return res.status(400).json({ error: 'Invalid date' });
    }
    let customer = null;
    if (user_id) {
      const [us] = await pool.query('SELECT id, firstname, email FROM users WHERE id=?', [user_id]);
      if (!us.length) return res.status(400).json({ error: 'User not found' });
      customer = us[0];
    }
    let code = '';
    for (let i = 0; i < 20; i += 1) {
      code = generateDiscountCode();
      const [dup] = await pool.query('SELECT id FROM discount_codes WHERE code=?', [code]);
      if (!dup.length) break;
    }
    const [dup] = await pool.query('SELECT id FROM discount_codes WHERE code=?', [code]);
    if (dup.length) return res.status(400).json({ error: 'Code generation failed, try again' });
    const active = req.body.active !== false;
    const [ins] = await pool.query(
      `INSERT INTO discount_codes (code, type, value, user_id, max_uses, per_user_limit, valid_from, valid_to, active)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [code, type, value, user_id, max_uses, per_user_limit, validFrom, validTo, active ? 1 : 0]
    );
    let email_sent = false;
    const email_customer = req.body.email_customer === true || req.body.email_customer === '1';
    if (customer && email_customer) {
      email_sent = await sendDiscountEmail(customer.email, customer.firstname, code, type, value, validTo);
    }
    res.json({
      ok: true,
      email_sent,
      discount: {
        id: ins.insertId,
        code,
        type,
        value,
        user_id,
        max_uses,
        per_user_limit,
        valid_from: validFrom,
        valid_to: validTo,
        active,
      },
    });
  } catch (e) {
    console.error('create discount failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/staff/discounts/:id/revoke', auth, staff, perm(35), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Add a reason for revoking this code' });
    const [codes] = await pool.query(
      'SELECT id, code, revoked_at, active FROM discount_codes WHERE id=?',
      [id]
    );
    if (!codes.length) return res.status(404).json({ error: 'Discount code not found' });
    if (codes[0].revoked_at) return res.status(409).json({ error: 'That code has already been revoked' });
    await pool.query(
      'UPDATE discount_codes SET active=0, revoked_at=NOW(), revoked_reason=?, revoked_by=? WHERE id=?',
      [reason.slice(0, 200), req.user.id, id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('revoke discount failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});


/* ---- staff: disputes ---- */


async function purchaseEvidence(p) {
  let snapshot = null;
  try { snapshot = JSON.parse(p.items_price || 'null'); } catch { snapshot = null; }
  const items = [];
  let subtotal = 0;
  if (Array.isArray(snapshot) && snapshot.length) {
    for (const s of snapshot) {
      const pid = Number(s && s.product_id);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const price = Math.round((Number(s.price) || 0) * 100) / 100;
      const existing = items.find((it) => it.product_id === pid);
      if (existing) existing.qty += 1;
      else {
        items.push({ product_id: pid, name: String(s.name || 'Product'), price, qty: 1 });
        subtotal = Math.round((subtotal + price) * 100) / 100;
      }
    }
  } else {
    const ids = String(p.items_purchased || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length) {
      const [prods] = await pool.query('SELECT id, name, price FROM products WHERE id IN (?)', [ids]);
      const byId = new Map(prods.map((r) => [r.id, r]));
      for (const pid of ids) {
        const prod = byId.get(pid);
        if (!prod) continue;
        const existing = items.find((it) => it.product_id === pid);
        if (existing) existing.qty += 1;
        else items.push({ product_id: pid, name: prod.name, price: Number(prod.price) || 0, qty: 1 });
      }
      subtotal = Math.round(items.reduce((s, it) => s + it.price * it.qty, 0) * 100) / 100;
    }
  }
  let keys = [];
  try { keys = JSON.parse(p.license_keys || '[]'); } catch { keys = []; }
  const license_keys = [];
  if (Array.isArray(keys) && keys.length) {
    const keyList = keys.map((k) => k && k.license_key).filter(Boolean);
    let statusMap = {};
    if (keyList.length) {
      const [lc] = await pool.query('SELECT license_key, status FROM licenses WHERE license_key IN (?)', [keyList]);
      statusMap = Object.fromEntries(lc.map((r) => [r.license_key, r.status]));
    }
    for (const k of keys) {
      if (!k || !k.license_key) continue;
      license_keys.push({ product_id: k.product_id, product_name: k.product_name, license_key: k.license_key, status: statusMap[k.license_key] || 'unknown' });
    }
  }
  return {
    purchase_id: Number(p.id),
    transactionid: p.checkout_reference,
    sumup_transaction: p.sumup_checkout_id || null,
    date: p.created_at,
    country: p.country || null,
    vat_rate: p.vat_rate ?? null,
    vat_amount: p.vat_amount ?? null,
    items,
    license_keys,
    subtotal: Math.round(subtotal * 100) / 100,
    discount: p.discount_code ? { code: p.discount_code, percent: p.discount_percent ?? null, amount: p.discount_amount ?? null } : null,
    total: Math.round((Number(p.amount) || 0) * 100) / 100,
    currency: p.currency || 'GBP',
    digital_consent: !!p.digital_consent,
    digital_consent_at: p.digital_consent_at || null,
    digital_consent_ip: p.digital_consent_ip || null,
  };
}

async function licensingKeysOf(purchase) {
  let keys = [];
  try { keys = JSON.parse(purchase.license_keys || '[]'); } catch { keys = []; }
  return Array.isArray(keys) ? keys.map((k) => k && k.license_key).filter(Boolean) : [];
}

async function suspendLicensesForPurchase(purchase) {
  const keyList = await licensingKeysOf(purchase);
  if (keyList.length) {
    await pool.query(`UPDATE licenses SET status='suspended' WHERE license_key IN (?) AND status='active'`, [keyList]);
  }
}

async function restoreLicensesForPurchase(purchase) {
  const keyList = await licensingKeysOf(purchase);
  if (keyList.length) {
    await pool.query(`UPDATE licenses SET status='active' WHERE license_key IN (?) AND status='suspended'`, [keyList]);
  }
}

async function ensureDispute(purchaseId, raisedBy) {
  const [existing] = await pool.query("SELECT * FROM disputes WHERE purchase_id=? AND status='pending'", [purchaseId]);
  if (existing.length) return { dispute: existing[0], created: false };
  await pool.query('INSERT INTO disputes (purchase_id, raised_by) VALUES (?,?)', [purchaseId, raisedBy]);
  const [rows] = await pool.query('SELECT * FROM disputes WHERE purchase_id=? ORDER BY id DESC LIMIT 1', [purchaseId]);
  return { dispute: rows[0], created: true };
}

app.get('/api/staff/disputes/users', auth, staff, perm(33), async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const like = `%${q}%`;
    const [rows] = q
      ? await pool.query(`SELECT id, firstname, surname, email, role FROM users WHERE firstname LIKE ? OR surname LIKE ? OR email LIKE ? ORDER BY firstname ASC LIMIT 50`, [like, like, like])
      : await pool.query(`SELECT id, firstname, surname, email, role FROM users ORDER BY firstname ASC LIMIT 50`);
    res.json({ users: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/staff/disputes/users/:id/transactions', auth, staff, perm(33), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const [user] = await pool.query('SELECT id, firstname, surname FROM users WHERE id=?', [userId]);
    if (!user.length) return res.status(404).json({ error: 'User not found' });
    const [purchases] = await pool.query(
      `SELECT id, checkout_reference AS transactionid, amount, currency, created_at AS date
       FROM purchases WHERE userid=? AND status='PAID' ORDER BY created_at DESC`,
      [userId]
    );
    const [drows] = await pool.query(
      `SELECT d.id, d.purchase_id, d.status, d.settled_at, d.created_at AS raised_at
       FROM disputes d JOIN purchases p ON p.id=d.purchase_id WHERE p.userid=?`,
      [userId]
    );
    const disputeByPurchase = new Map();
    for (const d of drows) {
      const prev = disputeByPurchase.get(d.purchase_id);
      if (!prev || new Date(d.raised_at) > new Date(prev.raised_at)) disputeByPurchase.set(d.purchase_id, d);
    }
    res.json({
      user: user[0],
      transactions: purchases.map((t) => ({
        ...t,
        dispute: disputeByPurchase.get(t.id) || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/staff/disputes/document', auth, staff, perm(33), async (req, res) => {
  try {
    const userId = Number(req.query.user_id);
    const purchaseId = Number(req.query.purchase_id);
    if (!Number.isInteger(userId) || !Number.isInteger(purchaseId)) {
      return res.status(400).json({ error: 'user_id and purchase_id required' });
    }
    const [users] = await pool.query('SELECT id, firstname, surname, email, created_at, tos FROM users WHERE id=?', [userId]);
    if (!users.length) return res.status(404).json({ error: 'User not found' });
    const [purchases] = await pool.query(`SELECT * FROM purchases WHERE id=? AND userid=? AND status='PAID'`, [purchaseId, userId]);
    if (!purchases.length) return res.status(404).json({ error: 'Transaction not found' });
    const purchase = purchases[0];
    const { dispute, created } = await ensureDispute(purchaseId, req.user.id);
    await suspendLicensesForPurchase(purchase);
    const legal = await loadLegalSettings();
    const evidence = await purchaseEvidence(purchase);

    const [priorRows] = await pool.query(
      `SELECT p.*, d.id AS dispute_id, d.status AS dispute_status, d.created_at AS dispute_raised_at, d.settled_at AS dispute_settled_at
       FROM purchases p JOIN disputes d ON d.purchase_id = p.id
       WHERE p.userid=? AND p.status='PAID' AND p.id <> ?
       ORDER BY p.created_at DESC LIMIT 5`,
      [userId, purchaseId]
    );
    const disputed_history = [];
    for (const pr of priorRows) {
      const e = await purchaseEvidence(pr);
      disputed_history.push({
        ...e,
        dispute: { id: pr.dispute_id, status: pr.dispute_status, raised_at: pr.dispute_raised_at, settled_at: pr.dispute_settled_at },
      });
    }
    const [cntRows] = await pool.query(
      `SELECT COUNT(*) AS n FROM purchases WHERE userid=? AND status='PAID' AND id<>?`,
      [userId, purchaseId]
    );
    const prior_total = Number(cntRows[0].n);

    const [tickets] = await pool.query(
      `SELECT id, title, status, transaction_id, created_at, updated_at
       FROM tickets WHERE customer_id=? AND transaction_id=? ORDER BY created_at DESC`,
      [userId, purchase.checkout_reference]
    );
    const ticketsOut = [];
    for (const t of tickets) {
      const [msgs] = await pool.query(
        `SELECT tm.id, tm.user_id, tm.body, tm.is_note, tm.created_at, u.firstname AS sender_firstname, u.role AS sender_role
         FROM ticket_messages tm JOIN users u ON u.id=tm.user_id
         WHERE tm.ticket_id=? ORDER BY tm.created_at ASC`, [t.id]);
      ticketsOut.push({ ...t, messages: msgs });
    }

    res.json({
      generated_at: new Date().toISOString(),
      generated_by: { id: req.user.id, firstname: req.user.firstname, surname: req.user.surname },
      account: {
        id: users[0].id,
        firstname: users[0].firstname,
        surname: users[0].surname,
        email: users[0].email,
        created_at: users[0].created_at,
        tos_agreed: !!users[0].tos,
      },
      dispute: { id: dispute.id, status: dispute.status, raised_at: dispute.created_at, settled_at: dispute.settled_at || null, newly_raised: created },
      legal: {
        tos_updated_at: legal.tos_updated_at,
        tos_sections: legal.tos_sections,
        digital_policy_updated_at: legal.digital_policy_updated_at,
        digital_policy_sections: legal.digital_policy_sections,
      },
      transaction: evidence,
      disputed_history,
      prior_statistics: { total: prior_total, disputed: disputed_history.length },
      tickets: ticketsOut,
    });
  } catch (e) {
    console.error('dispute document failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/staff/disputes/:id/settle', auth, staff, perm(33), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const outcome = String(req.body.outcome || '') === 'restore' ? 'restore' : 'uphold';
    const [disputes] = await pool.query('SELECT * FROM disputes WHERE id=?', [id]);
    if (!disputes.length) return res.status(404).json({ error: 'Dispute not found' });
    const [purchases] = await pool.query(`SELECT * FROM purchases WHERE id=?`, [disputes[0].purchase_id]);
    if (purchases.length && outcome === 'restore') {
      await restoreLicensesForPurchase(purchases[0]);
    }
    await pool.query('UPDATE disputes SET status=? , settled_at=NOW(), settled_by=? WHERE id=?', ['settled', req.user.id, id]);
    res.json({ ok: true, outcome });
  } catch (e) {
    console.error('settle dispute failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/products', async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT id, name, slug, category_id, short_description, price, on_sale, discount_percent,
            sale_price, disclaimer, requires_license, pinned, media_json, files_json, documentation_url, created_at
     FROM products WHERE active=1 ORDER BY pinned DESC, id ASC`
  );
  res.json(rows.map((r) => {
    let media = [];
    try { media = JSON.parse(r.media_json || '[]'); } catch { /* ignore */ }
    const first = media.find((m) => m && m.type === 'image') || media[0];
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      category_id: r.category_id,
      short_description: r.short_description,
      disclaimer: !!r.disclaimer,
      requires_license: !!r.requires_license,
      pinned: !!r.pinned,
      image_url: first ? first.path : null,
      files: (() => { try { return JSON.parse(r.files_json || '[]'); } catch { return []; } })(),
      documentation_url: r.documentation_url || null,
      media,
      ...priceInfo(r),
    };
  }));
});


app.get('/api/products/:slug', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT * FROM products WHERE slug=? AND active=1`,
    [req.params.slug]
  );
  if (!rows.length) return res.status(404).json({ error: 'Product not found' });
  const p = rows[0];
  let media = [];
  let features = [];
  let files = [];
  try { media = JSON.parse(p.media_json || '[]'); } catch { /* ignore */ }
  try { features = JSON.parse(p.features_json || '[]'); } catch { /* ignore */ }
  try { files = JSON.parse(p.files_json || '[]'); } catch { /* ignore */ }
  let category = null;
  if (p.category_id) {
    const [cats] = await pool.query('SELECT id, name, slug FROM categories WHERE id=?', [p.category_id]);
    category = cats[0] || null;
  }
  res.json({
    id: p.id,
    name: p.name,
    slug: p.slug,
    category,
    short_description: p.short_description,
    description: p.description,
    documentation_url: p.documentation_url,
    demo_url: p.productdemo_url || null,
    disclaimer: !!p.disclaimer,
    requires_license: !!p.requires_license,
    media,
    features,
    files,
    ...priceInfo(p),
  });
});


/* ---- SEO meta page (served to crawlers requesting /products/...) ---- */

const SEO_ORIGIN = 'https://kgmcloud.co.uk';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function metaDescription(p) {
  const raw = p.short_description || String(p.description || '').replace(/<[^>]+>/g, ' ');
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length > 158 ? text.slice(0, 157).trimEnd() + '…' : text;
}

app.get('/products/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  const [rows] = await pool.query('SELECT * FROM products WHERE slug=? AND active=1', [slug]);

  if (!rows.length) {
    return res
      .status(404)
      .type('html')
      .send(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Product not found | KGM Cloud</title></head><body><h1>Product not found</h1><p><a href="https://kgmcloud.co.uk/products">Back to the store</a></p></body></html>'
      );
  }

  const p = rows[0];
  let media = [];
  try { media = JSON.parse(p.media_json || '[]'); } catch { /* ignore */ }
  const firstImg = media.find((m) => m && m.type === 'image') || media[0] || null;
  const image = firstImg && firstImg.path
    ? (/^https?:\/\//i.test(firstImg.path) ? firstImg.path : SEO_ORIGIN + firstImg.path)
    : SEO_ORIGIN + '/og-image.png';
  const url = SEO_ORIGIN + '/products/' + p.slug;
  const title = String(p.name || 'KGM Cloud product') + ' | KGM Cloud';
  const desc = metaDescription(p);
  const eTitle = escapeHtml(title);
  const eDesc = escapeHtml(desc);
  const eUrl = escapeHtml(url);
  const eImg = escapeHtml(image);

  const productJson = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: String(p.name || 'KGM Cloud product'),
    image,
    description: desc,
    category: p.category_id ? String(p.category_id) : undefined,
    brand: { '@type': 'Brand', name: 'KGM Cloud' },
    url,
    offers: {
      '@type': 'Offer',
      url,
      price: priceInfo(p).price_value,
      priceCurrency: 'GBP',
      availability: 'https://schema.org/InStock',
    },
  };

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="index, follow">
    <title>${eTitle}</title>
    <meta name="description" content="${eDesc}">
    <link rel="canonical" href="${eUrl}">
    <meta property="og:type" content="product">
    <meta property="og:site_name" content="KGM Cloud">
    <meta property="og:title" content="${eTitle}">
    <meta property="og:description" content="${eDesc}">
    <meta property="og:url" content="${eUrl}">
    <meta property="og:image" content="${eImg}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${eTitle}">
    <meta name="twitter:description" content="${eDesc}">
    <meta name="twitter:image" content="${eImg}">
    <script type="application/ld+json">${JSON.stringify(productJson)}</script>
  </head>
  <body>
    <p><a href="${eUrl}">${eTitle}</a> — ${eDesc}</p>
  </body>
</html>`;

  res.set('Cache-Control', 'public, max-age=300').type('html').send(html);
});


/* ---- sumup checkout ---- */






/* ---- sumup checkout ---- */


async function sumupFetch(path, opts = {}) {
  const key = process.env.SUMUP_API_KEY;
  if (!key) throw new Error('SUMUP_API_KEY is not set');
  const res = await fetch('https://api.sumup.com' + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) {
    const msg = data.detail || data.message || data.error_description || ('SumUp error ' + res.status);
    throw new Error(msg);
  }
  return data;
}




async function sendPurchaseConfirmation(userId, reference, productIds, total, currency) {
  if (!transporter) {
    console.log('SMTP not configured - skipping confirmation email for', reference);
    return false;
  }
  const [users] = await pool.query('SELECT firstname, email FROM users WHERE id=?', [userId]);
  if (!users.length) return false;
  const u = users[0];
  const [prods] = await pool.query('SELECT id, name, price FROM products WHERE id IN (?)', [productIds]);
  const items = productIds
    .map((pid) => prods.find((p) => p.id === pid))
    .filter(Boolean)
    .map((p) => ({ name: p.name, price: Number(p.price) || 0 }));
  const subtotal = Math.round(items.reduce((sum, i) => sum + i.price, 0) * 100) / 100;
  const amount = Number.isFinite(Number(total))
    ? Math.round(Number(total) * 100) / 100
    : subtotal;
  const discount = Math.round((subtotal - Number(amount)) * 100) / 100;
  const symbol = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency + ' ';
  const itemRows = items.length
    ? items.map((i) => `<tr><td style="padding:10px 12px;border-bottom:1px solid #26304a;color:#e2e8f0">${i.name}</td><td style="padding:10px 12px;border-bottom:1px solid #26304a;color:#e2e8f0;text-align:right">${symbol}${i.price.toFixed(2)}</td></tr>`).join('')
    : '<tr><td style="padding:10px 12px;color:#94a3b8">Digital content</td><td style="padding:10px 12px;text-align:right;color:#e2e8f0">-</td></tr>';
  const discountRows = discount > 0
    ? `<tr><td style="padding:10px 12px;border-bottom:1px solid #26304a;color:#94a3b8">Subtotal</td><td style="padding:10px 12px;border-bottom:1px solid #26304a;color:#e2e8f0;text-align:right">${symbol}${subtotal.toFixed(2)}</td></tr><tr><td style="padding:10px 12px;border-bottom:1px solid #26304a;color:#4ade80">Discount</td><td style="padding:10px 12px;border-bottom:1px solid #26304a;color:#4ade80;text-align:right">-${symbol}${discount.toFixed(2)}</td></tr>`
    : '';
  const rowsHtml = itemRows + discountRows;
  const downloadLink = `${APP_URL}/account?tab=downloads`;
  const html = renderEmailTemplate('OrderConfirmedTemplate', {
    FIRSTNAME: u.firstname,
    ORDER_KEY: reference,
    ITEMS_ROWS: rowsHtml,
    DISCOUNT_ROWS: discountRows,
    SYMBOL: symbol,
    TOTAL: amount.toFixed(2),
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: u.email,
    subject: 'KGM Cloud order ' + reference + ' - payment confirmed',
    html,
  });
  return true;
}


function generateDiscountCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const rnd = crypto.randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i += 1) s += chars[rnd[i] % chars.length];
  return 'KGM-' + s;
}


async function sendDiscountEmail(email, firstname, code, type, value, validTo, opts = {}) {
  if (!transporter) {
    console.log('SMTP not configured - skipping discount email for', email);
    return false;
  }
  const valueLabel = type === 'percent'
    ? `${Math.round(Number(value) * 100) / 100}% off`
    : `${currencySymbol('GBP')}${Math.round((Number(value) || 0) * 100) / 100} off`;
  const validLabel = validTo
    ? `Use it before ${new Date(validTo).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`
    : 'Use it on your next order';
  const isBirthday = !!opts.birthday;
  const html = isBirthday
    ? renderEmailTemplate('BirthdayTemplate', {
        FIRSTNAME: firstname,
        VALUE_LABEL: valueLabel,
        CODE: code,
        VALID_TO: validLabel,
        CTA_URL: APP_URL + '/',
        CTA_LABEL: 'Start shopping',
        CTA_FALLBACK: APP_URL + '/',
      })
    : renderEmailTemplate('DiscountTemplate', {
        FIRSTNAME: firstname,
        VALUE_LABEL: valueLabel,
        CODE: code,
        VALID_TO: validLabel,
      });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: isBirthday
      ? `Happy birthday from KGM Cloud - ${valueLabel} just for you`
      : `${valueLabel} at KGM Cloud - code: ${code}`,
    html,
  });
  return true;
}


async function grantPurchase(userid, itemCsv, amount, currency, reference, sumupCheckoutId, country, vatRate, vatAmount, discountCode, discountPercent, discountAmount, digitalConsent, digitalConsentAt, digitalConsentIp) {
  const ids = String(itemCsv).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const keys = [];
  let snapshot = [];
  if (ids.length) {
    const [all] = await pool.query(
      'SELECT id, name, price, requires_license, max_games_per_license FROM products WHERE id IN (?)',
      [ids]
    );
    const byId = new Map(all.map((p) => [p.id, p]));
    for (const pid of ids) {
      const prod = byId.get(pid);
      if (!prod) continue;
      if (prod.requires_license) {
        const key = crypto.randomBytes(24).toString('hex');
        await pool.query('INSERT INTO licenses (license_key, product_id, user_id, max_games) VALUES (?,?,?,?)',
          [key, pid, userid, prod.max_games_per_license || 3]);
        keys.push({ product_id: pid, product_name: prod.name, license_key: key });
      }
      snapshot.push({ product_id: pid, name: prod.name, price: Number(prod.price) || 0 });
    }
  }
  await pool.query(
    `INSERT INTO purchases (checkout_reference, sumup_checkout_id, userid, amount, currency, items_purchased, status, license_keys, country, vat_rate, vat_amount, items_price, discount_code, discount_percent, discount_amount, digital_consent, digital_consent_at, digital_consent_ip)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [reference, sumupCheckoutId || null, userid, amount, currency || 'GBP', itemCsv, 'PAID', JSON.stringify(keys), country || null, vatRate ?? null, vatAmount ?? null, JSON.stringify(snapshot), discountCode || null, discountPercent ?? 0, discountAmount ?? 0, digitalConsent ? 1 : 0, digitalConsentAt || null, digitalConsentIp || null]
  );
  if (discountCode) {
    await consumeDiscount(discountCode, userid);
  }
  try {
    await sendPurchaseConfirmation(userid, reference, ids, Number(amount) || 0, currency || 'GBP');
  } catch (e) {
    console.error('confirmation email failed:', e.message);
  }
}


async function finalizePurchase(checkout, basket) {
  const reference = String(checkout.checkout_reference || '');
  if (!reference || !basket) return;
  const [existing] = await pool.query('SELECT id FROM purchases WHERE checkout_reference=?', [reference]);
  if (existing.length) {
    await pool.query('UPDATE order_requests SET status=?, purchase_id=? WHERE checkout_reference=? AND status=?',
      ['completed', existing[0].id, reference, 'approved']);
    return;
  }
  const txSuccess = Array.isArray(checkout.transactions)
    ? checkout.transactions.some((t) => t && t.status === 'SUCCESSFUL')
    : false;
  if (checkout.status !== 'SUCCESSFUL' && !txSuccess) return;
  await grantPurchase(basket.userid, basket.items_purchased, basket.amount, basket.currency, reference, basket.sumup_checkout_id, basket.country || null, basket.vat_rate ?? null, basket.vat_amount ?? null, basket.discount_code || null, basket.discount_percent ?? null, basket.discount_amount ?? null, basket.digital_consent, basket.digital_consent_at, basket.digital_consent_ip);
  const [pRow] = await pool.query('SELECT id FROM purchases WHERE checkout_reference=?', [reference]);
  if (pRow.length) {
    await pool.query('UPDATE order_requests SET status=?, purchase_id=? WHERE checkout_reference=? AND status=?',
      ['completed', pRow[0].id, reference, 'approved']);
  }
}


async function resolveDiscount(code, userid, subtotal) {
  const c = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!c) return null;
  const [rows] = await pool.query('SELECT * FROM discount_codes WHERE code=?', [c]);
  if (!rows.length) return { error: 'Invalid code' };
  const d = rows[0];
  if (!d.active || d.revoked_at) return { error: 'This discount code is no longer valid' };
  const now = new Date();
  if (d.valid_from && new Date(d.valid_from) > now) return { error: 'This code is not active yet' };
  if (d.valid_to && new Date(d.valid_to) < now) return { error: 'This code has expired' };
  if (d.user_id && Number(d.user_id) !== Number(userid)) return { error: 'This code is not available to you' };
  if (d.max_uses && (Number(d.uses_count) || 0) >= Number(d.max_uses)) {
    return { error: 'This code has reached its usage limit' };
  }
  if (d.per_user_limit) {
    const [uses] = await pool.query(
      'SELECT COUNT(*) AS n FROM purchases WHERE discount_code=? AND userid=? AND status=?',
      [c, userid, 'PAID']
    );
    if (Number(uses[0].n) >= Number(d.per_user_limit)) return { error: 'You have already used this code' };
  }
  const base = Math.round((Number(subtotal) || 0) * 100) / 100;
  let amount_off = 0;
  if (d.type === 'fixed') {
    amount_off = Math.min(Math.round(Number(d.value) * 100) / 100, base);
  } else {
    amount_off = Math.round((base * Math.min(Number(d.value), 100)) / 100 * 100) / 100;
  }
  return {
    code: c,
    type: d.type,
    value: Number(d.value),
    amount_off: Math.round(amount_off * 100) / 100,
    user_id: d.user_id ? Number(d.user_id) : null,
    max_uses: d.max_uses ? Number(d.max_uses) : null,
    per_user_limit: d.per_user_limit ? Number(d.per_user_limit) : null,
  };
}

async function consumeDiscount(code, userid) {
  const [dcs] = await pool.query('SELECT id, max_uses, uses_count, revoked_at FROM discount_codes WHERE code=?', [code]);
  if (!dcs.length) return;
  const d = dcs[0];
  if (d.max_uses && (Number(d.uses_count) || 0) >= Number(d.max_uses)) return;
  await pool.query(
    'UPDATE discount_codes SET uses_count = uses_count + 1 WHERE id=? AND (max_uses IS NULL OR uses_count < max_uses)',
    [d.id]
  );
  await pool.query(
    'INSERT INTO discount_code_uses (code_id, user_id, used, created_at) VALUES (?,?,1,NOW()) ON DUPLICATE KEY UPDATE used = used + 1',
    [d.id, userid]
  );
}


/* ---- birthday discount job ---- */

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysApart(a, b) {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86400000);
}

function nextBirthday(dob, from) {
  const b = new Date(`${dob}T00:00:00`);
  let cand = new Date(from.getFullYear(), b.getMonth(), b.getDate());
  if (daysApart(from, cand) < 0) cand = new Date(from.getFullYear() + 1, b.getMonth(), b.getDate());
  return cand;
}

function mondayBefore(d) {
  const dow = d.getDay();
  const back = dow === 1 ? 7 : dow === 0 ? 6 : dow - 1;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
}

async function loadBirthdayPercent() {
  try {
    const [r] = await pool.query(`SELECT value FROM settings WHERE \`key\`='birthday_discount_percent'`);
    const v = Number(r[0] && r[0].value);
    return Number.isFinite(v) && v > 0 ? v : 10;
  } catch {
    return 10;
  }
}

async function loadStaffDiscountPercent() {
  try {
    const [r] = await pool.query(`SELECT value FROM settings WHERE \`key\`='staff_discount_percent'`);
    const v = Number(r[0] && r[0].value);
    STAFF_DISCOUNT_PERCENT = Number.isFinite(v) && v > 0 ? Math.min(v, 100) : 0;
  } catch {
    STAFF_DISCOUNT_PERCENT = 0;
  }
}

async function seedBirthdaySettings() {
  try {
    const [r] = await pool.query(`SELECT value FROM settings WHERE \`key\`='birthday_discount_percent'`);
    if (!r.length) await pool.query(`INSERT INTO settings (\`key\`, \`value\`) VALUES ('birthday_discount_percent', '10')`);
  } catch (e) {
    console.error('birthday settings seed failed:', e.message);
  }
}

async function runBirthdayScan(now = new Date()) {
  try {
    const percent = await loadBirthdayPercent();
    const [users] = await pool.query('SELECT id, firstname, surname, email, dob FROM users WHERE dob IS NOT NULL');
    let issued = 0;
    for (const u of users) {
      const bday = nextBirthday(u.dob, now);
      const openFrom = mondayBefore(bday);
      if (now < openFrom || now >= bday) continue;
      const bdayStr = `${bday.getFullYear()}-${String(bday.getMonth() + 1).padStart(2, '0')}-${String(bday.getDate()).padStart(2, '0')}`;
      const [ex] = await pool.query('SELECT id FROM discount_codes WHERE user_id=? AND DATE(valid_from)=?', [u.id, bdayStr]);
      if (ex.length) continue;
      let code = '';
      for (let i = 0; i < 20; i += 1) {
        code = generateDiscountCode();
        const [dup] = await pool.query('SELECT id FROM discount_codes WHERE code=?', [code]);
        if (!dup.length) break;
      }
      const validTo = addMonths(bday, 1);
      await pool.query(
        `INSERT INTO discount_codes (code, type, value, user_id, max_uses, per_user_limit, valid_from, valid_to, active)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [code, 'percent', percent, u.id, 1, 1, bday, validTo, 1]
      );
      try {
        await sendDiscountEmail(u.email, u.firstname, code, 'percent', percent, validTo, { birthday: true });
      } catch (e) {
        console.error('birthday email failed:', e.message);
      }
      issued += 1;
    }
    if (issued) console.log(`birthday scan: issued ${issued} code(s)`);
    return issued;
  } catch (e) {
    console.error('birthday scan failed:', e.message);
    return 0;
  }
}

function msUntilNextMonday0900(now = new Date()) {
  const nxt = startOfDay(now);
  const daysToMonday = (8 - nxt.getDay()) % 7;
  const alreadyMonday = nxt.getDay() === 1;
  if (!alreadyMonday) nxt.setDate(nxt.getDate() + daysToMonday);
  nxt.setHours(9, 0, 0, 0);
  return Math.max(1000, nxt.getTime() - now.getTime());
}

function scheduleBirthdayScan() {
  const delay = msUntilNextMonday0900();
  setTimeout(() => {
    runBirthdayScan().finally(scheduleBirthdayScan);
  }, delay);
}

/* TEMPORARY test endpoint - NO AUTH. Remove after email test. */
/* ---- ticket reply reminders ---- */

const TICKET_REMINDER_HOURS = 24;

async function runTicketReminderScan() {
  try {
    const [due] = await pool.query(
      `SELECT tm.id AS msg_id, tm.ticket_id, tm.user_id AS staff_id, t.title, tm.created_at,
              u.email, u.firstname
       FROM ticket_messages tm
       JOIN tickets t ON t.id = tm.ticket_id
       JOIN users u ON u.id = t.customer_id
       JOIN users su ON su.id = tm.user_id
       WHERE tm.is_note = 0
         AND su.role IS NOT NULL
         AND tm.reminder_sent_at IS NULL
         AND tm.created_at <= DATE_SUB(NOW(), INTERVAL ${TICKET_REMINDER_HOURS} HOUR)
         AND t.status IN ('open','awaiting_customer')
AND NOT EXISTS (
            SELECT 1 FROM ticket_messages m2
            WHERE m2.ticket_id = tm.ticket_id
              AND m2.is_note = 0
              AND (m2.created_at > tm.created_at OR (m2.created_at = tm.created_at AND m2.id > tm.id))
          )`
    );
    let reminded = 0;
    for (const r of due) {
      let sent = false;
      try {
        sent = await sendTicketReminderEmail({ id: r.ticket_id, title: r.title }, { email: r.email, firstname: r.firstname });
      } catch (e) {
        console.error('ticket reminder email failed:', e.message);
      }
      if (sent) {
        await pool.query('UPDATE ticket_messages SET reminder_sent_at=NOW() WHERE id=?', [r.msg_id]);
        reminded += 1;
      }
    }
    if (reminded) console.log(`ticket reminder scan: sent ${reminded} reminder(s)`);

    const [toClose] = await pool.query(
      `SELECT tm.id AS msg_id, tm.ticket_id, tm.user_id AS staff_id, t.title, u.email AS customer_email, u.firstname AS customer_firstname
       FROM ticket_messages tm
       JOIN tickets t ON t.id = tm.ticket_id
       JOIN users su ON su.id = tm.user_id
       JOIN users u ON u.id = t.customer_id
       WHERE tm.is_note = 0
         AND su.role IS NOT NULL
         AND tm.reminder_sent_at IS NOT NULL
         AND tm.reminder_sent_at <= DATE_SUB(NOW(), INTERVAL ${TICKET_REMINDER_HOURS} HOUR)
         AND t.status IN ('open','awaiting_customer')
AND NOT EXISTS (
            SELECT 1 FROM ticket_messages m2
            WHERE m2.ticket_id = tm.ticket_id
              AND m2.is_note = 0
              AND (m2.created_at > tm.created_at OR (m2.created_at = tm.created_at AND m2.id > tm.id))
          )`
    );
    let closed = 0;
    for (const r of toClose) {
      await pool.query(
        `INSERT INTO ticket_messages (ticket_id, user_id, body, is_note, sender_type)
         VALUES (?,?,?,1,?)`,
        [r.ticket_id, r.staff_id, 'Closed automatically - no customer response within 48 hours of the last staff reply.', 'staff']
      );
      await pool.query(`UPDATE tickets SET status='closed' WHERE id=?`, [r.ticket_id]);
      try {
        await sendTicketClosedEmail({ firstname: r.customer_firstname, email: r.customer_email });
      } catch (e) {
        console.error('ticket close email failed for ticket', r.ticket_id, ':', e.message);
      }
      closed += 1;
    }
    if (closed) console.log(`ticket reminder scan: auto-closed ${closed} ticket(s)`);
  } catch (e) {
    console.error('ticket reminder scan failed:', e.message);
  }
}

function scheduleTicketReminderScan() {
  setTimeout(() => {
    runTicketReminderScan().finally(scheduleTicketReminderScan);
  }, 30 * 60 * 1000);
}


app.post('/api/checkout/validate-code', auth, async (req, res) => {
  try {
    const subtotal = Math.round((Number(req.body.subtotal) || 0) * 100) / 100;
    const r = await resolveDiscount(req.body.code, req.user.id, subtotal);
    if (!r || r.error) return res.status(400).json({ error: (r && r.error) || 'Invalid code' });
    res.json({ ok: true, code: r.code, type: r.type, value: r.value, amount_off: r.amount_off });
  } catch (e) {
    console.error('validate discount failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/checkout', auth, async (req, res) => {
  try {
    const ids = (req.body.items || []).map((i) => Number(i && i.id)).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return res.status(400).json({ error: 'Cart is empty' });
    if (req.body.digital_consent !== true && req.body.digital_consent !== '1' && req.body.digital_consent !== 1) {
      return res.status(400).json({ error: 'You must accept the digital delivery terms before you can pay' });
    }
    const country = String(req.body.country || '').trim().slice(0, 100);
    if (!country) return res.status(400).json({ error: 'Country is required for tax and VAT purposes' });
    const uniq = [...new Set(ids)];
    const [rows] = await pool.query('SELECT id, name, price FROM products WHERE id IN (?) AND active=1', [uniq]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = uniq.filter((n) => !byId.has(n));
    if (missing.length) return res.status(400).json({ error: 'Some products are unavailable' });
    const itemTotal = Math.round(uniq.reduce((sum, n) => sum + Number(byId.get(n).price || 0), 0) * 100) / 100;
    const tax = vatCalc(country, itemTotal);
    let discountCode = null;
    let discountPercent = 0;
    let discountAmount = 0;

    let staffPct = 0;
    if (req.user && req.user.is_staff) {
      await loadStaffDiscountPercent();
      staffPct = STAFF_DISCOUNT_PERCENT;
    }
    const wantStaff = staffPct > 0 && (req.body.staff_discount === true || req.body.staff_discount === '1' || req.body.staff_discount === 1);
    const staffAmount = wantStaff ? Math.min(Math.round((tax.gross * staffPct) / 100 * 100) / 100, tax.gross) : 0;

    const dcInput = String(req.body.discount_code || '').trim();
    if (dcInput) {
      const r = await resolveDiscount(dcInput, req.user.id, tax.gross);
      if (!r || r.error) return res.status(400).json({ error: (r && r.error) || 'Invalid code' });
      discountCode = r.code;
      discountAmount = r.amount_off;
      discountPercent = r.type === 'percent' ? Number(r.value) || 0 : 0;
    }
    if (staffAmount > 0 && staffAmount > discountAmount) {
      discountCode = 'STAFF-AUTO';
      discountPercent = staffPct;
      discountAmount = staffAmount;
    }
    const amount = Math.max(0, Math.round((tax.gross - discountAmount) * 100) / 100);
    const consentAt = new Date();
    const consentIp = getClientIp(req);
    const reference = 'kgm-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    const base = (process.env.APP_URL || 'https://kgmcloud.co.uk').replace(/\/$/, '');
    const checkout = await sumupFetch('/v0.1/checkouts', {
      method: 'POST',
      body: JSON.stringify({
        checkout_reference: reference,
        amount,
        currency: 'GBP',
        merchant_code: process.env.SUMUP_MERCHANT_CODE,
        description: 'KGM Cloud order ' + reference,
        return_url: base + '/api/checkout/webhook',
        redirect_url: base + '/checkout?payment=done&ref=' + reference,
        hosted_checkout: { enabled: true },
      }),
    });
    pendingCheckouts.set(reference, {
      userid: req.user.id,
      items_purchased: uniq.join(','),
      amount,
      currency: 'GBP',
      country: country || null,
      vat_rate: tax.rate,
      vat_amount: tax.vat,
      discount_code: discountCode,
      discount_percent: discountPercent,
      discount_amount: discountAmount,
      digital_consent: 1,
      digital_consent_at: consentAt,
      digital_consent_ip: consentIp,
      sumup_checkout_id: checkout.id || null,
    });
    res.json({ checkout_id: checkout.id, checkout_reference: reference, hosted_checkout_url: checkout.hosted_checkout_url });
  } catch (e) {
    console.error('create checkout failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/checkout/webhook', async (req, res) => {
  res.status(200).end();
  try {
    const checkoutId = String(req.body.id || '');
    if (!checkoutId) return;
    const checkout = await sumupFetch('/v0.1/checkouts/' + encodeURIComponent(checkoutId));
    const basket = pendingCheckouts.get(checkout.checkout_reference);
    if (basket) {
      await finalizePurchase(checkout, basket);
      pendingCheckouts.delete(checkout.checkout_reference);
    }
  } catch (e) {
    console.error('checkout webhook failed:', e.message);
  }
});


app.get('/api/checkout/status', auth, async (req, res) => {
  try {
    const reference = String(req.query.ref || '').trim();
    if (!reference) return res.status(400).json({ error: 'ref required' });
    const [rows] = await pool.query(
      'SELECT status, license_keys FROM purchases WHERE checkout_reference=? AND userid=?',
      [reference, req.user.id]
    );
    if (rows.length && rows[0].status === 'PAID') {
      let keys = [];
      try { keys = JSON.parse(rows[0].license_keys || '[]'); } catch {}
      return res.json({ status: 'PAID', license_keys: keys });
    }
    let basket = pendingCheckouts.get(reference);
    let sumupCheckoutId = basket && basket.sumup_checkout_id
      ? basket.sumup_checkout_id
      : String(req.query.sumup_checkout_id || '').trim() || null;
    if (!sumupCheckoutId) return res.json({ status: 'PENDING' });
    let checkout = null;
    try {
      checkout = await sumupFetch('/v0.1/checkouts/' + encodeURIComponent(sumupCheckoutId));
    } catch {}
    if (checkout) {
      if (!basket) {
        const rawItems = [...new Set(String(req.query.items || '')
          .split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))];
        if (rawItems.length) {
          const [prods] = await pool.query('SELECT id, price FROM products WHERE id IN (?)', [rawItems]);
          const itemTotal = Math.round(rawItems.reduce((s, n) =>
            s + Number((prods.find((p) => p.id === n) || {}).price || 0), 0) * 100) / 100;
          const country = String(req.query.country || 'GB').trim().slice(0, 100);
          const tax = vatCalc(country, itemTotal);
          let discountCode = null;
          let discountPercent = 0;
          let discountAmount = 0;
          const dcInput = String(req.query.discount_code || '').trim();
          if (dcInput) {
            const r = await resolveDiscount(dcInput, req.user.id, tax.gross);
            if (r && !r.error) {
              discountCode = r.code;
              discountAmount = r.amount_off;
              discountPercent = r.type === 'percent' ? Number(r.value) || 0 : 0;
            }
          }
          basket = {
            userid: req.user.id,
            items_purchased: rawItems.join(','),
            amount: Math.max(0, Math.round((tax.gross - discountAmount) * 100) / 100),
            currency: 'GBP',
            country: country || null,
            vat_rate: tax.rate,
            vat_amount: tax.vat,
            discount_code: discountCode,
            discount_percent: discountPercent,
            discount_amount: discountAmount,
            digital_consent: 1,
            digital_consent_at: new Date(),
            digital_consent_ip: getClientIp(req),
            sumup_checkout_id: sumupCheckoutId,
          };
        }
      }
      if (basket) {
        await finalizePurchase(checkout, basket);
        pendingCheckouts.delete(reference);
      }
    }
    const [re] = await pool.query(
      'SELECT status, license_keys FROM purchases WHERE checkout_reference=? AND userid=?',
      [reference, req.user.id]
    );
    if (re.length && re[0].status === 'PAID') {
      let keys = [];
      try { keys = JSON.parse(re[0].license_keys || '[]'); } catch {}
      return res.json({ status: 'PAID', license_keys: keys });
    }
    res.json({ status: 'PENDING' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});






/* ---- user's invoices ---- */


app.get('/api/my-invoices', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, checkout_reference AS transactionid, items_purchased, items_price, amount, currency,
              created_at AS purchase_datetime
       FROM purchases WHERE userid=? AND status='PAID' ORDER BY created_at DESC`,
      [req.user.id]
    );
    const invoices = [];
    for (const p of rows) {
      let snapshot = null;
      try { snapshot = JSON.parse(p.items_price || 'null'); } catch { snapshot = null; }
      const items = [];
      let subtotal = 0;
      if (Array.isArray(snapshot) && snapshot.length) {
        for (const s of snapshot) {
          const pid = Number(s && s.product_id);
          if (!Number.isInteger(pid) || pid <= 0) continue;
          const price = Math.round((Number(s.price) || 0) * 100) / 100;
          const existing = items.find((it) => it.product_id === pid);
          if (existing) existing.qty += 1;
          else {
            items.push({ product_id: pid, name: String(s.name || 'Product'), slug: '', price, qty: 1 });
            subtotal = Math.round((subtotal + price) * 100) / 100;
          }
        }
      } else {
        const ids = String(p.items_purchased || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
        let byId = new Map();
        if (ids.length) {
          const [prods] = await pool.query('SELECT id, name, slug, price FROM products WHERE id IN (?)', [ids]);
          byId = new Map(prods.map((r) => [r.id, r]));
          for (const pid of ids) {
            const prod = byId.get(pid);
            if (!prod) continue;
            const existing = items.find((it) => it.product_id === pid);
            if (existing) existing.qty += 1;
            else items.push({ product_id: pid, name: prod.name, slug: prod.slug, price: Number(prod.price) || 0, qty: 1 });
          }
        }
        const itemsRaw = ids.map((pid) => byId.get(pid)).filter(Boolean);
        subtotal = Math.round(itemsRaw.reduce((sum, prod) => sum + (Number(prod.price) || 0), 0) * 100) / 100;
      }
      invoices.push({
        transactionid: p.transactionid,
        purchase_datetime: p.purchase_datetime,
        items,
        subtotal,
        discount: Math.round((subtotal - (Number(p.amount) || 0)) * 100) / 100,
        total: Number(p.amount) || 0,
        currency: p.currency || 'GBP',
      });
    }
    res.json({ invoices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


/* ---- user's purchases / downloads ---- */


app.get('/api/my-purchases', auth, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT items_purchased, created_at AS purchase_datetime FROM purchases WHERE userid=? AND status=? ORDER BY created_at DESC',
    [req.user.id, 'PAID']
  );
  const ids = [];
  const lastDate = {};
  for (const r of rows) {
    const date = new Date(r.purchase_datetime).getTime();
    for (const pid of String(r.items_purchased || '').split(',')) {
      const n = Number(pid.trim());
      if (!Number.isInteger(n) || n <= 0) continue;
      if (!ids.includes(n)) ids.push(n);
      const t = date || 0;
      if (lastDate[n] === undefined || t > lastDate[n]) lastDate[n] = t;
    }
  }
  if (!ids.length) return res.json([]);
  const [prods] = await pool.query(
    `SELECT id, name, slug, media_json, files_json, documentation_url
     FROM products WHERE id IN (?)`,
    [ids]
  );
  res.json(prods.map((r) => {
    let media = [];
    let files = [];
    try { media = JSON.parse(r.media_json || '[]'); } catch {}
    try { files = JSON.parse(r.files_json || '[]'); } catch {}
    const first = media.find((m) => m && m.type === 'image') || media[0];
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      image_url: first ? first.path : null,
      files: Array.isArray(files) ? files.filter((f) => f && f.path) : [],
      documentation_url: r.documentation_url || null,
      purchased_at: lastDate[r.id] ? new Date(lastDate[r.id]).toISOString() : null,
    };
  }));
});


/* ---- user's licenses ---- */

const ROBLOX_NAME_CACHE = new Map(); // gameId -> { name, ts }
const ROBLOX_CACHE_TTL = 30 * 60 * 1000;

function httpsGetJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'KGMCloud/1.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('roblox http ' + res.statusCode));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('roblox timeout')));
    req.on('error', reject);
  });
}

async function resolveRobloxGameNames(gameIds) {
  const uniq = [...new Set(gameIds.filter((g) => Number.isInteger(g) && g > 0))];
  if (!uniq.length) return {};
  const now = Date.now();
  const names = {};
  const uncached = [];
  for (const id of uniq) {
    const hit = ROBLOX_NAME_CACHE.get(id);
    if (hit && now - hit.ts < ROBLOX_CACHE_TTL) names[id] = hit.name;
    else uncached.push(id);
  }
  if (uncached.length) {
    try {
      const u = await httpsGetJson(`https://games.roblox.com/v1/games?universeIds=${uncached.join(',')}`);
      for (const item of (u.data || [])) {
        if (item && item.id != null && item.name) {
          names[Number(item.id)] = item.name;
          ROBLOX_NAME_CACHE.set(Number(item.id), { name: item.name, ts: now });
        }
      }
      try {
        const p = await httpsGetJson(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${uncached.join(',')}`);
        for (const item of (Array.isArray(p) ? p : [])) {
          if (item && item.placeId != null && item.name) {
            names[Number(item.placeId)] = item.name;
            ROBLOX_NAME_CACHE.set(Number(item.placeId), { name: item.name, ts: now });
          }
        }
      } catch { /* optional fallback ignored */ }
    } catch { /* names stay unresolved */ }
  }
  return names;
}


app.get('/api/licenses', auth, async (req, res) => {
  const [rows] = await pool.query('SELECT id, license_key, product_id, status, max_games, created_at, expires_at FROM licenses WHERE user_id=?', [req.user.id]);
  const byId = new Map();
  const pids = [...new Set(rows.map((l) => l.product_id))];
  if (pids.length) {
    const [prods] = await pool.query('SELECT id, name, slug, media_json FROM products WHERE id IN (?)', [pids]);
    for (const p of prods) {
      let media = [];
      try { media = JSON.parse(p.media_json || '[]'); } catch { /* ignore */ }
      const first = media.find((m) => m && m.type === 'image') || media[0];
      byId.set(p.id, { product_name: p.name, product_slug: p.slug, product_image_url: first ? first.path : null });
    }
  }
  const out = [];
  const allGameIds = [];
  for (const l of rows) {
    const [g] = await pool.query('SELECT game_id, added_at FROM license_games WHERE license_id=?', [l.id]);
    for (const r of g) allGameIds.push(Number(r.game_id));
    out.push({ ...l, games: g.map((r) => ({ game_id: Number(r.game_id), added_at: r.added_at })), ...(byId.get(l.product_id) || {}) });
  }
  const gameNames = await resolveRobloxGameNames(allGameIds);
  for (const lic of out) {
    for (const gm of lic.games) {
      if (gameNames[gm.game_id]) gm.name = gameNames[gm.game_id];
    }
  }
  res.json({ licenses: out });
});


app.post('/api/license/game', auth, async (req, res) => {
  const { license_key, game_id } = req.body;
  const gid = Number(game_id);
  if (!license_key) return res.status(400).json({ error: 'license_key required' });
  if (!Number.isInteger(gid) || gid <= 0) return res.status(400).json({ error: 'valid game_id required' });
  const [rows] = await pool.query('SELECT * FROM licenses WHERE license_key=?', [license_key]);
  if (!rows.length) return res.status(404).json({ error: 'License key not found' });
  if (rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Not your license' });
  const lic = rows[0];
  if (lic.status !== 'active') return res.status(400).json({ error: 'License not active' });
  const [linked] = await pool.query('SELECT game_id FROM license_games WHERE license_id=?', [lic.id]);
  const gameIds = linked.map((r) => Number(r.game_id));
  if (gameIds.includes(gid)) return res.json({ ok: true, games_used: gameIds.length, max_games: lic.max_games });
  if (gameIds.length >= lic.max_games) return res.status(400).json({ error: 'Max games reached', games_used: gameIds.length, max_games: lic.max_games });
  await pool.query('INSERT INTO license_games (license_id, game_id) VALUES (?,?)', [lic.id, gid]);
  res.json({ ok: true, games_used: gameIds.length + 1, max_games: lic.max_games });
});




app.delete('/api/license/game', auth, async (req, res) => {
  const { license_key, game_id } = req.body;
  const gid = Number(game_id);
  if (!license_key) return res.status(400).json({ error: 'license_key required' });
  if (!Number.isInteger(gid) || gid <= 0) return res.status(400).json({ error: 'valid game_id required' });
  const [rows] = await pool.query('SELECT * FROM licenses WHERE license_key=?', [license_key]);
  if (!rows.length) return res.status(404).json({ error: 'License key not found' });
  if (rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Not your license' });
  const lic = rows[0];
  await pool.query('DELETE FROM license_games WHERE license_id=? AND game_id=?', [lic.id, gid]);
  const [linked] = await pool.query('SELECT game_id FROM license_games WHERE license_id=?', [lic.id]);
  res.json({ ok: true, games_used: linked.length, max_games: lic.max_games });
});


/* ---- license validation (game servers) ---- */


app.post('/api/license/validate', async (req, res) => {
  const { license_key } = req.body;
  const game_id = Number(req.body.game_id);
  if (!license_key) return res.status(400).json({ valid: false, reason: 'no_license_key' });
  if (!Number.isInteger(game_id) || game_id <= 0) return res.status(400).json({ valid: false, reason: 'no_game_id' });
  const [ls] = await pool.query('SELECT * FROM licenses WHERE license_key=?', [license_key]);
  if (!ls.length) return res.json({ valid: false, reason: 'license_not_found' });
  const lic = ls[0];
  if (lic.status !== 'active') return res.json({ valid: false, reason: 'license_not_active' });
  if (lic.expires_at && new Date(lic.expires_at) < new Date()) return res.json({ valid: false, reason: 'license_expired' });
  const [linked] = await pool.query('SELECT game_id FROM license_games WHERE license_id=?', [lic.id]);
  if (!linked.map((r) => Number(r.game_id)).includes(game_id))
    return res.json({ valid: false, reason: 'game_not_linked', games_used: linked.length, max_games: lic.max_games });
  res.json({ valid: true, games_used: linked.length, max_games: lic.max_games });
});


/* ---- staff: categories ---- */


app.get('/api/staff/categories', auth, staff, perm(26), async (_req, res) => {
  const [rows] = await pool.query('SELECT * FROM categories ORDER BY name ASC');
  res.json(rows);
});


app.post('/api/staff/categories', auth, staff, perm(27), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const slug = slugify(name);
  try {
    const [result] = await pool.query('INSERT INTO categories (name, slug) VALUES (?,?)', [name, slug]);
    res.json({ ok: true, id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Category already exists' });
    throw e;
  }
});


app.put('/api/staff/categories/:id', auth, staff, perm(28), async (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const slug = slugify(name);
  try {
    await pool.query('UPDATE categories SET name=?, slug=? WHERE id=?', [name, slug, id]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Category already exists' });
    throw e;
  }
});


app.delete('/api/staff/categories/:id', auth, staff, perm(28), async (req, res) => {
  const id = Number(req.params.id);
  await pool.query('UPDATE products SET category_id=NULL WHERE category_id=?', [id]);
  await pool.query('DELETE FROM categories WHERE id=?', [id]);
  res.json({ ok: true });
});








/* ---- staff: upload ---- */


app.post('/api/staff/upload', auth, staff, express.raw({ type: '*/*', limit: '300mb' }), async (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const kind = String(req.query.kind || 'files').trim();
  const original = String(req.query.filename || 'upload').trim() || 'upload';
  if (!['media', 'files', 'docs'].includes(kind)) {
    return res.status(400).json({ error: 'kind must be media, files or docs' });
  }
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'Empty upload' });
  }
  const blocked = /\.(html?|svg|php|sh|exe|msi|bat|cmd|js|mjs|py|rb|pl|cgi|asp|jsp)$/i;
  if (blocked.test(original)) {
    return res.status(400).json({ error: 'File type not allowed' });
  }
  const base = path.basename(original).replace(/[^a-zA-Z0-9._\-\s]/g, '_');
  const name = `${Date.now().toString(36)}-${base}`;
  const dir = path.join(__dirname, 'uploads', 'products', kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), req.body);
  res.json({ url: `/media/products/${kind}/${name}`, name: original, size: req.body.length });
});


/* ---- customer upload ---- */

function writeUpload(kind, original, buf) {
  const fs = require('fs');
  const path = require('path');
  const safeKind = ['media', 'files', 'docs'].includes(kind) ? kind : 'files';
  const base = path.basename(original || 'upload').replace(/[^a-zA-Z0-9._\-\s]/g, '_');
  const name = `${Date.now().toString(36)}-${base}`;
  const dir = path.join(__dirname, 'uploads', 'products', safeKind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buf);
  return { url: `/media/products/${safeKind}/${name}`, name: original || 'upload', size: buf.length };
}

app.post('/api/upload', auth, express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const kind = String(req.query.kind || 'files').trim();
  const original = String(req.query.filename || 'upload').trim() || 'upload';
  if (!['media', 'files', 'docs'].includes(kind)) {
    return res.status(400).json({ error: 'kind must be media, files or docs' });
  }
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'Empty upload' });
  }
  const blocked = /\.(html?|svg|php|sh|exe|msi|bat|cmd|js|mjs|py|rb|pl|cgi|asp|jsp)$/i;
  if (blocked.test(original)) {
    return res.status(400).json({ error: 'File type not allowed' });
  }
  res.json(writeUpload(kind, original, req.body));
});


/* ---- documentation ---- */

const DOCS_FS = require('fs');
const DOCS_PATH = require('path');
const DOCS_ROOT = DOCS_PATH.join(__dirname, 'docs');

function docSlugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseDocSections(md) {
  const lines = String(md || '').split(/\r?\n/);
  const sections = [];
  const seen = {};
  let title = '';
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.*)$/.exec(line);
    if (!m) continue;
    const level = m[1].length;
    const text = (m[2] || '').trim().replace(/\*\*/g, '').replace(/`/g, '');
    if (level === 1) {
      if (!title) title = text;
      continue;
    }
    let slug = docSlugify(text);
    seen[slug] = (seen[slug] || 0) + 1;
    if (seen[slug] > 1) slug = `${slug}-${seen[slug] - 1}`;
    sections.push({ level, title: text, slug });
  }
  return { title: title || '', sections };
}

function collectDocs(dir, prefix) {
  const out = [];
  if (!DOCS_FS.existsSync(dir)) return out;
  for (const entry of DOCS_FS.readdirSync(dir, { withFileTypes: true })) {
    const full = DOCS_PATH.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectDocs(full, prefix ? `${prefix}/${entry.name}` : entry.name));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const md = DOCS_FS.readFileSync(full, 'utf8');
      const { title, sections } = parseDocSections(md);
      const base = entry.name.replace(/\.md$/i, '');
      const parts = prefix ? prefix.split('/') : [];
      const top = parts[0] || null;
      const addon = top != null && parts.length > 1;
      const catSlug = docSlugify(top || base);
      const fileSlug = docSlugify(base);
      const slug = top ? (catSlug === fileSlug ? catSlug : `${catSlug}-${fileSlug}`) : fileSlug;
      out.push({
        slug,
        title: title || base,
        category: top || base,
        addon,
        sections,
        file: prefix ? `${prefix}/${entry.name}` : entry.name,
      });
    }
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

function docsIndex() {
  const all = collectDocs(DOCS_ROOT);
  const catMap = {};
  for (const d of all) {
    (catMap[d.category] = catMap[d.category] || []).push(d);
  }
  const categories = Object.keys(catMap)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      docs: catMap[name].sort((a, b) =>
        a.addon === b.addon ? a.slug.localeCompare(b.slug) : a.addon ? 1 : -1
      ),
    }));
  return { categories, docs: all };
}

app.get('/api/docs', (_req, res) => {
  try {
    res.json(docsIndex());
  } catch (e) {
    res.status(500).json({ error: 'Could not read documentation' });
  }
});

app.get('/api/docs/:slug', (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    const docs = collectDocs(DOCS_ROOT);
    const doc = docs.find((d) => d.slug === slug);
    if (!doc) return res.status(404).json({ error: 'Documentation not found' });
    const md = DOCS_FS.readFileSync(DOCS_PATH.join(DOCS_ROOT, doc.file), 'utf8');
    res.json({ slug: doc.slug, title: doc.title, category: doc.category, markdown: md });
  } catch (e) {
    res.status(500).json({ error: 'Could not read documentation' });
  }
});


/* ---- staff: products ---- */


app.get('/api/staff/products', auth, staff, perm(29), async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id ORDER BY p.pinned DESC, p.id ASC`
  );
  let viewsMap = new Map();
  try {
    const [vc] = await pool.query(`SELECT ref, views FROM view_counts WHERE ref LIKE 'product:%'`);
    viewsMap = new Map(vc.map((r) => [r.ref, Number(r.views || 0)]));
  } catch (err) { /* view_counts table may not exist yet */ }
  res.json(rows.map((r) => ({ ...r, views: viewsMap.get('product:' + r.id) || 0 })));
});


app.post('/api/staff/products', auth, staff, perm(30), async (req, res) => {
  const { name, category_id, short_description, description, price, on_sale, discount_percent,
          sale_price, disclaimer, requires_license, documentation_url, productdemo_url, media, features, files, pinned, active,
          max_games_per_license } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const slug = await uniqueSlug(pool, name, null);
  const [result] = await pool.query(
    `INSERT INTO products (name, slug, category_id, short_description, description, price, on_sale,
      discount_percent, sale_price, disclaimer, requires_license, documentation_url, productdemo_url, media_json,
      features_json, files_json, pinned, active, max_games_per_license) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [name, slug, category_id || null, short_description || null, description || null, price || 0,
      on_sale ? 1 : 0, discount_percent || null, sale_price || null, disclaimer !== false ? 1 : 0,
      requires_license ? 1 : 0, documentation_url || null, productdemo_url || null,
      media ? JSON.stringify(media) : null,
      features ? JSON.stringify(features) : null,
      files ? JSON.stringify(files) : null,
      pinned ? 1 : 0, active !== false ? 1 : 0,
      Number(max_games_per_license) >= 1 ? Number(max_games_per_license) : 3]
  );
  res.json({ ok: true, id: result.insertId, slug });
});


app.put('/api/staff/products/:id', auth, staff, perm(31), async (req, res) => {
  const id = Number(req.params.id);
  const { name, category_id, short_description, description, price, on_sale, discount_percent,
          sale_price, disclaimer, requires_license, documentation_url, productdemo_url, media, features, files, pinned, active, slug,
          max_games_per_license } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const finalSlug = slug && slug !== '' ? slug : await uniqueSlug(pool, name, id);
  await pool.query(
    `UPDATE products SET name=?, slug=?, category_id=?, short_description=?, description=?, price=?,
      on_sale=?, discount_percent=?, sale_price=?, disclaimer=?, requires_license=?, documentation_url=?,
      productdemo_url=?, media_json=?, features_json=?, files_json=?, pinned=?, active=?, max_games_per_license=? WHERE id=?`,
    [name, finalSlug, category_id || null, short_description || null, description || null, price || 0,
      on_sale ? 1 : 0, discount_percent || null, sale_price || null, disclaimer !== false ? 1 : 0,
      requires_license ? 1 : 0, documentation_url || null, productdemo_url || null,
      media ? JSON.stringify(media) : null,
      features ? JSON.stringify(features) : null,
      files ? JSON.stringify(files) : null,
      pinned ? 1 : 0, active !== false ? 1 : 0,
      Number(max_games_per_license) >= 1 ? Number(max_games_per_license) : 3, id]
  );
  res.json({ ok: true, slug: finalSlug });
});


app.delete('/api/staff/products/:id', auth, staff, perm(31), async (req, res) => {
  await pool.query('DELETE FROM products WHERE id=?', [Number(req.params.id)]);
  res.json({ ok: true });
});


/* ---- staff: sales stats ---- */


app.get('/api/staff/stats', auth, staff, perm('view.companydashboard'), async (_req, res) => {
  const [[{ sales_cur }]] = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS sales_cur FROM purchases
     WHERE status='PAID' AND created_at >= NOW() - INTERVAL 7 DAY`);
  const [[{ sales_prev }]] = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS sales_prev FROM purchases
     WHERE status='PAID' AND created_at BETWEEN NOW() - INTERVAL 14 DAY AND NOW() - INTERVAL 7 DAY`);
  const [[{ customers_cur }]] = await pool.query(
    `SELECT COUNT(*) AS customers_cur FROM users
     WHERE created_at >= NOW() - INTERVAL 7 DAY`);
  const [[{ customers_prev }]] = await pool.query(
    `SELECT COUNT(*) AS customers_prev FROM users
     WHERE created_at BETWEEN NOW() - INTERVAL 14 DAY AND NOW() - INTERVAL 7 DAY`);
  const [[{ resolved_cur }]] = await pool.query(
    `SELECT COUNT(*) AS resolved_cur FROM tickets
     WHERE resolved_at IS NOT NULL AND resolved_at >= NOW() - INTERVAL 7 DAY`);
  const [[{ resolved_prev }]] = await pool.query(
    `SELECT COUNT(*) AS resolved_prev FROM tickets
     WHERE resolved_at IS NOT NULL AND resolved_at >= NOW() - INTERVAL 14 DAY AND resolved_at < NOW() - INTERVAL 7 DAY`);
  res.json({
    sales: { current: Number(sales_cur || 0), previous: Number(sales_prev || 0) },
    new_customers: { current: Number(customers_cur || 0), previous: Number(customers_prev || 0) },
    resolved_tickets: { current: Number(resolved_cur || 0), previous: Number(resolved_prev || 0) },
  });
});


/* ---- site & product page views ---- */


app.post('/api/views', async (req, res) => {
  const ref = String((req.body && req.body.ref) || '').trim().slice(0, 128);
  if (!ref) return res.status(400).json({ error: 'ref required' });
  try {
    await pool.query(
      `INSERT INTO view_counts (ref, views) VALUES (?, 1)
       ON DUPLICATE KEY UPDATE views = views + 1`,
      [ref]
    );
  } catch (err) {
    console.error('view_count failed:', err.message);
  }
  res.json({ ok: true });
});


app.get('/api/staff/views', auth, staff, perm('view.companydashboard'), async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT v.ref, v.views, p.name AS product_name
       FROM view_counts v
       LEFT JOIN products p ON v.ref = CONCAT('product:', p.id)
       ORDER BY v.views DESC
       LIMIT 200`
    );
    res.json(rows.map((r) => ({ ref: r.ref, views: Number(r.views || 0), product_name: r.product_name })));
  } catch (err) {
    console.error('staff/views failed:', err.message);
    res.json([]);
  }
});


/* ---- staff: company-wide announcements ---- */


function sanitizeHtml(input) {
  if (typeof input !== 'string') return '';
  let html = String(input);
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  const blockedTags = ['script', 'style', 'iframe', 'object', 'embed', 'applet', 'meta', 'link', 'base',
    'form', 'input', 'button', 'textarea', 'select', 'option', 'svg', 'math', 'html', 'body', 'head',
    'title', 'video', 'audio', 'source', 'track', 'canvas', 'template', 'noscript', 'frame', 'frameset', 'xml'];
  for (const tag of blockedTags) {
    html = html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    html = html.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '');
  }
  html = html.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/\s+(src|href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m, attr, val) => {
    const v = val.replace(/^["']|["']$/g, '').trim().replace(/[\x00-\x20]+/g, '').toLowerCase();
    if (/^(javascript|vbscript|data):/.test(v) && !/^data:image\//.test(v)) return '';
    return m;
  });
  html = html.replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  return html.slice(0, 25000);
}


app.get('/api/staff/announcements', auth, staff, perm('view.companyannouncements'), async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT a.id, a.author_id, u.firstname, u.role, a.title, a.body, a.created_at
     FROM company_announcements a JOIN users u ON u.id=a.author_id
     WHERE a.team_id = 0
     ORDER BY a.created_at DESC LIMIT 50`);
  res.json(rows);
});


app.post('/api/staff/announcements', auth, staff, perm('create.companyannouncements'), async (req, res) => {
  const title = String(req.body.title || '').trim();
  const body = sanitizeHtml(String(req.body.body || '').trim());
  if (!title || !body) return res.status(400).json({ error: 'title and body required' });
  await pool.query('INSERT INTO company_announcements (author_id, title, body, team_id) VALUES (?,?,?,0)',
    [req.user.id, title.slice(0, 200), body.slice(0, 4000)]);
  res.json({ ok: true });
});


app.delete('/api/staff/announcements/:id', auth, staff, perm('manage.companyannouncements'), async (req, res) => {
  await pool.query('DELETE FROM company_announcements WHERE id=? AND team_id = 0', [Number(req.params.id)]);
  res.json({ ok: true });
});


/* ---- staff: company-wide instant chat ---- */


app.get('/api/staff/chat', auth, staff, perm('view.companychat'), async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT m.id, m.user_id, u.firstname, u.role, m.body, m.created_at
     FROM company_chat_messages m JOIN users u ON u.id=m.user_id
     WHERE m.team_id = 0
     ORDER BY m.created_at ASC LIMIT 200`);
  res.json(rows);
});


app.post('/api/staff/chat', auth, staff, perm('send.companychat'), async (req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message required' });
  await pool.query('INSERT INTO company_chat_messages (user_id, body, team_id) VALUES (?,?,0)', [req.user.id, body.slice(0, 1000)]);
  res.json({ ok: true });
});


/* ---- staff: Customer Experience dashboard (permissions to be re-added later) ---- */

function formatDuration(totalMinutes) {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return '—';
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

app.get('/api/staff/cx-dashboard', auth, staff, perm('view.cxdashboard'), async (_req, res) => {
  const [[stats]] = await pool.query(`
    SELECT
      SUM(status='open') AS open,
      SUM(status='awaiting_cx') AS awaiting_cx,
      SUM(status='awaiting_customer') AS awaiting_customer,
      SUM(status='resolved') AS resolved,
      SUM(status='closed') AS closed
    FROM tickets`);
  const [[avg]] = await pool.query(`
    SELECT AVG(c.avg_minutes) AS avg_minutes FROM (
      SELECT t.id,
        TIMESTAMPDIFF(MINUTE, t.created_at,
          (SELECT MIN(tm.created_at) FROM ticket_messages tm
            JOIN users u ON u.id = tm.user_id
            WHERE tm.ticket_id = t.id AND tm.is_note = 0 AND u.role IS NOT NULL
              AND tm.created_at > t.created_at
          )) AS avg_minutes
      FROM tickets t
      HAVING avg_minutes IS NOT NULL
    ) c`);
  const [members] = await pool.query(
    `SELECT u.id, u.firstname, u.email, u.role, u.created_at
     FROM users u WHERE u.role IS NOT NULL ORDER BY u.firstname ASC`);

  res.json({
    cx_stats: {
      open: Number(stats?.open || 0),
      awaiting_cx: Number(stats?.awaiting_cx || 0),
      awaiting_customer: Number(stats?.awaiting_customer || 0),
      avg_response: formatDuration(Number(avg?.avg_minutes || 0)),
      resolved: Number(stats?.resolved || 0),
      closed: Number(stats?.closed || 0),
    },
    members,
  });
});

app.get('/api/staff/cx-dashboard/announcements', auth, staff, perm('view.cxannouncements'), async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT a.id, a.author_id, u.firstname, u.role, a.title, a.body, a.created_at
     FROM company_announcements a JOIN users u ON u.id=a.author_id
     WHERE a.team_id = 1
     ORDER BY a.created_at DESC LIMIT 50`);
  res.json(rows);
});

app.get('/api/staff/cx-dashboard/chat', auth, staff, perm('view.cxchat'), async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT m.id, m.user_id, u.firstname, u.role, m.body, m.created_at
     FROM company_chat_messages m JOIN users u ON u.id=m.user_id
     WHERE m.team_id = 1
     ORDER BY m.created_at ASC LIMIT 200`);
  res.json(rows);
});

app.post('/api/staff/cx-dashboard/chat', auth, staff, perm('send.cxchat'), async (req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message required' });
  await pool.query('INSERT INTO company_chat_messages (user_id, body, team_id) VALUES (?,?,1)', [req.user.id, body.slice(0, 1000)]);
  res.json({ ok: true });
});

app.post('/api/staff/cx-dashboard/announcements', auth, staff, perm('create.cxannouncements'), async (req, res) => {
  const title = String(req.body.title || '').trim();
  const body = sanitizeHtml(String(req.body.body || '').trim());
  if (!title || !body) return res.status(400).json({ error: 'title and body required' });
  await pool.query('INSERT INTO company_announcements (author_id, title, body, team_id) VALUES (?,?,?,1)',
    [req.user.id, title.slice(0, 200), body.slice(0, 4000)]);
  res.json({ ok: true });
});

app.delete('/api/staff/cx-dashboard/announcements/:id', auth, staff, perm('manage.cxannouncements'), async (req, res) => {
  await pool.query('DELETE FROM company_announcements WHERE id=? AND team_id = 1', [Number(req.params.id)]);
  res.json({ ok: true });
});


/* ---- staff: dashboards I can post updates to ---- */


app.get('/api/staff/my-dashboards', auth, staff, async (_req, res) => {
  res.json({ general: true, teams: [] });
});


/* ---- staff: accounts & users ---- */


app.get('/api/staff/accounts/:id', auth, staff, perm('view.customer'), async (req, res) => {
  const id = Number(req.params.id);
  const [rows] = await pool.query('SELECT id, firstname, surname, email, role FROM users WHERE id=?', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Account not found' });
  res.json({
    user: rows[0],
  });
});


app.get('/api/staff/users', auth, staff, perm(33), async (req, res) => {
  const search = (req.query.search || '').toString().trim();
  const like = `%${search}%`;
  const cols = `u.id, u.firstname, u.email, u.role, u.team, u.permissions AS direct_permissions, u.created_at, r.title AS role_title, t.team_name AS team_name`;
  const [rows] = search
    ? await pool.query(`SELECT ${cols} FROM users u LEFT JOIN roles r ON r.id = u.role LEFT JOIN teams t ON t.id = u.team WHERE (u.firstname LIKE ? OR u.email LIKE ?) ORDER BY u.firstname ASC LIMIT 200`, [like, like])
    : await pool.query(`SELECT ${cols} FROM users u LEFT JOIN roles r ON r.id = u.role LEFT JOIN teams t ON t.id = u.team ORDER BY u.firstname ASC LIMIT 2000`);
  res.json(rows);
});


/* ---- role titles ---- */

app.get('/api/staff/role-titles', auth, staff, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, title FROM roles ORDER BY id');
    return res.json(rows);
  } catch {
    return res.json([]);
  }
});

app.get('/api/staff/teams', auth, staff, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, team_name FROM teams ORDER BY id');
    return res.json(rows);
  } catch {
    return res.json([]);
  }
});


/* ---- teams & permissions management ---- */

app.get('/api/staff/teams/admin', auth, staff, perm(33), async (_req, res) => {
  try {
    const [teams] = await pool.query('SELECT id, team_name, permissions FROM teams ORDER BY id');
    const [allPerms] = await pool.query('SELECT id, permission_name FROM permissions');
    const [counts] = await pool.query('SELECT team, COUNT(*) AS n FROM users WHERE team IS NOT NULL AND team <> 0 GROUP BY team');
    const nameById = new Map(allPerms.map((p) => [p.id, p.permission_name]));
    const countByTeam = new Map(counts.map((c) => [c.team, c.n]));
    const result = teams.map((t) => {
      const ids = String(t.permissions || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
      return {
        id: t.id,
        team_name: t.team_name,
        user_count: countByTeam.get(t.id) || 0,
        permission_ids: ids,
        permissions: ids.map((id) => ({ id, name: nameById.get(id) || '' })),
      };
    });
    return res.json(result);
  } catch (e) {
    console.error('teams list failed:', e.message);
    return res.status(500).json({ error: 'Could not load teams' });
  }
});

app.post('/api/staff/teams', auth, staff, perm(33), async (req, res) => {
  const team_name = String(req.body.team_name || '').trim();
  const perms = Array.isArray(req.body.permissions)
    ? req.body.permissions.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  if (!team_name) return res.status(400).json({ error: 'Team name is required' });
  const csv = [...new Set(perms)].join(',');
  try {
    const [result] = await pool.query('INSERT INTO teams (team_name, permissions) VALUES (?,?)', [team_name.slice(0, 100), csv]);
    return res.json({ ok: true, id: result.insertId });
  } catch (e) {
    console.error('team create failed:', e.message);
    return res.status(500).json({ error: 'Could not create team' });
  }
});

app.put('/api/staff/teams/:id', auth, staff, perm(33), async (req, res) => {
  const id = Number(req.params.id);
  const team_name = String(req.body.team_name || '').trim();
  const perms = Array.isArray(req.body.permissions)
    ? req.body.permissions.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  if (!team_name) return res.status(400).json({ error: 'Team name is required' });
  const [existing] = await pool.query('SELECT id FROM teams WHERE id=?', [id]);
  if (!existing.length) return res.status(404).json({ error: 'Team not found' });
  const csv = [...new Set(perms)].join(',');
  try {
    await pool.query('UPDATE teams SET team_name=?, permissions=? WHERE id=?', [team_name.slice(0, 100), csv, id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error('team update failed:', e.message);
    return res.status(500).json({ error: 'Could not update team' });
  }
});

app.delete('/api/staff/teams/:id', auth, staff, perm(33), async (req, res) => {
  const id = Number(req.params.id);
  const [counts] = await pool.query('SELECT COUNT(*) AS n FROM users WHERE team=?', [id]);
  if (counts[0].n > 0) return res.status(409).json({ error: `Cannot delete team — it is assigned to ${counts[0].n} user(s)` });
  try {
    await pool.query('DELETE FROM teams WHERE id=?', [id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error('team delete failed:', e.message);
    return res.status(500).json({ error: 'Could not delete team' });
  }
});

app.put('/api/staff/role-titles/:id', auth, staff, perm(33), async (req, res) => {
  const id = Number(req.params.id);
  const title = String(req.body.title || '').trim();
  if (!id || !title) return res.status(400).json({ error: 'id and title required' });
  try {
    await pool.query('UPDATE roles SET title=? WHERE id=?', [title.slice(0, 100), id]);
  } catch {
    return res.status(500).json({ error: 'Could not update role title' });
  }
  res.json({ ok: true });
});


/* ---- roles & permissions management ---- */

app.get('/api/staff/permissions', auth, staff, perm(33), async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, permission_name FROM permissions ORDER BY id');
    return res.json(rows);
  } catch {
    return res.json([]);
  }
});

app.get('/api/staff/roles', auth, staff, perm(33), async (_req, res) => {
  try {
    const [roles] = await pool.query('SELECT id, title, permissions FROM roles ORDER BY id');
    const [allPerms] = await pool.query('SELECT id, permission_name FROM permissions');
    const [counts] = await pool.query('SELECT role, COUNT(*) AS n FROM users WHERE role IS NOT NULL GROUP BY role');
    const nameById = new Map(allPerms.map((p) => [p.id, p.permission_name]));
    const countByRole = new Map(counts.map((c) => [c.role, c.n]));
    const result = roles.map((r) => {
      const ids = String(r.permissions || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
      return {
        id: r.id,
        title: r.title,
        user_count: countByRole.get(r.id) || 0,
        permission_ids: ids,
        permissions: ids.map((id) => ({ id, name: nameById.get(id) || '' })),
      };
    });
    return res.json(result);
  } catch (e) {
    console.error('roles list failed:', e.message);
    return res.status(500).json({ error: 'Could not load roles' });
  }
});

app.post('/api/staff/roles', auth, staff, perm(33), async (req, res) => {
  const title = String(req.body.title || '').trim();
  const perms = Array.isArray(req.body.permissions)
    ? req.body.permissions.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const csv = [...new Set(perms)].join(',');
  try {
    const [result] = await pool.query('INSERT INTO roles (title, permissions) VALUES (?,?)', [title.slice(0, 100), csv]);
    return res.json({ ok: true, id: result.insertId });
  } catch (e) {
    console.error('role create failed:', e.message);
    return res.status(500).json({ error: 'Could not create role' });
  }
});

app.put('/api/staff/roles/:id', auth, staff, perm(33), async (req, res) => {
  const id = Number(req.params.id);
  const title = String(req.body.title || '').trim();
  const perms = Array.isArray(req.body.permissions)
    ? req.body.permissions.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const [existing] = await pool.query('SELECT id FROM roles WHERE id=?', [id]);
  if (!existing.length) return res.status(404).json({ error: 'Role not found' });
  const csv = [...new Set(perms)].join(',');
  try {
    await pool.query('UPDATE roles SET title=?, permissions=? WHERE id=?', [title.slice(0, 100), csv, id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error('role update failed:', e.message);
    return res.status(500).json({ error: 'Could not update role' });
  }
});

app.delete('/api/staff/roles/:id', auth, staff, perm(33), async (req, res) => {
  const id = Number(req.params.id);
  const [counts] = await pool.query('SELECT COUNT(*) AS n FROM users WHERE role=?', [id]);
  if (counts[0].n > 0) return res.status(409).json({ error: `Cannot delete role — it is assigned to ${counts[0].n} user(s)` });
  try {
    await pool.query('DELETE FROM roles WHERE id=?', [id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error('role delete failed:', e.message);
    return res.status(500).json({ error: 'Could not delete role' });
  }
});

/* ---- tickets ---- */

app.get('/api/staff/tickets', auth, staff, perm('view.tickets'), async (req, res) => {
  const team = Number(req.query.team) || 1;
  const [rows] = await pool.query(
    `SELECT t.id, t.title, t.status, t.transaction_id, t.team_id, t.created_at, t.updated_at,
       u.firstname AS customer_firstname, u.email AS customer_email,
       (SELECT tm2.user_id FROM ticket_messages tm2
          WHERE tm2.ticket_id = t.id AND tm2.is_note = 0
            AND (SELECT u2.role FROM users u2 WHERE u2.id = tm2.user_id) > 0
          ORDER BY tm2.created_at DESC LIMIT 1) AS last_staff_user_id,
       (SELECT tm2.created_at FROM ticket_messages tm2
          WHERE tm2.ticket_id = t.id AND tm2.is_note = 0
            AND (SELECT u2.role FROM users u2 WHERE u2.id = tm2.user_id) > 0
          ORDER BY tm2.created_at DESC LIMIT 1) AS last_staff_reply_at
     FROM tickets t JOIN users u ON u.id = t.customer_id
     WHERE t.team_id = ?
     ORDER BY FIELD(t.status, 'awaiting_cx', 'open', 'awaiting_customer', 'resolved', 'closed'), t.updated_at ASC LIMIT 200`,
    [team]
  );
  const ids = [...new Set(rows.filter((r) => r.last_staff_user_id).map((r) => r.last_staff_user_id))];
  const out = rows.map((r) => ({
    ...r,
    last_staff_user_id: r.last_staff_user_id || null,
    last_staff_reply_at: r.last_staff_reply_at || null,
  }));
  const namesMap = {};
  if (ids.length) {
    const [names] = await pool.query('SELECT id, firstname FROM users WHERE id IN (?)', [ids]);
    for (const n of names) namesMap[n.id] = n.firstname;
  }
  for (const r of out) r.last_staff_firstname = r.last_staff_user_id ? (namesMap[r.last_staff_user_id] || null) : null;
  res.json({ tickets: out });
});

app.get('/api/staff/tickets/:id', auth, staff, perm('view.tickets'), async (req, res) => {
  const id = Number(req.params.id);
  const [tickets] = await pool.query(
    `SELECT t.id, t.title, t.status, t.transaction_id, t.team_id, t.created_at, t.updated_at,
       u.id AS customer_id, u.firstname AS customer_firstname, u.email AS customer_email
     FROM tickets t
     JOIN users u ON u.id = t.customer_id
     WHERE t.id = ?`, [id]);
  if (!tickets.length) return res.status(404).json({ error: 'Ticket not found' });
  const [messages] = await pool.query(
    `SELECT tm.id, tm.ticket_id, tm.user_id, tm.sender_type, u.firstname, u.role, tm.body, tm.is_note, tm.attachments, tm.created_at
     FROM ticket_messages tm JOIN users u ON u.id = tm.user_id
     WHERE tm.ticket_id = ? ORDER BY tm.created_at ASC`, [id]);
  for (const m of messages) m.attachments = parseAttachments(m.attachments);
  res.json({ ticket: tickets[0], messages });
});

app.post('/api/staff/tickets/:id/status', auth, staff, ticketExists, async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || '');
  const allowed = ['open', 'awaiting_cx', 'awaiting_customer', 'resolved', 'closed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const requiredPerm = status === 'resolved' ? 21 : status === 'closed' ? 22 : status === 'open' ? 23 : null;
  if (requiredPerm && !req.user.permission_ids.includes(requiredPerm)) {
    return res.status(403).json({ error: 'You do not have permission to do that' });
  }
  if (status === 'resolved') {
    await pool.query("UPDATE tickets SET status=?, resolved_at = COALESCE(resolved_at, NOW()) WHERE id=?", [status, id]);
  } else if (status === 'closed') {
    await pool.query('UPDATE tickets SET status=? WHERE id=?', [status, id]);
  } else {
    await pool.query('UPDATE tickets SET status=?, resolved_at=NULL WHERE id=?', [status, id]);
  }
  res.json({ ok: true });
});

app.post('/api/staff/tickets/:id/transfer', auth, staff, ticketExists, async (req, res) => {
  if (!req.user.permission_ids.includes(20)) {
    return res.status(403).json({ error: 'You do not have permission to do that' });
  }
  const id = Number(req.params.id);
  const team = Number(req.body.team_id);
  const reason = sanitizeHtml(String(req.body.reason || '').trim());
  if (![1, 2].includes(team)) return res.status(400).json({ error: 'Invalid team' });
  if (!reason) return res.status(400).json({ error: 'Transfer reason is required' });
  const [t] = await pool.query('SELECT team_id FROM tickets WHERE id=?', [id]);
  if (t[0].team_id === team) return res.status(400).json({ error: 'Ticket is already in that team' });
  await pool.query('UPDATE tickets SET team_id=? WHERE id=?', [team, id]);
  const teamName = team === 2 ? 'Product Development' : 'Customer Experience';
  const note = `<p><strong>Ticket transferred to ${teamName}</strong>${reason ? `</p><p>${reason}</p>` : '</p>'}`;
  await pool.query('INSERT INTO ticket_messages (ticket_id, user_id, body, is_note, sender_type) VALUES (?, ?, ?, 1, ?)', [id, req.user.id, note.slice(0, 4000), 'staff']);
  res.json({ ok: true, team_id: team });
});

app.post('/api/staff/tickets', auth, staff, async (req, res) => {
  const customer_id = Number(req.body.customer_id);
  const title = String(req.body.title || '').trim();
  const body = sanitizeHtml(String(req.body.body || '').trim());
  const transaction_id = req.body.transaction_id == null ? null : String(req.body.transaction_id || '').trim() || null;
  if (!customer_id || !title) return res.status(400).json({ error: 'customer_id and title required' });
  const [c] = await pool.query('SELECT 1 FROM users WHERE id=? AND role IS NULL', [customer_id]);
  if (!c.length) return res.status(400).json({ error: 'No such customer' });
  if (!body) return res.status(400).json({ error: 'Message required' });
  if (transaction_id) {
    const [p] = await pool.query("SELECT 1 FROM purchases WHERE userid=? AND checkout_reference=? AND status='PAID'", [customer_id, transaction_id]);
    if (!p.length) return res.status(400).json({ error: 'Linked order not found' });
  }
  const [result] = await pool.query('INSERT INTO tickets (customer_id, transaction_id, title) VALUES (?,?,?)',
    [customer_id, transaction_id, title.slice(0, 255)]);
  await pool.query('INSERT INTO ticket_messages (ticket_id, user_id, body, sender_type) VALUES (?,?,?,?)',
    [result.insertId, req.user.id, body.slice(0, 4000), 'staff']);
  res.json({ ok: true, id: result.insertId });
});

app.post('/api/tickets', auth, async (req, res) => {
  const title = String(req.body.title || '').trim();
  const body = sanitizeHtml(String(req.body.body || '').trim());
  const transaction_id = req.body.transaction_id == null ? null : String(req.body.transaction_id || '').trim() || null;
  if (!title) return res.status(400).json({ error: 'Title required' });
  if (!body) return res.status(400).json({ error: 'Message required' });
  if (transaction_id) {
    const [p] = await pool.query("SELECT 1 FROM purchases WHERE userid=? AND checkout_reference=? AND status='PAID'", [req.user.id, transaction_id]);
    if (!p.length) return res.status(400).json({ error: 'Linked order not found' });
  }
  const [result] = await pool.query('INSERT INTO tickets (customer_id, transaction_id, title) VALUES (?,?,?)',
    [req.user.id, transaction_id, title.slice(0, 255)]);
  await pool.query('INSERT INTO ticket_messages (ticket_id, user_id, body, sender_type) VALUES (?,?,?,?)',
    [result.insertId, req.user.id, body.slice(0, 4000), 'customer']);
  res.json({ ok: true, id: result.insertId });
});

/* ---- tickets: customer list & detail ---- */

app.get('/api/tickets', auth, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT t.id, t.title, t.status, t.transaction_id, t.created_at, t.updated_at
     FROM tickets t WHERE t.customer_id = ? ORDER BY t.updated_at DESC LIMIT 100`,
    [req.user.id]
  );
  res.json({ tickets: rows });
});

app.get('/api/tickets/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ticket id' });
  const [tickets] = await pool.query(
    `SELECT t.id, t.title, t.status, t.transaction_id, t.customer_id, t.created_at, t.updated_at
     FROM tickets t WHERE t.id = ? AND t.customer_id = ?`,
    [id, req.user.id]
  );
  if (!tickets.length) return res.status(404).json({ error: 'Ticket not found' });
  const ticket = tickets[0];
  const [messages] = await pool.query(
    `SELECT tm.id, tm.user_id, tm.sender_type, u.firstname, u.role, tm.body, tm.attachments, tm.created_at
     FROM ticket_messages tm JOIN users u ON u.id = tm.user_id
     WHERE tm.ticket_id = ? AND tm.is_note = 0
     ORDER BY tm.created_at ASC, tm.id ASC`,
    [id]
  );
  for (const m of messages) m.attachments = parseAttachments(m.attachments);
  res.json({ ticket, messages });
});

function sanitizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const a of value) {
    if (!a || typeof a !== 'object') continue;
    const url = typeof a.url === 'string' ? a.url.trim() : '';
    if (!url) continue;
    const name = typeof a.name === 'string' ? a.name.trim().slice(0, 255) : '';
    const size = Number.isFinite(Number(a.size)) && Number(a.size) >= 0 ? Number(a.size) : null;
    out.push({ url, name, size });
  }
  return out;
}

function parseAttachments(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

/* ---- tickets: replies ---- */

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function sendTicketReplyEmail(ticket, customer) {
  if (!transporter) {
    console.log('SMTP not configured - skipping ticket reply email');
    return false;
  }
  const link = `${APP_URL}/account/tickets/${ticket.id}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#0b0616;border-radius:12px;color:#e2e8f0">
      <h2 style="margin:0 0 16px;color:#fff">New reply on your ticket</h2>
      <p>Hi ${customer.firstname},</p>
      <p style="margin:0 0 20px">A member of the KGM Cloud team has replied to your support ticket. Log in to your account to view the reply and respond.</p>
      <div style="margin:24px 0;text-align:center">
        <a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;font-weight:700;padding:14px 28px;border-radius:8px;text-decoration:none">View ticket</a>
      </div>
    </div>`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: customer.email,
    subject: 'New reply on your KGM Cloud ticket',
    html,
  });
  return true;
}

async function sendTicketReminderEmail(ticket, customer) {
  if (!transporter) {
    console.log('SMTP not configured - skipping ticket reminder email');
    return false;
  }
  const link = `${APP_URL}/account/tickets/${ticket.id}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#0b0616;border-radius:12px;color:#e2e8f0">
      <h2 style="margin:0 0 16px;color:#fff">Your ticket is waiting for your reply</h2>
      <p>Hi ${customer.firstname},</p>
      <p style="margin:0 0 20px">A member of the KGM Cloud team replied to your support ticket more than a day ago. Log in to your account to view the reply and respond within the next <strong style="color:#fff">24 hours</strong>; otherwise your ticket will be closed automatically.</p>
      <div style="margin:24px 0;text-align:center">
        <a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;font-weight:700;padding:14px 28px;border-radius:8px;text-decoration:none">Open ticket</a>
      </div>
    </div>`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: customer.email,
    subject: 'Your KGM Cloud ticket is waiting for your reply',
    html,
  });
  return true;
}

async function sendTicketClosedEmail(customer) {
  if (!transporter) {
    console.log('SMTP not configured - skipping ticket closed email');
    return false;
  }
  const link = `${APP_URL}/account?tab=tickets`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#0b0616;border-radius:12px;color:#e2e8f0">
      <h2 style="margin:0 0 16px;color:#fff">Your ticket has been closed</h2>
      <p>Hi ${customer.firstname},</p>
      <p style="margin:0 0 20px">We closed one of your support tickets after not receiving a reply. Log in to your account to review it, and if you still need a hand, you can open a new ticket any time.</p>
      <div style="margin:24px 0;text-align:center">
        <a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;font-weight:700;padding:14px 28px;border-radius:8px;text-decoration:none">View your tickets</a>
      </div>
    </div>`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: customer.email,
    subject: 'Your KGM Cloud ticket has been closed',
    html,
  });
  return true;
}

function ticketExists(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ticket id' });
  pool.query('SELECT id FROM tickets WHERE id=?', [id])
    .then(([rows]) => {
      if (!rows.length) return res.status(404).json({ error: 'Ticket not found' });
      next();
    })
    .catch((e) => { console.error(e); res.status(500).json({ error: 'DB error' }); });
}

app.post('/api/staff/tickets/:id/replies', auth, staff, ticketExists, async (req, res) => {
  const id = Number(req.params.id);
  const isNote = req.body.is_note === true || req.body.is_note === 1 || req.body.is_note === '1' || req.body.is_note === 'true';
  const requiredPerm = isNote ? 19 : 18;
  if (!req.user.permission_ids.includes(requiredPerm)) {
    return res.status(403).json({ error: 'You do not have permission to do that' });
  }
  if (!isNote) {
    const [t] = await pool.query('SELECT status FROM tickets WHERE id=?', [id]);
    if (['resolved','closed'].includes(t[0]?.status)) return res.status(400).json({ error: 'Replies are not allowed on resolved or closed tickets' });
  }
  const body = sanitizeHtml(String(req.body.body || '').trim());
  const attachments = sanitizeAttachments(req.body.attachments);
  if (!body && attachments.length === 0) return res.status(400).json({ error: 'Reply body is required' });
  await pool.query('INSERT INTO ticket_messages (ticket_id, user_id, body, is_note, attachments, sender_type) VALUES (?, ?, ?, ?, ?, ?)', [id, req.user.id, body, isNote ? 1 : 0, attachments.length ? JSON.stringify(attachments) : null, 'staff']);
  if (!isNote) {
    await pool.query(`UPDATE tickets SET status = 'awaiting_customer' WHERE id = ?`, [id]);
    try {
      const [owner] = await pool.query(
        'SELECT u.email, u.firstname FROM tickets t JOIN users u ON u.id=t.customer_id WHERE t.id=?', [id]
      );
      if (owner.length) {
        sendTicketReplyEmail({ id }, owner[0]).catch((e) => console.error('ticket reply email failed:', e.message));
      }
    } catch (e) {
      console.error('ticket reply email failed:', e.message);
    }
  }
  res.json({ ok: true });
});

app.post('/api/tickets/:id/replies', auth, ticketExists, async (req, res) => {
  const id = Number(req.params.id);
  const [t] = await pool.query('SELECT customer_id, status FROM tickets WHERE id=?', [id]);
  if (t[0].customer_id !== req.user.id) return res.status(403).json({ error: 'Not your ticket' });
  if (['resolved','closed'].includes(t[0]?.status)) return res.status(400).json({ error: 'Replies are not allowed on resolved or closed tickets' });
  const body = sanitizeHtml(String(req.body.body || '').trim());
  const attachments = sanitizeAttachments(req.body.attachments);
  if (!body && attachments.length === 0) return res.status(400).json({ error: 'Message required' });
  await pool.query('INSERT INTO ticket_messages (ticket_id, user_id, body, attachments, sender_type) VALUES (?,?,?,?,?)', [id, req.user.id, body.slice(0, 4000), attachments.length ? JSON.stringify(attachments) : null, 'customer']);
  await pool.query(`UPDATE tickets SET status = 'awaiting_cx' WHERE id = ?`, [id]);
  res.json({ ok: true });
});

app.post('/api/tickets/:id/resolve', auth, ticketExists, async (req, res) => {
  const id = Number(req.params.id);
  const [t] = await pool.query('SELECT customer_id, status FROM tickets WHERE id=?', [id]);
  if (t[0].customer_id !== req.user.id) return res.status(403).json({ error: 'Not your ticket' });
  if (t[0].status === 'closed') return res.status(400).json({ error: 'Closed tickets cannot be resolved' });
  await pool.query(`UPDATE tickets SET status = 'resolved' WHERE id = ?`, [id]);
  res.json({ ok: true });
});

/* ---- staff: customers ---- */

app.get('/api/staff/customers', auth, staff, perm('view.customer'), async (req, res) => {
  const search = (req.query.search || '').toString().trim();
  const like = `%${search}%`;
  const [rows] = search
    ? await pool.query('SELECT id, firstname, email, email_verified, created_at FROM users WHERE role IS NULL AND (firstname LIKE ? OR email LIKE ?) ORDER BY id DESC LIMIT 200', [like, like])
    : await pool.query('SELECT id, firstname, email, email_verified, created_at FROM users WHERE role IS NULL ORDER BY id DESC LIMIT 200');
  res.json(rows);
});

app.get('/api/staff/customers/:id', auth, staff, perm('view.customer'), async (req, res) => {
  const id = Number(req.params.id);
  const [rows] = await pool.query('SELECT id, firstname, email, email_verified, created_at FROM users WHERE id=?', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Account not found' });
  const [purchases] = await pool.query(
    `SELECT id, checkout_reference AS transactionid, items_purchased, amount, currency,
            created_at AS purchase_datetime
     FROM purchases WHERE userid=? AND status='PAID' ORDER BY created_at DESC`, [id]);
  const invoices = [];
  for (const p of purchases) {
    const ids = String(p.items_purchased || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    let item_names = 'Digital content';
    if (ids.length) {
      const [prods] = await pool.query('SELECT id, name FROM products WHERE id IN (?)', [ids]);
      const byId = new Map(prods.map((r) => [r.id, r]));
      item_names = ids.map((pid) => (byId.get(pid) ? byId.get(pid).name : null)).filter(Boolean).join(', ') || 'Digital content';
    }
    invoices.push({
      transactionid: p.transactionid,
      purchase_datetime: p.purchase_datetime,
      item_names,
      amount: Number(p.amount) || 0,
      currency: p.currency || 'GBP',
    });
  }
  const [licenses] = await pool.query(
    `SELECT l.license_key, l.status, l.created_at, p.name AS product_name
     FROM licenses l JOIN products p ON p.id=l.product_id
     WHERE l.user_id=? ORDER BY l.created_at DESC`, [id]);
res.json({ ...rows[0], purchases: invoices, licenses });
});


/* ---- staff: userdetails for any user ---- */


function isApprover(role) {
  return role === 'cx_manager' || role === 'operations_director' || role === 'managing_director';
}


async function userDetailsPayload(id) {
  const [users] = await pool.query(
    `SELECT u.id, u.firstname, u.email, u.role, u.team, u.email_verified, u.created_at,
            r.title AS role_title, t.team_name
     FROM users u
     LEFT JOIN roles r ON r.id = u.role
     LEFT JOIN teams t ON t.id = u.team
     WHERE u.id=?`, [id]);
  if (!users.length) return null;
  const user = users[0];
  const [purchases] = await pool.query(
    `SELECT id, checkout_reference AS transactionid, items_purchased, amount, currency,
            created_at AS purchase_datetime
     FROM purchases WHERE userid=? AND status='PAID' ORDER BY created_at DESC`, [id]);
  const invoices = [];
  for (const p of purchases) {
    const ids = String(p.items_purchased || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    let item_names = 'Digital content';
    if (ids.length) {
      const [prods] = await pool.query('SELECT id, name FROM products WHERE id IN (?)', [ids]);
      const byId = new Map(prods.map((r) => [r.id, r]));
      item_names = ids.map((pid) => (byId.get(pid) ? byId.get(pid).name : null)).filter(Boolean).join(', ') || 'Digital content';
    }
    invoices.push({
      transactionid: p.transactionid,
      purchase_datetime: p.purchase_datetime,
      item_names,
      amount: Number(p.amount) || 0,
      currency: p.currency || 'GBP',
    });
  }
  const [licenses] = await pool.query(
    `SELECT l.license_key, l.status, l.created_at, p.name AS product_name
     FROM licenses l JOIN products p ON p.id=l.product_id
     WHERE l.user_id=? ORDER BY l.created_at DESC`, [id]);
  const [notes] = await pool.query(
    `SELECT n.id, n.body, n.created_at, u.firstname AS author_firstname, u.role AS author_role
     FROM internal_notes n JOIN users u ON u.id=n.author_id
     WHERE n.user_id=? ORDER BY n.created_at DESC`, [id]);
  const [requests] = await pool.query(
    `SELECT r.id, r.type, r.items_purchased, r.amount, r.currency, r.reason, r.status,
            r.decision_note, r.payment_link, r.created_at, r.decided_at,
            u.firstname AS created_by_firstname, u.role AS created_by_role,
            d.firstname AS decided_by_firstname
     FROM order_requests r
     JOIN users u ON u.id=r.created_by
     LEFT JOIN users d ON d.id=r.decided_by
     WHERE r.customer_id=? ORDER BY r.created_at DESC`, [id]);
  const requestItems = [];
  for (const r of requests) {
    const ids = String(r.items_purchased || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    let item_names = 'Digital content';
    if (ids.length) {
      const [prods] = await pool.query('SELECT id, name FROM products WHERE id IN (?)', [ids]);
      const byId = new Map(prods.map((r2) => [r2.id, r2]));
      item_names = ids.map((pid) => (byId.get(pid) ? byId.get(pid).name : null)).filter(Boolean).join(', ') || 'Digital content';
    }
    requestItems.push({ ...r, item_names });
  }
  return {
    id: user.id,
    firstname: user.firstname,
    email: user.email,
    role: user.role,
    role_title: user.role_title || '',
    team: user.team,
    team_name: user.team_name || '',
    email_verified: user.email_verified,
    created_at: user.created_at,
    purchases: invoices,
    licenses,
    notes,
    order_requests: requestItems,
  };
}


app.get('/api/staff/userdetails/:id', auth, staff, perm('view.customer'), async (req, res) => {
  const id = Number(req.params.id);
  const payload = await userDetailsPayload(id);
  if (!payload) return res.status(404).json({ error: 'User not found' });
  res.json(payload);
});


function productNamesFromCsv(csv) {
  const ids = String(csv || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return null;
  return Promise.resolve().then(async () => {
    const [prods] = await pool.query('SELECT id, name FROM products WHERE id IN (?)', [ids]);
    const byId = new Map(prods.map((r) => [r.id, r]));
    return ids.map((pid) => (byId.get(pid) ? byId.get(pid).name : null)).filter(Boolean).join(', ') || 'Digital content';
  });
}


function sendOrderApprovedEmail(customerId, itemNames, symbol, amount, payUrl) {
  return Promise.resolve().then(async () => {
    const [users] = await pool.query('SELECT firstname, email FROM users WHERE id=?', [customerId]);
    if (!users.length || !transporter) return false;
    const u = users[0];
    const html = renderEmailTemplate('OrderApprovedTemplate', {
      FIRSTNAME: u.firstname,
      ITEMS: itemNames,
      SYMBOL: symbol,
      AMOUNT: String(Number(amount).toFixed(2)),
      PAY_URL: payUrl,
    });
    await transporter.sendMail({
      from: `"KGM Cloud" <${process.env.SMTP_FROM || 'noreply@kgmcloud.co.uk'}>`,
      to: u.email,
      subject: 'Your discounted order is ready to pay',
      html,
    });
    return true;
  }).catch((e) => { console.error('order request email failed:', e.message); return false; });
}


app.post('/api/staff/order-requests', auth, staff, perm(16), async (req, res) => {
  try {
    const customerId = Number(req.body.customer_id);
    const type = String(req.body.type || 'discount') === 'free' ? 'free' : 'discount';
    const ids = [...new Set((req.body.items || []).map((i) => Number(i && i.id)).filter((n) => Number.isInteger(n) && n > 0))];
    const reason = String(req.body.reason || '').slice(0, 500);
    if (!Number.isInteger(customerId) || customerId <= 0) return res.status(400).json({ error: 'Customer is required' });
    const [cust] = await pool.query('SELECT id FROM users WHERE id=?', [customerId]);
    if (!cust.length) return res.status(400).json({ error: 'User not found' });
    if (!ids.length) return res.status(400).json({ error: 'Select at least one product' });
    if (type === 'free') {
      const [prods] = await pool.query('SELECT id FROM products WHERE id IN (?) AND active=1', [ids]);
      if (prods.length !== ids.length) return res.status(400).json({ error: 'Some products are unavailable' });
    }
    let amount = 0;
    if (type === 'discount') {
      amount = Math.round(Number(req.body.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a discounted amount' });
      const [prods] = await pool.query('SELECT id FROM products WHERE id IN (?) AND active=1', [ids]);
      if (prods.length !== ids.length) return res.status(400).json({ error: 'Some products are unavailable' });
    }
    const [rows] = await pool.query(
      `INSERT INTO order_requests (customer_id, created_by, type, items_purchased, amount, currency, reason)
       VALUES (?,?,?,?,?,?,?)`,
      [customerId, req.user.id, type, ids.join(','), amount, 'GBP', reason || null]
    );
    res.json({ ok: true, id: rows.insertId });
  } catch (e) {
    console.error('create order request failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/staff/order-requests/pending-count', auth, staff, async (req, res) => {
  if (!req.user.permission_ids.includes(24)) {
    return res.status(403).json({ error: 'You do not have permission to do that' });
  }
  const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM order_requests WHERE status = 'pending'`);
  res.json({ ok: true, pending: Number(rows[0].n) });
});

app.get('/api/staff/order-requests', auth, staff, async (req, res) => {
  if (!req.user.permission_ids.includes(24)) return res.status(403).json({ error: 'You do not have permission to do that' });
  const [rows] = await pool.query(
    `SELECT r.id, r.type, r.items_purchased, r.amount, r.currency, r.reason, r.status,
            r.decision_note, r.payment_link, r.created_at, r.decided_at,
            u.firstname AS customer_firstname, u.email AS customer_email,
            cr.firstname AS created_by_firstname,
            d.firstname AS decided_by_firstname
     FROM order_requests r
     JOIN users u ON u.id=r.customer_id
     JOIN users cr ON cr.id=r.created_by
     LEFT JOIN users d ON d.id=r.decided_by
     ORDER BY (r.status='pending') DESC, r.created_at DESC`);
  const out = [];
  for (const r of rows) {
    const item_names = await productNamesFromCsv(r.items_purchased);
    out.push({ ...r, item_names });
  }
  res.json(out);
});


app.post('/api/staff/order-requests/:id/approve', auth, staff, async (req, res) => {
  if (!req.user.permission_ids.includes(24)) return res.status(403).json({ error: 'You do not have permission to do that' });
  try {
    const id = Number(req.params.id);
    const note = String(req.body.note || '').slice(0, 500);
    const [rows] = await pool.query(
      `SELECT id, customer_id, type, items_purchased, amount, currency, status
       FROM order_requests WHERE id=?`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Order request not found' });
    const reqRow = rows[0];
    if (reqRow.status !== 'pending') return res.status(400).json({ error: 'This request has already been decided' });
    if (reqRow.type === 'free') {
      const reference = 'kgm-staff-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
      await grantPurchase(reqRow.customer_id, reqRow.items_purchased, 0, reqRow.currency || 'GBP', reference, null);
      const [p] = await pool.query('SELECT id FROM purchases WHERE checkout_reference=?', [reference]);
      await pool.query(
        `UPDATE order_requests SET status='completed', decision_note=?, decided_by=?, decided_at=NOW(), purchase_id=?, checkout_reference=?
         WHERE id=?`,
        [note || null, req.user.id, p.length ? p[0].id : null, reference, id]);
      return res.json({ ok: true, status: 'completed' });
    }
    // discounted -> create a SumUp hosted checkout for the discounted amount
    const reference = 'kgm-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    const base = (process.env.APP_URL || 'https://kgmcloud.co.uk').replace(/\/$/, '');
    // record the staff discount against the products' original prices, like a code at checkout
    let discountCode = null;
    let discountPercent = 0;
    let discountAmount = 0;
    {
      const pids = String(reqRow.items_purchased).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (pids.length) {
        const [prods] = await pool.query('SELECT id, price FROM products WHERE id IN (?)', [pids]);
        const byId = new Map(prods.map((p) => [Number(p.id), Number(p.price) || 0]));
        const subtotal = Math.round(pids.reduce((s, pid) => s + (byId.get(pid) || 0), 0) * 100) / 100;
        discountAmount = Math.round((subtotal - Number(reqRow.amount)) * 100) / 100;
        if (discountAmount > 0) {
          discountCode = 'STAFF-DISCOUNT';
          discountPercent = subtotal > 0 ? Math.round((discountAmount / subtotal) * 100) : 0;
        }
      }
    }
    const checkout = await sumupFetch('/v0.1/checkouts', {
      method: 'POST',
      body: JSON.stringify({
        checkout_reference: reference,
        amount: Number(reqRow.amount),
        currency: reqRow.currency || 'GBP',
        merchant_code: process.env.SUMUP_MERCHANT_CODE,
        description: 'KGM Cloud order ' + reference,
        return_url: base + '/api/checkout/webhook',
        redirect_url: base + '/account?tab=orders',
        hosted_checkout: { enabled: true },
      }),
    });
    pendingCheckouts.set(reference, {
      userid: reqRow.customer_id,
      items_purchased: reqRow.items_purchased,
      amount: Number(reqRow.amount),
      currency: reqRow.currency || 'GBP',
      sumup_checkout_id: checkout.id || null,
      discount_code: discountCode,
      discount_percent: discountPercent,
      discount_amount: discountAmount,
    });
    await pool.query(
      `UPDATE order_requests SET status='approved', sumup_checkout_id=?, payment_link=?, checkout_reference=?,
              decision_note=?, decided_by=?, decided_at=NOW()
       WHERE id=?`,
      [checkout.id || null, checkout.hosted_checkout_url || null, reference, note || null, req.user.id, id]);
    const item_names = await productNamesFromCsv(reqRow.items_purchased);
    const payUrl = base + '/account?tab=orders';
    await sendOrderApprovedEmail(reqRow.customer_id, item_names, currencySymbol(reqRow.currency || 'GBP'), reqRow.amount, payUrl);
    return res.json({ ok: true, status: 'approved', payment_link: checkout.hosted_checkout_url || null });
  } catch (e) {
    console.error('approve order request failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/staff/order-requests/:id/decline', auth, staff, async (req, res) => {
  if (!req.user.permission_ids.includes(24)) return res.status(403).json({ error: 'You do not have permission to do that' });
  const id = Number(req.params.id);
  const note = String(req.body.note || '').slice(0, 500);
  const [rows] = await pool.query('SELECT id, customer_id, status FROM order_requests WHERE id=?', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Order request not found' });
  if (rows[0].status !== 'pending') return res.status(400).json({ error: 'This request has already been decided' });
  await pool.query(
    `UPDATE order_requests SET status='declined', decision_note=?, decided_by=?, decided_at=NOW() WHERE id=?`,
    [note || null, req.user.id, id]);
  res.json({ ok: true });
});


/* ---- customer: their own order requests ---- */

app.get('/api/order-requests', auth, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, type, items_purchased, amount, currency, status, decision_note, created_at, decided_at
     FROM order_requests WHERE customer_id=? ORDER BY created_at DESC`,
    [req.user.id]);
  const out = [];
  for (const r of rows) {
    out.push({ ...r, item_names: await productNamesFromCsv(r.items_purchased) });
  }
  res.json(out);
});

app.post('/api/order-requests/:id/pay', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const consent = req.body.digital_consent;
    if (consent !== true && consent !== '1' && consent !== 1) {
      return res.status(400).json({ error: 'You must accept the digital delivery terms before you can pay' });
    }
    const [rows] = await pool.query(
      `SELECT id, customer_id, status, checkout_reference, payment_link FROM order_requests WHERE id=?`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Order request not found' });
    if (Number(rows[0].customer_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'This order request does not belong to your account' });
    }
    if (rows[0].status !== 'approved') {
      return res.status(400).json({ error: 'This order request is not ready to pay' });
    }
    if (!rows[0].payment_link) {
      return res.status(500).json({ error: 'No payment link available yet - please contact support' });
    }
    const ip = getClientIp(req);
    const basket = pendingCheckouts.get(rows[0].checkout_reference);
    if (basket) {
      basket.digital_consent = 1;
      basket.digital_consent_at = new Date();
      basket.digital_consent_ip = ip;
      basket.country = (await geoCountry(ip)) || null;
    }
    res.json({ ok: true, hosted_checkout_url: rows[0].payment_link });
  } catch (e) {
    console.error('order request pay failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});


/* ---- staff: internal notes about a user ---- */


app.post('/api/staff/userdetails/:id/notes', auth, staff, perm(17), async (req, res) => {
  const id = Number(req.params.id);
  const body = String(req.body.body || '').trim().slice(0, 4000);
  if (!body) return res.status(400).json({ error: 'Note is empty' });
  const [rows] = await pool.query('SELECT id FROM users WHERE id=?', [id]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  const [ins] = await pool.query(
    'INSERT INTO internal_notes (user_id, author_id, body) VALUES (?,?,?)',
    [id, req.user.id, body]);
  res.json({ ok: true, id: ins.insertId });
});


/* ---- staff: user detail / role ---- */
app.get('/api/staff/users/:id', auth, staff, async (req, res) => {
  const id = Number(req.params.id);
  const [rows] = await pool.query(
    `SELECT u.id, u.firstname, u.email, u.role, u.email_verified, u.created_at
     FROM users u WHERE u.id=?`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'Staff member not found' });
  if (rows[0].role == null) return res.status(404).json({ error: 'Not a staff member' });
  res.json(rows[0]);
});

app.put('/api/staff/users/:id/role', auth, staff, perm(33), async (req, res) => {
  const id = Number(req.params.id);
  const roleId = req.body.role == null ? null : Number(req.body.role);
  let teamCsv = req.body.team == null || req.body.team === '' ? null : null;
  const team = req.body.team;
  if (team === 'all') {
    const [allTeams] = await pool.query('SELECT id FROM teams ORDER BY id');
    teamCsv = allTeams.length ? allTeams.map((t) => t.id).join(',') : null;
  } else if (Array.isArray(team)) {
    const ids = team.map(Number).filter((n) => Number.isInteger(n) && n >= 1);
    teamCsv = ids.length ? ids.join(',') : null;
  } else if (team != null && team !== '') {
    teamCsv = Number(team);
  }
  if (roleId != null && !(Number.isInteger(roleId) && roleId >= 1)) return res.status(400).json({ error: 'Invalid role' });
  const teamIdList = teamCsv ? String(teamCsv).split(',').map(Number).filter(Boolean) : [];
  if (teamIdList.length) {
    const [t] = await pool.query('SELECT COUNT(*) AS n FROM teams WHERE id IN (?)', [teamIdList]);
    if (t[0].n !== teamIdList.length) return res.status(400).json({ error: 'Unknown team' });
  }
  const [rows] = await pool.query('SELECT id FROM users WHERE id=?', [id]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  if (roleId != null) {
    const [r] = await pool.query('SELECT id FROM roles WHERE id=?', [roleId]);
    if (!r.length) return res.status(400).json({ error: 'Unknown role' });
  }
  let permCsv = undefined;
  if (Array.isArray(req.body.permissions)) {
    const permIds = req.body.permissions.map(Number).filter((n) => Number.isInteger(n) && n >= 1);
    permCsv = permIds.length ? [...new Set(permIds)].join(',') : '';
  }
  if (permCsv !== undefined) {
    await pool.query('UPDATE users SET role=?, team=?, permissions=? WHERE id=?', [roleId, teamCsv, permCsv, id]);
  } else {
    await pool.query('UPDATE users SET role=?, team=? WHERE id=?', [roleId, teamCsv, id]);
  }
  res.json({ ok: true });
});


/* ---- staff: accounts ---- */


app.get('/api/staff/accounts', auth, staff, perm('view.customer'), async (req, res) => {
  const search = (req.query.search || '').toString().trim();
  const like = `%${search}%`;
  const select = 'u.id, u.firstname, u.email, u.role, u.email_verified, u.created_at, r.title AS role_title';
  const [rows] = search
    ? await pool.query(
        `SELECT ${select} FROM users u LEFT JOIN roles r ON r.id = u.role
         WHERE (u.firstname LIKE ? OR u.email LIKE ?) ORDER BY u.id DESC LIMIT 400`,
        [like, like])
    : await pool.query(
        `SELECT ${select} FROM users u LEFT JOIN roles r ON r.id = u.role
         ORDER BY u.id DESC LIMIT 400`);
  res.json(rows);
});


app.patch('/api/staff/accounts/:id', auth, staff, perm('employees.assign_role'), async (req, res) => {
  const id = Number(req.params.id);
  const roleId = req.body.role == null ? null : Number(req.body.role);
  if (roleId != null && !(Number.isInteger(roleId) && roleId >= 1)) return res.status(400).json({ error: 'Invalid role' });
  const [trows] = await pool.query('SELECT id, role FROM users WHERE id=?', [id]);
  if (!trows.length) return res.status(404).json({ error: 'User not found' });
  if (roleId != null) {
    const [r] = await pool.query('SELECT id FROM roles WHERE id=?', [roleId]);
    if (!r.length) return res.status(400).json({ error: 'Unknown role' });
  }
  await pool.query('UPDATE users SET role=? WHERE id=?', [roleId, id]);
  res.json({ ok: true });
});








app.put('/api/account/profile', auth, async (req, res) => {
  const firstname = String(req.body.firstname || '').trim();
  const surname = String(req.body.surname || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!firstname || !surname) return res.status(400).json({ error: 'First and last name required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  const dobRaw = String(req.body.dob || '').trim();
  let dob = null;
  if (dobRaw) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobRaw);
    if (!m) return res.status(400).json({ error: 'Invalid date of birth' });
    const dobDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (dobDate.getTime() >= Date.now()) return res.status(400).json({ error: 'Date of birth must be in the past' });
    dob = dobRaw;
  }
  const [rows] = await pool.query('SELECT id, role, email, email_verified FROM users WHERE id=?', [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Account not found' });
  const cur = rows[0];
  const emailChanged = email !== cur.email;
  let verification_required = false;
  let email_sent = false;
  if (emailChanged) {
    const [dupe] = await pool.query('SELECT id FROM users WHERE email=? AND id<>?', [email, cur.id]);
    if (dupe.length) return res.status(409).json({ error: 'Email already registered' });
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('UPDATE users SET firstname=?, surname=?, email=?, dob=?, email_verified=0, email_token=? WHERE id=?', [firstname, surname, email, dob, token, cur.id]);
    try {
      email_sent = await sendVerificationEmail(email, token, firstname);
    } catch (e) {
      console.error('email send failed:', e.message);
    }
    verification_required = true;
  } else {
    await pool.query('UPDATE users SET firstname=?, surname=?, dob=? WHERE id=?', [firstname, surname, dob, cur.id]);
  }
  const { ids: permission_ids, permissions } = await getUserPermissions(cur.id, cur.role || null);
  const is_staff = cur.role != null;
  res.json({
    ok: true,
    user: { id: cur.id, firstname, surname, email, role: cur.role || null, email_verified: cur.email_verified, is_staff, home_team_id: null, team_ids: [], managed_team_ids: [], permission_ids, permissions, dob },
    verification_required,
    email_sent,
  });
});


app.put('/api/account/preferences', auth, async (req, res) => {
  const marketing_opt_in = req.body.marketing_opt_in;
  if (typeof marketing_opt_in !== 'boolean')
    return res.status(400).json({ error: 'marketing_opt_in (boolean) required' });
  await pool.query('UPDATE users SET marketing_opt_in=? WHERE id=?', [marketing_opt_in ? 1 : 0, req.user.id]);
  res.json({ ok: true, marketing_opt_in });
});


app.post('/api/account/password', auth, async (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (!current) return res.status(400).json({ error: 'Current password required' });
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const [rows] = await pool.query('SELECT password_hash FROM users WHERE id=?', [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Account not found' });
  if (!(await bcrypt.compare(current, rows[0].password_hash)))
    return res.status(400).json({ error: 'Current password is incorrect' });
  const hash = await bcrypt.hash(next, 10);
  await pool.query('UPDATE users SET password_hash=? WHERE id=?', [hash, req.user.id]);
  res.json({ ok: true });
});


/* ---- forgot / reset password ---- */


const PASSWORD_RESET_HTML = (firstname, link) => `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">
    <h2 style="margin-bottom:16px">Reset your KGM Cloud password</h2>
    <p>Hi ${firstname},</p>
    <p>We received a request to reset your password. Click the button below to set a new one.</p>
    <p style="text-align:center;margin:24px 0">
      <a href="${link}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:8px">Reset password</a>
    </p>
    <p style="font-size:14px;color:#6b7280">This link is valid for 15 minutes. If you didn't request this, you can safely ignore this email.</p>
  </div>
`;


app.post('/api/auth/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').toString().toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required' });


  const [rows] = await pool.query('SELECT id, firstname FROM users WHERE email = ?', [email]);
  if (!rows.length) return res.json({ ok: true });


  const firstname = rows[0].firstname || 'there';
  const token = crypto.randomBytes(32).toString('hex');
  const link = `https://kgmcloud.co.uk/reset-password?token=${token}`;
  const expires = new Date(Date.now() + 15 * 60 * 1000);


  await pool.query('UPDATE users SET email_token = ?, reset_expires_at = ? WHERE email = ?', [token, expires, email]);


  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'KGM Cloud <no-reply@kgmcloud.co.uk>',
      to: email,
      subject: 'Reset your KGM Cloud password',
      html: PASSWORD_RESET_HTML(firstname, link),
    });
  } catch (err) {
    console.error('email send failed:', err.message);
    return res.status(500).json({ error: 'Failed to send the reset email. Please try again.' });
  }
  res.json({ ok: true });
});


app.get('/api/auth/check-reset-token', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) return res.json({ valid: false });
  const [rows] = await pool.query(
    'SELECT reset_expires_at FROM users WHERE email_token = ? AND reset_expires_at IS NOT NULL', [token]
  );
  if (!rows.length) return res.json({ valid: false });
  const expires = new Date(rows[0].reset_expires_at);
  res.json({ valid: expires.getTime() > Date.now() });
});


app.post('/api/auth/reset-password', async (req, res) => {
  const token = String(req.body.token || '').trim();
  const password = String(req.body.password || req.body.new_password || '');
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });


  const [rows] = await pool.query('SELECT id, email, reset_expires_at FROM users WHERE email_token = ? AND reset_expires_at IS NOT NULL', [token]);
  if (!rows.length) return res.status(400).json({ error: 'This link is invalid or has already been used.' });


  const expires = new Date(rows[0].reset_expires_at);
  if (expires.getTime() < Date.now())
    return res.status(400).json({ error: 'This reset link has expired. Request a new one.' });


  const hash = await bcrypt.hash(password, 10);
  await pool.query('UPDATE users SET password_hash = ?, email_verified = 1, email_token = NULL, reset_expires_at = NULL WHERE id = ?', [hash, rows[0].id]);
  res.json({ ok: true });
});


/*
/* ---- health ---- */


app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});


/* ---- uploads seed: copy images baked into the Docker image onto the uploads
       volume on first boot. Runs here (not just in docker-entrypoint.sh) so it
       works regardless of any container command/entrypoint override. ---- */
try {
  const seedFs = require('fs');
  const seedPath = require('path');
  const seedSrc = '/seed/uploads';
  const seedDst = seedPath.join(__dirname, 'uploads');
  seedFs.mkdirSync(seedDst, { recursive: true });
  if (seedFs.existsSync(seedSrc) && seedFs.readdirSync(seedDst).length === 0) {
    for (const entry of seedFs.readdirSync(seedSrc)) {
      seedFs.cpSync(seedPath.join(seedSrc, entry), seedPath.join(seedDst, entry), { recursive: true });
    }
    console.log('[uploads] seeded from image -> ' + seedDst);
  }
} catch (e) {
  console.log('[uploads] seed skipped: ' + e.message);
}
console.log('[image-marker] kgmcloud-api seed patch active 2026-10-07');


app.listen(3000, async () => {
  await init();
  seedBirthdaySettings().catch((e) => console.error('birthday settings seed failed:', e.message));
  runBirthdayScan();
  scheduleBirthdayScan();
  runTicketReminderScan();
  scheduleTicketReminderScan();
  console.log('api on :3000');
});