# Revendo

Revendo prépare des **brouillons d'annonces Vinted** à partir du téléphone :
tu prends les photos, tu tapes le prix, tu choisis le compte… et le PC crée
le brouillon tout seul (catégorie, marque, taille, couleurs, état, titre,
description). **Sans IA** : aucune clé, aucun abonnement, rien n'est envoyé à
un service d'IA. Il ne publie **jamais** à ta place : tu relis et publies
toi-même depuis « Mes brouillons ».

Ce dépôt contient à la fois le **code** (extension Chrome + dashboard
téléphone) et la **base de données** qui les relie.

## Télécharger

| Quoi | Où ça va | Fichier |
| --- | --- | --- |
| Extension (le « robot » du PC) | Chrome / Brave, dans chaque profil | [`dist/revendo-extension-v3.4.0.zip`](dist/revendo-extension-v3.4.0.zip) |
| Dashboard téléphone | Netlify | [`dist/revendo-web-v3.4.0.zip`](dist/revendo-web-v3.4.0.zip) |

Les mêmes fichiers sont aussi dans les dossiers [`extension/`](extension) et [`web/`](web).

### Installer l'extension

1. Dézippe `revendo-extension-v3.4.0.zip`.
2. Ouvre `chrome://extensions` (ou `brave://extensions`) et active **Mode développeur**.
3. **Charger l'extension non empaquetée** → choisis le dossier `revendo-extension-v3.4.0`
   (celui qui contient `manifest.json`).
   Pour mettre à jour une ancienne version : remplace ses fichiers puis clique 🔄
   sur la carte de l'extension (les réglages sont gardés).
4. Recommence dans **chaque profil Chrome** : un profil = un compte Vinted connecté.
5. Dans le dashboard de l'extension → **Réglages** :
   - relais GitHub : `wwhabiboshdz3a7` / `revendo` / `main` + un token GitHub
     « fine-grained » limité à ce dépôt avec **Contents : Read and write** ;
   - **Générer le code de connexion** et colle-le dans les autres profils.

   Rien d'autre à configurer : la lecture des étiquettes est intégrée à
   l'extension (elle marche même hors ligne).

### Mettre le dashboard téléphone sur Netlify

- **Le plus simple** : dézippe `revendo-web-v3.4.0.zip` et glisse le dossier
  `revendo-web-v3.4.0` sur [app.netlify.com/drop](https://app.netlify.com/drop)
  (ou dans l'onglet *Deploys* du site existant pour le mettre à jour).
- **Ou relié à GitHub** : *Add new site → Import from Git* → ce dépôt, branche
  qui contient le code. `netlify.toml` publie le dossier `web/` et ne
  redéploie que quand `web/` change (le relais commite très souvent).

Ensuite, dans l'extension → Réglages → colle l'adresse Netlify → **Afficher
le QR code** et scanne-le avec le téléphone : le dashboard s'ouvre déjà
connecté. Sur iPhone : Partager → « Sur l'écran d'accueil » pour l'avoir
comme une app.

## Comment ça marche

```
 Téléphone (web/)                 GitHub : ce dépôt (branche main)            PC : extension/ dans chaque profil Chrome
 ─────────────────                ────────────────────────────────            ──────────────────────────────────────────
 photos compressées  ──blobs──▶   jobs/<compte>/<id>/01.jpg …                 toutes les 30 s : y a-t-il un job pour
 dès qu'on les choisit            jobs/<compte>/<id>/job.json  ◀──lit──────   MON compte Vinted ?
 « Envoyer » = 1 commit ───────▶                                              réserve le job (status … processing)
                                  status/<id>.json  ◀──────────écrit───────   lit les étiquettes (sans IA)
 suivi en direct  ◀───lit──────   accounts/<login>.json ◀── « en ligne » ──   ouvre vinted.fr/items/new, remplit,
                                                                              « Sauvegarder le brouillon »
                                                                              écrit le résultat, supprime les photos
```

- **Relais GitHub** (`shared/relay.js`) : chaque écriture est un commit
  atomique (blobs → arbre → commit → mise à jour de la branche). Si deux
  appareils écrivent en même temps, GitHub refuse le second et on recommence :
  un job n'est jamais pris par deux PC.
- **Reconnaissance sans IA** (`background/recognize.js`, `offscreen/label-ocr.js`) :
  - **étiquettes** : chaque photo est lue par Tesseract (embarqué, packs de
    langue fra + eng dans l'extension). Les zones de texte (étiquette posée
    sur la maille, texte blanc sur marine, à l'envers, de travers) sont
    repérées, recadrées, agrandies, remises droites et relues de près →
    marque (754 marques connues, tolérance aux erreurs de lecture), taille,
    composition, rayon (« WOMEN », « 10 ans »), ticket de prix (→ « Neuf avec
    étiquette »). Arrêt dès que marque et taille sont lues ;
  - **marque inconnue** : le texte le plus gros de l'étiquette est cherché
    dans le catalogue de marques de Vinted et n'est retenu que s'il y existe
    exactement (jamais de marque inventée) ;
  - **catégorie complète** : Vinted propose des catégories d'après les
    photos ; Revendo choisit la bonne avec le rayon et les indices (taille
    W32 → jean, Converse → baskets, Longchamp → sacs, marques enfants…), et
    cherche lui-même la catégorie si Vinted n'en propose aucune ;
  - **couleurs** : votées sur plusieurs photos de l'article (un pull marine
    dans l'ombre reste marine).
- **Remplissage** (`content/vinted-fill.js`) : photos → titre → description
  → prix → catégorie → marque → taille → état → couleurs → matières → colis,
  puis « Sauvegarder le brouillon ». Le bouton « Ajouter » (publier) n'est
  jamais cliqué, et le compte connecté est revérifié avant d'enregistrer.

## Nouveautés de la v3.4.0

- **Plus d'IA** : Gemini et OpenAI sont retirés, avec la clé et les réglages
  qui allaient avec. Tout se fait sur le PC (lecture des étiquettes) et sur
  Vinted (catégories proposées, catalogue de marques).
- **Lecture des étiquettes bien plus forte** : zones de texte repérées puis
  relues de près (recadrées, agrandies, redressées, même à l'envers ou en
  blanc sur fond sombre). Sur les vraies photos du job elias..djb (étiquette
  floue et à l'envers), la marque n'était pas lue ; elle l'est maintenant.
- **754 marques** (+416) et des indices de catégorie par marque.
- **Catégorie** : recommandations Vinted attendues (elles arrivent parfois
  après l'ouverture du menu) et classées avec le rayon et les indices ;
  recherche automatique si Vinted ne propose rien.
- **Marque** vérifiée dans le catalogue Vinted quand l'étiquette porte une
  marque inconnue ; correction d'un clic qui ne choisissait rien quand la
  recherche ne renvoyait qu'une seule marque.
- **Couleurs** votées sur 3 photos ; **état** « Neuf avec étiquette » si un
  ticket de prix ou un code-barres est lu.
- **Téléphone** : une photo marquée « étiquette » part en haute définition
  (2048 px) pour que le PC lise la marque et la taille.

## Nouveautés de la v3.3.0

- **Envoi depuis le téléphone bien plus rapide** : photos visées à ~300 Ko,
  envoyées en arrière-plan dès qu'on les choisit ; « Envoyer » ne fait plus
  qu'un commit.
- **Photos fiables sur Vinted** : on attend vraiment la fin des envois ;
  repli photo par photo si la zone refuse les lots, sans doublon.
- **Nouveau design** du dashboard téléphone et du dashboard PC (clair/sombre).

## Arborescence

```
extension/          extension Chrome (Manifest V3) — à charger « non empaquetée »
  background/       service worker : robot, reconnaissance, clics « réels » (CDP)
  content/          remplissage du formulaire Vinted
  dashboard/        dashboard plein écran de l'extension
  offscreen/        lecture des étiquettes (Tesseract + repérage des zones de texte)
  lib/tesseract/    moteur OCR et packs de langue fra + eng (embarqués)
  shared/           code commun extension + téléphone (SOURCE DE VÉRITÉ)
web/                dashboard téléphone (site statique Netlify) ; web/shared = copie
tools/              tests, synchro de shared/, fabrication des zips
dist/               zips prêts à installer
accounts/ status/ jobs/   données du relais (écrites par les appareils, ne pas modifier à la main)
```

## Développement

```sh
node --test tools/test/*.test.mjs   # tests (Node 22)
tools/sync-shared.sh                # après une modif de extension/shared/
tools/build-zips.sh                 # refait dist/*.zip
```
