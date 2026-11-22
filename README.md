# Chat Mistral (minimal)

App web minimale en TypeScript qui appelle l'API Mistral avec le SDK officiel
[`@mistralai/mistralai`](https://www.npmjs.com/package/@mistralai/mistralai),
avec une interface de chat simple. Le modèle utilisé est `mistral-small-latest`
et la clé `MISTRAL_API_KEY` ne quitte jamais le serveur (elle est lue via
`process.env`, jamais envoyée au navigateur).

## Prérequis

- Node.js 22 ou plus récent (npm inclus)

## Installation

```bash
npm install
```

## Configuration de la clé API

```bash
cp .env.example .env
```

Puis éditez `.env` et remplacez la valeur par votre clé Mistral :

```
MISTRAL_API_KEY=...   # collez votre clé en entier, sans espaces (elle peut commencer par « sk- » ou « mstrl- »)
```

`.env` est ignoré par git (voir `.gitignore`) : ne commitez jamais votre clé.

## Lancer en local (développement)

```bash
npm run dev
```

Ouvrez ensuite http://localhost:3000 dans un navigateur.

## Lancer en production

```bash
npm run build
npm start
```

## Utiliser depuis un téléphone, une tablette ou un Chromebook (même réseau Wi-Fi)

Sur la machine qui exécute le serveur :

```bash
HOST=0.0.0.0 npm run dev
```

Puis, depuis l'autre appareil, ouvrez `http://<adresse-IP-locale-de-la-machine>:3000`
(par ex. `http://192.168.1.25:3000`). N'exposez jamais ce serveur sur Internet sans
authentification.

## Comment ça marche

- `src/server.ts` : serveur HTTP en Node (aucune dépendance web) qui sert les
  fichiers statiques de `public/` et expose les routes API ci-dessous.
- `POST /api/chat` attend un corps JSON `{ "messages": [{ "role": "user",
  "content": "..." }] }` et renvoie `{ "reply": "..." }`. La clé API est lue
  côté serveur et le modèle `mistral-small-latest` est appelé via le SDK officiel.
- `public/` : interface de chat (HTML/CSS/JS vanilla), utilisable sur mobile.

## Classification automatique dans les quatre domaines du PMJE

- `GET /api/domaines` renvoie la liste des quatre domaines d'apprentissage du
  PMJE (Ontario, 2016) : appartenance et contribution, autorégulation et
  bien-être, habiletés en littératie et en mathématiques, résolution de
  problèmes et innovation.
- `POST /api/classify` attend `{ "comment": "...", "imageDataUrl":
  "data:image/...;base64,..." (optionnel) }` et renvoie
  `{ "domaine": "...", "justification": "..." }`.
  Le serveur envoie un *system prompt* qui liste les quatre domaines et exige
  une réponse JSON stricte (`responseFormat: { type: 'json_object' }`,
  `temperature: 0`), avec la photo passée comme contenu image quand elle est
  fournie. La réponse du modèle est ensuite **validée côté serveur** : si le
  domaine renvoyé n'est pas exactement l'un des quatre intitulés, la route
  renvoie une erreur 502 avec la liste des domaines attendus.

Exemple :

```bash
curl -X POST http://localhost:3000/api/classify \
  -H 'content-type: application/json' \
  -d '{"comment": "Léo a construit une tour avec les blocs et a aidé Mia à les ramasser."}'
```

## Enregistrement des observations dans Google Drive (dossier par élève)

### Prérequis Google Cloud

1. Dans la [Google Cloud Console](https://console.cloud.google.com/), créez un projet et activez l'**API Google Drive**.
2. Créez un **compte de service**, puis une **clé JSON** pour ce compte.
3. Dans `.env`, renseignez `GOOGLE_DRIVE_CREDENTIALS` avec le contenu JSON de la clé
   (ou le chemin vers le fichier `.json`).
4. Optionnel : créez un dossier dans votre Google Drive, partagez-le avec l'adresse
   `client_email` du compte de service (en « Lecteur » suffit pour lire, « Éditeur »
   pour écrire), et mettez son ID dans `DRIVE_ROOT_FOLDER_ID`. Si la variable est
   vide, le serveur crée automatiquement un dossier `PMJE - Observations` à la racine
   du Drive du compte de service.

### Route

`POST /api/observations` attend :

```json
{
  "eleve": "Léo Martin",
  "comment": "Léo a construit une tour avec les blocs et a aidé Mia à les ramasser.",
  "imageDataUrl": "data:image/jpeg;base64,..."
}
```

Le serveur :

1. **classe d'abord** l'observation dans un des quatre domaines PMJE (même logique
   que `/api/classify`, photo incluse) ;
2. crée au besoin le dossier `PMJE - Observations/<Nom de l'élève>/` ;
3. y upload la photo ;
4. ajoute l'observation (date, commentaire, domaine, justification, lien vers la
   photo) au fichier `observations.json` du dossier de l'élève.

Réponse `201` :

```json
{
  "id": "...",
  "date": "2025-...",
  "eleve": "Léo Martin",
  "commentaire": "...",
  "domaine": "Appartenance et contribution",
  "justification": "...",
  "photoId": "...",
  "photoName": "...",
  "photoLink": "https://drive.google.com/...",
  "dossierId": "..."
}
```

Exemple :

```bash
curl -X POST http://localhost:3000/api/observations \
  -H 'content-type: application/json' \
  -d '{"eleve":"Léo Martin","comment":"Léo a construit une tour et a aidé Mia.","imageDataUrl":"data:image/jpeg;base64,..."}'
```

Dans l'interface web, le panneau « Nouvelle observation » envoie directement vers
cette route : photo + commentaire + nom de l'élève, puis affiche le domaine retenu
et un lien vers la photo dans Drive.

> Sécurité : les identifiants Google et la clé Mistral restent côté serveur
> (`.env`, ignoré par git). Le navigateur ne reçoit que les métadonnées et le lien
> de visualisation de la photo.

## Partage du compte de l'élève avec les parents

À la première observation d'un élève, le serveur crée dans son dossier Drive un
fichier `partage.json` contenant un **code d'accès à 6 chiffres** (généré avec
`crypto.randomInt`). La réponse `201` de `POST /api/observations` contient
`codePartage` et un `lienPartage` prêt à copier :

```
http://localhost:3000/partage/Léo%20Martin?code=483920
```

- `GET /partage/<nom de l'élève>?code=XXXXXX` sert une **page publique en lecture
  seule** (`public/partage.html`) qui affiche les photos de l'élève groupées par
  domaine PMJE, avec la date, le commentaire et la justification.
- `GET /api/eleves/<nom>/observations?code=XXXXXX` renvoie les mêmes données en
  JSON (`401` si le code est absent ou invalide, `404` si l'élève n'existe pas).
  Chaque observation inclut `photoUrl` (`https://drive.google.com/uc?export=view&id=...`).
- À l'upload, la photo est rendue « **toute personne disposant du lien** » en
  lecture (`drive.permissions.create`, rôle `reader`, type `anyone`) pour que les
  parents puissent la voir sans compte Google. L'ID Drive étant impossible à
  deviner, le lien reste effectively privé ; vous pouvez aussi retirer ce partage
  dans l'interface Drive. Le code à 6 chiffres reste stocké uniquement dans
  `partage.json` côté serveur.

> Pour un déploiement réel, ajoutez une limite de tentatives sur le code et servez
> le tout en HTTPS.

## Authentification de l'enseignante (Google OAuth 2.0)

Toutes les routes d'écriture sont protégées : il faut une session valide.

### Configuration (même projet Google Cloud que le compte de service)

1. Activez l'**API Google People** dans la console Cloud.
2. Créez un **ID client OAuth 2.0** de type « Application web ».
3. Ajoutez l'URI de redirection autorisé : `http://localhost:3000/auth/callback`
   (ou la valeur de `GOOGLE_OAUTH_REDIRECT_URI` en production, en HTTPS).
4. Dans `.env` : `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, et
   `ALLOWED_EMAILS` (liste blanche d'emails séparés par des virgules ; si vide,
   tout compte Google peut se connecter).

### Routes

- `GET /auth/login` → redirige vers la page de consentement Google.
- `GET /auth/callback?code=...` → échange le code, vérifie l'email contre
  `ALLOWED_EMAILS`, crée une session (cookie `session`, HttpOnly, SameSite=Lax,
  valable 12 h, stockée en mémoire : un redémarrage du serveur déconnecte tout
  le monde).
- `GET /auth/logout` → supprime la session.
- `GET /api/me` → `{ "email": "..." }` si connecté, sinon `401`.

### Routes protégées (session requise, `401` sinon)

`POST /api/chat`, `POST /api/classify`, `POST /api/observations`,
`GET /api/eleves`, `POST /api/eleves`, `DELETE /api/eleves/<nom>`.

### Routes publiques

`GET /`, les fichiers statiques, `GET /api/domaines`, `GET /partage/<nom>`,
`GET /api/eleves/<nom>/observations?code=...` (protégée par le code à 6 chiffres).

## Liste des élèves de la classe

La liste est stockée dans `eleves.json` à la racine du dossier Drive
(`PMJE - Observations/eleves.json` par défaut).

- `GET /api/eleves` → `{ "eleves": ["...", "..."] }`
- `POST /api/eleves` avec `{ "nom": "Prénom Nom" }` → `201` (ou `409` si déjà présent)
- `DELETE /api/eleves/<nom>` → `200` (ou `404` si absent)

Dans l'interface, le champ « Élève » est une liste déroulante alimentée par
cette liste, avec un champ pour ajouter un élève.

```bash
curl -X POST http://localhost:3000/api/eleves -b "session=..." \
  -H 'content-type: application/json' -d '{"nom":"Léo Martin"}'
```

## Variables d'environnement

| Variable                   | Défaut      | Rôle                                   |
| -------------------------- | ----------- | -------------------------------------- |
| `MISTRAL_API_KEY`          | — (obligatoire) | Clé API Mistral, lue uniquement côté serveur |
| `GOOGLE_DRIVE_CREDENTIALS` | — (obligatoire pour Drive) | JSON du compte de service Google ou chemin vers la clé `.json` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — (obligatoire pour la connexion) | Identifiants OAuth 2.0 de l'app |
| `GOOGLE_OAUTH_REDIRECT_URI` | `http://localhost:3000/auth/callback` | URI de redirection OAuth enregistrée dans Google Cloud |
| `ALLOWED_EMAILS`           | vide (tous autorisés) | Liste blanche d'emails Google autorisés, séparés par des virgules |
| `DRIVE_ROOT_FOLDER_ID`     | vide        | Dossier Drive racine existant ; si vide, `PMJE - Observations` est créé à la racine |
| `PORT`                     | `3000`      | Port d'écoute                          |
| `HOST`                     | `127.0.0.1` | Interface d'écoute (`0.0.0.0` pour le réseau local) |
