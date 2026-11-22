import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Mistral } from '@mistralai/mistralai';
import { google } from 'googleapis';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('payload too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== 'object' || value === null) return false;
  const msg = value as Record<string, unknown>;
  return (
    (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') &&
    typeof msg.content === 'string'
  );
}

async function handleChat(req: IncomingMessage, res: ServerResponse) {
  let messages: ChatMessage[];
  try {
    const body = JSON.parse(await readBody(req));
    if (
      !Array.isArray(body.messages) ||
      body.messages.length === 0 ||
      !body.messages.every(isChatMessage)
    ) {
      sendJson(res, 400, {
        error: 'Corps attendu : { "messages": [{ "role": "user", "content": "..." }] }',
      });
      return;
    }
    messages = body.messages;
  } catch {
    sendJson(res, 400, { error: 'JSON invalide ou requête trop volumineuse.' });
    return;
  }

  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    sendJson(res, 500, {
      error: 'MISTRAL_API_KEY manquante côté serveur. Créez un fichier .env (voir .env.example).',
    });
    return;
  }

  try {
    const client = new Mistral({ apiKey });
    const completion = await client.chat.complete({
      model: 'mistral-small-latest',
      messages,
    });
    const content = completion.choices?.[0]?.message?.content;
    const reply = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    sendJson(res, 200, { reply });
  } catch (error) {
    const detail = String((error as Error)?.message ?? error).slice(0, 300);
    sendJson(res, 502, { error: "Échec de l'appel à l'API Mistral.", detail });
  }
}

const PMJE_DOMAINES = [
  'Appartenance et contribution',
  'Autorégulation et bien-être',
  'Manifestation des habiletés en littératie et en mathématiques',
  'Résolution de problèmes et innovation',
] as const;

type PmjeDomaine = (typeof PMJE_DOMAINES)[number];

const CLASSIFY_SYSTEM_PROMPT = [
  "Tu es un assistant qui aide des enseignantes de la maternelle et du jardin d'enfants en Ontario",
  "à classer des observations d'élèves selon le Programme de la maternelle et du jardin d'enfants (PMJE, 2016).",
  '',
  "Chaque observation doit être classée dans UN SEUL des quatre domaines d'apprentissage :",
  '1. Appartenance et contribution',
  '2. Autorégulation et bien-être',
  '3. Manifestation des habiletés en littératie et en mathématiques',
  '4. Résolution de problèmes et innovation',
  '',
  "Analyse la photo (si fournie) et le commentaire de l'enseignante, puis réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte avant ou après :",
  '{',
  '  "domaine": "<intitulé exact de l\'un des quatre domaines ci-dessus>",',
  '  "justification": "<1 à 2 phrases en français expliquant le choix>"',
  '}',
].join('\n');

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; imageUrl: string };

async function runClassification(
  apiKey: string,
  comment: string,
  imageDataUrl?: string,
): Promise<{ domaine: PmjeDomaine; justification: string }> {
  const userContent: ContentPart[] = [];
  if (imageDataUrl) userContent.push({ type: 'image_url', imageUrl: imageDataUrl });
  userContent.push({ type: 'text', text: `Observation de l'enseignante :\n\n${comment}` });

  const client = new Mistral({ apiKey });
  const completion = await client.chat.complete({
    model: 'mistral-small-latest',
    messages: [
      { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    responseFormat: { type: 'json_object' },
    temperature: 0,
  });
  const raw = completion.choices?.[0]?.message?.content;
  const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`Réponse non JSON du modèle : ${rawText.slice(0, 300)}`);
  }
  const result = parsed as Record<string, unknown>;
  if (typeof result.domaine !== 'string' || !PMJE_DOMAINES.includes(result.domaine as PmjeDomaine)) {
    throw new Error(`Domaine invalide renvoyé par le modèle : ${rawText.slice(0, 300)}`);
  }
  const justification = typeof result.justification === 'string' ? result.justification : '';
  return { domaine: result.domaine as PmjeDomaine, justification };
}

async function handleClassify(req: IncomingMessage, res: ServerResponse) {
  let comment: string;
  let imageDataUrl: string | undefined;
  try {
    const body = JSON.parse(await readBody(req, 12_000_000));
    if (typeof body.comment !== 'string' || body.comment.trim().length === 0) {
      sendJson(res, 400, { error: 'Corps attendu : { "comment": "...", "imageDataUrl": "data:image/...;base64,..." (optionnel) }' });
      return;
    }
    comment = body.comment.trim();
    if (
      body.imageDataUrl !== undefined &&
      (typeof body.imageDataUrl !== 'string' || !/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/.test(body.imageDataUrl))
    ) {
      sendJson(res, 400, { error: 'imageDataUrl doit être une data URL image valide (data:image/...;base64,...).' });
      return;
    }
    imageDataUrl = body.imageDataUrl;
  } catch {
    sendJson(res, 400, { error: 'JSON invalide ou requête trop volumineuse.' });
    return;
  }

  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    sendJson(res, 500, {
      error: 'MISTRAL_API_KEY manquante côté serveur. Créez un fichier .env (voir .env.example).',
    });
    return;
  }

  try {
    const result = await runClassification(apiKey, comment, imageDataUrl);
    sendJson(res, 200, { domaine: result.domaine, justification: result.justification });
  } catch (error) {
    const detail = String((error as Error)?.message ?? error).slice(0, 300);
    sendJson(res, 502, { error: "Échec de l'appel à l'API Mistral.", detail, domainesAttendus: PMJE_DOMAINES });
  }
}

type Drive = ReturnType<typeof google.drive>;

function loadDriveCredentials(): { clientEmail: string; privateKey: string } {
  const raw = process.env.GOOGLE_DRIVE_CREDENTIALS ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!raw) {
    throw new Error(
      'GOOGLE_DRIVE_CREDENTIALS manquante côté serveur (JSON du compte de service ou chemin vers le fichier .json).',
    );
  }
  const json = raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8');
  const creds = JSON.parse(json) as Record<string, unknown>;
  if (typeof creds.client_email !== 'string' || typeof creds.private_key !== 'string') {
    throw new Error('Identifiants Google invalides : client_email et private_key sont requis.');
  }
  return { clientEmail: creds.client_email, privateKey: creds.private_key };
}

function getDrive(): Drive {
  const { clientEmail, privateKey } = loadDriveCredentials();
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned || 'Sans nom';
}

async function findFolder(drive: Drive, name: string, parentId: string): Promise<string | null> {
  const escaped = name.replace(/'/g, "\\'");
  const q = [
    "mimeType='application/vnd.google-apps.folder'",
    `name='${escaped}'`,
    `'${parentId}' in parents`,
    'trashed=false',
  ].join(' and ');
  const found = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 1, spaces: 'drive' });
  return found.data.files?.[0]?.id ?? null;
}

async function ensureFolder(drive: Drive, name: string, parentId: string): Promise<string> {
  const existing = await findFolder(drive, name, parentId);
  if (existing) return existing;
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
  });
  if (!created.data.id) throw new Error('Création du dossier Drive impossible.');
  return created.data.id;
}

async function findFileId(drive: Drive, name: string, parentId: string): Promise<string | null> {
  const escaped = name.replace(/'/g, "\\'");
  const q = [`name='${escaped}'`, `'${parentId}' in parents`, 'trashed=false'].join(' and ');
  const found = await drive.files.list({ q, fields: 'files(id)', pageSize: 1, spaces: 'drive' });
  return found.data.files?.[0]?.id ?? null;
}

async function readJsonFile(drive: Drive, folderId: string, name: string): Promise<unknown> {
  const fileId = await findFileId(drive, name, folderId);
  if (!fileId) return null;
  const content = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  try {
    return JSON.parse(await streamToString(content.data as NodeJS.ReadableStream));
  } catch {
    return null;
  }
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function appendObservationMetadata(
  drive: Drive,
  folderId: string,
  observation: Record<string, unknown>,
): Promise<void> {
  const existingId = await findFileId(drive, 'observations.json', folderId);
  const current = await readJsonFile(drive, folderId, 'observations.json');
  const observations: unknown[] = Array.isArray(current) ? current : [];
  observations.push(observation);
  const payload = JSON.stringify(observations, null, 2);
  if (existingId) {
    await drive.files.update({
      fileId: existingId,
      media: { mimeType: 'application/json', body: Readable.from(payload) },
    });
  } else {
    await drive.files.create({
      requestBody: { name: 'observations.json', mimeType: 'application/json', parents: [folderId] },
      media: { mimeType: 'application/json', body: Readable.from(payload) },
      fields: 'id',
    });
  }
}

const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;

async function handleObservation(req: IncomingMessage, res: ServerResponse) {
  let eleve: string;
  let comment: string;
  let imageDataUrl: string;
  try {
    const body = JSON.parse(await readBody(req, 12_000_000));
    if (typeof body.eleve !== 'string' || body.eleve.trim().length === 0) {
      sendJson(res, 400, {
        error: 'Corps attendu : { "eleve": "...", "comment": "...", "imageDataUrl": "data:image/...;base64,..." }',
      });
      return;
    }
    if (typeof body.comment !== 'string' || body.comment.trim().length === 0) {
      sendJson(res, 400, { error: 'Le champ "comment" est obligatoire.' });
      return;
    }
    if (typeof body.imageDataUrl !== 'string' || !DATA_URL_RE.test(body.imageDataUrl)) {
      sendJson(res, 400, { error: 'imageDataUrl doit être une data URL image valide (data:image/...;base64,...).' });
      return;
    }
    eleve = body.eleve.trim();
    comment = body.comment.trim();
    imageDataUrl = body.imageDataUrl;
  } catch {
    sendJson(res, 400, { error: 'JSON invalide ou requête trop volumineuse.' });
    return;
  }

  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    sendJson(res, 500, {
      error: 'MISTRAL_API_KEY manquante côté serveur. Créez un fichier .env (voir .env.example).',
    });
    return;
  }
  try {
    loadDriveCredentials();
  } catch (error) {
    sendJson(res, 500, { error: String((error as Error).message) });
    return;
  }

  const match = DATA_URL_RE.exec(imageDataUrl);
  if (!match) {
    sendJson(res, 400, { error: 'imageDataUrl invalide.' });
    return;
  }
  const mimeType = match[1];
  const imageBuffer = Buffer.from(match[2], 'base64');
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : mimeType === 'image/gif' ? 'gif' : 'jpg';

  try {
    const { domaine, justification } = await runClassification(apiKey, comment, imageDataUrl);

    const drive = getDrive();
    const rootId = await getRootFolderId(drive);
    const folderName = sanitizeFileName(eleve);
    const studentFolderId = await ensureFolder(drive, folderName, rootId);

    let codePartage: string;
    const partage = await readJsonFile(drive, studentFolderId, 'partage.json');
    if (partage && typeof (partage as { code?: unknown }).code === 'string') {
      codePartage = (partage as { code: string }).code;
    } else {
      codePartage = randomInt(100000, 1000000).toString();
      await drive.files.create({
        requestBody: { name: 'partage.json', mimeType: 'application/json', parents: [studentFolderId] },
        media: { mimeType: 'application/json', body: Readable.from(JSON.stringify({ code: codePartage })) },
        fields: 'id',
      });
    }

    const date = new Date().toISOString();
    const photoName = `${date.replace(/[:.]/g, '-')}_photo.${extension}`;
    const uploaded = await drive.files.create({
      requestBody: { name: photoName, parents: [studentFolderId] },
      media: { mimeType, body: Readable.from(imageBuffer) },
      fields: 'id,name,webViewLink,webContentLink',
    });
    const photoId = uploaded.data.id;
    if (!photoId) throw new Error("Upload de la photo vers Drive impossible.");
    try {
      await drive.permissions.create({
        fileId: photoId,
        requestBody: { role: 'reader', type: 'anyone' },
        fields: 'id',
      });
    } catch {}

    const observation = {
      id: randomUUID(),
      date,
      eleve: folderName,
      commentaire: comment,
      domaine,
      justification,
      photoId,
      photoName,
      photoLink: uploaded.data.webViewLink ?? null,
    };
    await appendObservationMetadata(drive, studentFolderId, observation);

    sendJson(res, 201, {
      ...observation,
      dossierId: studentFolderId,
      codePartage,
      lienPartage: `/partage/${encodeURIComponent(folderName)}?code=${codePartage}`,
    });
  } catch (error) {
    const detail = String((error as Error)?.message ?? error).slice(0, 300);
    sendJson(res, 502, { error: "Échec de l'enregistrement de l'observation.", detail });
  }
}

async function handleStudentObservations(nom: string, code: string, res: ServerResponse): Promise<void> {
  if (!code) {
    sendJson(res, 401, { error: "Code d'accès requis (paramètre ?code=)." });
    return;
  }
  try {
    loadDriveCredentials();
  } catch (error) {
    sendJson(res, 500, { error: String((error as Error).message) });
    return;
  }
  try {
    const drive = getDrive();
    const rootId = await getRootFolderId(drive);
    const folderName = sanitizeFileName(nom);
    const studentFolderId = await findFolder(drive, folderName, rootId);
    if (!studentFolderId) {
      sendJson(res, 404, { error: `Aucun dossier d'élève nommé « ${folderName} ».` });
      return;
    }
    const partage = await readJsonFile(drive, studentFolderId, 'partage.json');
    const codeAttendu =
      partage && typeof (partage as { code?: unknown }).code === 'string'
        ? (partage as { code: string }).code
        : null;
    if (!codeAttendu || codeAttendu !== code) {
      sendJson(res, 401, { error: "Code d'accès invalide." });
      return;
    }
    const raw = await readJsonFile(drive, studentFolderId, 'observations.json');
    const observations = (Array.isArray(raw) ? raw : []).map((o) => {
      const obs = o as Record<string, unknown>;
      return {
        ...obs,
        photoUrl:
          typeof obs.photoId === 'string'
            ? `https://drive.google.com/uc?export=view&id=${obs.photoId}`
            : null,
      };
    });
    sendJson(res, 200, { eleve: folderName, observations });
  } catch (error) {
    const detail = String((error as Error)?.message ?? error).slice(0, 300);
    sendJson(res, 502, { error: 'Échec de la lecture des observations.', detail });
  }
}

type Session = { email: string; expires: number };

const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function getSession(req: IncomingMessage): Session | null {
  const cookie = req.headers.cookie ?? '';
  const match = /(?:^|;\s*)session=([a-f0-9]{64})/.exec(cookie);
  if (!match) return null;
  const session = sessions.get(match[1]);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(match[1]);
    return null;
  }
  return session;
}

function getOAuth2Client(): InstanceType<typeof google.auth.OAuth2> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET sont requis (voir README).');
  }
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI ?? `http://localhost:${port}/auth/callback`;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function handleLogin(res: ServerResponse) {
  try {
    const oauth2 = getOAuth2Client();
    const url = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['openid', 'email', 'profile'],
    });
    res.writeHead(302, { location: url });
    res.end();
  } catch (error) {
    sendJson(res, 500, { error: String((error as Error).message) });
  }
}

async function handleCallback(url: URL, res: ServerResponse) {
  const code = url.searchParams.get('code');
  if (!code) {
    sendJson(res, 400, { error: 'Paramètre code manquant.' });
    return;
  }
  try {
    const oauth2 = getOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);
    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
    const userinfo = await oauth2Api.userinfo.get();
    const email = userinfo.data.email?.toLowerCase();
    if (!email) {
      sendJson(res, 403, { error: 'Impossible de récupérer votre adresse Google.' });
      return;
    }
    const allowed = (process.env.ALLOWED_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(email)) {
      sendJson(res, 403, { error: `Le compte ${email} n'est pas autorisé.` });
      return;
    }
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { email, expires: Date.now() + SESSION_TTL_MS });
    res.writeHead(302, {
      location: '/',
      'set-cookie': `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    });
    res.end();
  } catch (error) {
    const detail = String((error as Error)?.message ?? error).slice(0, 300);
    sendJson(res, 502, { error: "Échec de l'authentification Google.", detail });
  }
}

function handleLogout(req: IncomingMessage, res: ServerResponse) {
  const cookie = req.headers.cookie ?? '';
  const match = /(?:^|;\s*)session=([a-f0-9]{64})/.exec(cookie);
  if (match) sessions.delete(match[1]);
  res.writeHead(302, {
    location: '/',
    'set-cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
  });
  res.end();
}

async function getRootFolderId(drive: Drive): Promise<string> {
  return process.env.DRIVE_ROOT_FOLDER_ID || (await ensureFolder(drive, 'PMJE - Observations', 'root'));
}

async function readRoster(drive: Drive): Promise<{ rootId: string; eleves: string[] }> {
  const rootId = await getRootFolderId(drive);
  const raw = await readJsonFile(drive, rootId, 'eleves.json');
  const eleves = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  return { rootId, eleves };
}

async function writeRoster(drive: Drive, rootId: string, eleves: string[]): Promise<void> {
  const payload = JSON.stringify(eleves, null, 2);
  const existingId = await findFileId(drive, 'eleves.json', rootId);
  if (existingId) {
    await drive.files.update({
      fileId: existingId,
      media: { mimeType: 'application/json', body: Readable.from(payload) },
    });
  } else {
    await drive.files.create({
      requestBody: { name: 'eleves.json', mimeType: 'application/json', parents: [rootId] },
      media: { mimeType: 'application/json', body: Readable.from(payload) },
      fields: 'id',
    });
  }
}

function checkDriveConfig(res: ServerResponse): boolean {
  try {
    loadDriveCredentials();
    return true;
  } catch (error) {
    sendJson(res, 500, { error: String((error as Error).message) });
    return false;
  }
}

async function handleRosterGet(res: ServerResponse) {
  if (!checkDriveConfig(res)) return;
  try {
    const drive = getDrive();
    const { eleves } = await readRoster(drive);
    sendJson(res, 200, { eleves });
  } catch (error) {
    const detail = String((error as Error)?.message ?? error).slice(0, 300);
    sendJson(res, 502, { error: 'Échec de la lecture de la liste des élèves.', detail });
  }
}

async function handleRosterAdd(req: IncomingMessage, res: ServerResponse) {
  if (!checkDriveConfig(res)) return;
  let nom: string;
  try {
    const body = JSON.parse(await readBody(req));
    if (typeof body.nom !== 'string' || body.nom.trim().length === 0) {
      sendJson(res, 400, { error: 'Corps attendu : { "nom": "Prénom Nom" }' });
      return;
    }
    nom = sanitizeFileName(body.nom);
  } catch {
    sendJson(res, 400, { error: 'JSON invalide.' });
    return;
  }
  try {
    const drive = getDrive();
    const { rootId, eleves } = await readRoster(drive);
    if (eleves.includes(nom)) {
      sendJson(res, 409, { error: `L'élève « ${nom} » existe déjà.`, eleves });
      return;
    }
    eleves.push(nom);
    eleves.sort((a, b) => a.localeCompare(b, 'fr'));
    await writeRoster(drive, rootId, eleves);
    sendJson(res, 201, { eleves });
  } catch (error) {
    const detail = String((error as Error)?.message ?? error).slice(0, 300);
    sendJson(res, 502, { error: "Échec de l'ajout de l'élève.", detail });
  }
}

async function handleRosterDelete(nomRaw: string, res: ServerResponse) {
  if (!checkDriveConfig(res)) return;
  const nom = sanitizeFileName(nomRaw);
  try {
    const drive = getDrive();
    const { rootId, eleves } = await readRoster(drive);
    if (!eleves.includes(nom)) {
      sendJson(res, 404, { error: `Élève « ${nom} » introuvable.`, eleves });
      return;
    }
    const restants = eleves.filter((e) => e !== nom);
    await writeRoster(drive, rootId, restants);
    sendJson(res, 200, { eleves: restants });
  } catch (error) {
    const detail = String((error as Error)?.message ?? error).slice(0, 300);
    sendJson(res, 502, { error: "Échec de la suppression de l'élève.", detail });
  }
}

async function serveStatic(res: ServerResponse, pathname: string) {
  let path = normalize(decodeURIComponent(pathname));
  if (path === '/' || path === '.') path = '/index.html';
  const filePath = join(publicDir, path);
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'Interdit' });
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': mimeTypes[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Introuvable' });
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/auth/login') {
    handleLogin(res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/auth/callback') {
    void handleCallback(url, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/auth/logout') {
    handleLogout(req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/me') {
    const session = getSession(req);
    if (!session) {
      sendJson(res, 401, { error: 'Non authentifié.' });
      return;
    }
    sendJson(res, 200, { email: session.email });
    return;
  }

  const protegee =
    (req.method === 'POST' && ['/api/chat', '/api/classify', '/api/observations', '/api/eleves'].includes(url.pathname)) ||
    (req.method === 'GET' && url.pathname === '/api/eleves') ||
    (req.method === 'DELETE' && url.pathname.startsWith('/api/eleves/'));
  if (protegee) {
    const session = getSession(req);
    if (!session) {
      sendJson(res, 401, { error: 'Authentification requise : connectez-vous avec Google.' });
      return;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    void handleChat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/classify') {
    void handleClassify(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/observations') {
    void handleObservation(req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/eleves') {
    void handleRosterGet(res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/eleves') {
    void handleRosterAdd(req, res);
    return;
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/eleves/')) {
    void handleRosterDelete(decodeURIComponent(url.pathname.slice('/api/eleves/'.length)), res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/domaines') {
    sendJson(res, 200, { domaines: PMJE_DOMAINES });
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/eleves/')) {
    const rest = url.pathname.slice('/api/eleves/'.length);
    const [nomRaw, sub] = rest.split('/');
    if (sub === 'observations' && nomRaw) {
      void handleStudentObservations(decodeURIComponent(nomRaw), url.searchParams.get('code') ?? '', res);
      return;
    }
    sendJson(res, 404, { error: 'Route inconnue.' });
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/partage' || url.pathname.startsWith('/partage/'))) {
    void serveStatic(res, '/partage.html');
    return;
  }
  if (req.method === 'GET') {
    void serveStatic(res, url.pathname);
    return;
  }
  sendJson(res, 405, { error: 'Méthode non autorisée' });
});

server.listen(port, host, () => {
  console.log(`Serveur démarré sur http://${host}:${port}`);
});
