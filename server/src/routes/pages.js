import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIR } from '../paths.js';
import { appleAppSiteAssociation, appleMeta } from '../views.js';

const PAGES = { s: 's.html', bar: 'bar.html', qr: 'qr.html', settings: 'settings.html' };

export default async function pageRoutes(app, { config }) {
  const read = (file) => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  const sendHtml = (reply, html) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);

  for (const [prefix, file] of Object.entries(PAGES)) {
    let html = read(file);
    if (prefix === 's') html = html.replace('<!--APPLE_META-->', appleMeta(config));
    app.get(`/${prefix}/:shop`, (_req, reply) => sendHtml(reply, html));
  }

  const superPage = read('super.html');
  app.get('/super', (_req, reply) => sendHtml(reply, superPage));
  const brandPage = read('brand.html');
  app.get('/brand/:brand', (_req, reply) => sendHtml(reply, brandPage));

  const index = read('index.html');
  app.get('/', (_req, reply) => sendHtml(reply, index));

  app.get('/.well-known/apple-app-site-association', (_req, reply) => {
    const aasa = appleAppSiteAssociation(config);
    if (!aasa) return reply.code(404).send({ error: 'مش موجود' });
    return reply.type('application/json').send(aasa);
  });
}
