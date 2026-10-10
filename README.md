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
| Extension (le « robot » du PC) | Chrome / Brave, dans chaque profil | [`dist/revendo-extension-v3.5.0.zip`](dist/revendo-extension-v3.5.0.zip) |
| Dashboard téléphone | Netlify | [`dist/revendo-web-v3.5.0.zip`](dist/revendo-web-v3.5.0.zip) |

Les mêmes fichiers sont aussi dans les dossiers [`extension/`](extension) et [`web/`](web).

### Installer l'extension

1. Dézippe `revendo-extension-v3.5.0.zip` (Windows : clic droit → « Extraire tout… »).
   Le dossier `revendo-extension-v3.5.0` obtenu contient directement `manifest.json`.
2. Ouvre `chrome://extensions` (ou `brave://extensions`) et active **Mode développeur**.
3. **Charger l'extension non empaquetée** → choisis le dossier `revendo-extension-v3.5.0`
   (celui qui contient `manifest.json`). « Fichier manifeste manquant » = mauvais
   dossier : si tu as téléchargé tout le dépôt, choisis son sous-dossier `extension/`.
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

- **Le plus simple** : dézippe `revendo-web-v3.5.0.zip` et glisse le dossier
  `revendo-web-v3.5.0` (qui contient directement `index.html`) sur [app.netlify.com/drop](https://app.netlify.com/drop)
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
  vérification de tous les champs, puis « Sauvegarder le brouillon ». Le
  bouton « Ajouter » (publier) n'est jamais cliqué, et le compte connecté est
  revérifié avant d'enregistrer.
- **Un seul profil à la fois** : `locks/robot.json` dans le relais. Le verrou
  est pris dans le même commit que la réservation du job, rendu dans le commit
  de fin, et expire seul après 15 min (PC éteint en plein travail).
- **Nouvels essais** : page Vinted rechargée (2 fois au plus) quand elle est en
  panne ; annonce ratée pour une raison passagère → statut `retry`, reprise
  automatique 3 min plus tard (2 essais au total).

## Nouveautés de la v3.5.0

Cause des échecs du 10/10 : plusieurs profils Chrome remplissaient Vinted en
même temps sur le même PC (focus volé, processeur saturé par la lecture des
étiquettes) → formulaire Vinted pas chargé, photos refusées, menu catégorie
qui ne s'ouvre pas. Toutes les annonces ratées ce jour-là l'ont été pendant un
chevauchement.

- **Un seul profil remplit Vinted à la fois** (verrou dans le relais) ; les
  autres affichent « En attente de son tour » et prennent la suite.
- **Nouvel essai automatique** d'une annonce ratée (3 min plus tard, page
  neuve), affiché « Nouvel essai prévu » sur le téléphone et le PC ; pas de
  nouvel essai si le compte est déconnecté ou l'onglet fermé à la main.
- **Page Vinted rechargée** si le formulaire n'apparaît pas, si des photos sont
  refusées ou si le menu catégorie ne s'ouvre pas ; **captcha** : 3 min
  d'attente puis rechargement.
- **Focus émulé** : une fenêtre ouverte par-dessus ne referme plus les menus.
- **Catégorie** : jusqu'à 35 s d'attente des recommandations Vinted, menu
  rouvert s'il se referme.
- **Chaque champ retenté** s'il rate, et **tout revérifié avant
  d'enregistrer** (champs effacés par Vinted remplis de nouveau).
- **Tailles bilingues** des étiquettes (L/G, S/P, XL TG/XG, 2X).
- **À mettre à jour partout** : l'extension dans CHAQUE profil Chrome (un profil
  resté en 3.4.0 ignore le verrou ; le téléphone et le dashboard le signalent
  « extension à mettre à jour ») et le site Netlify du téléphone.
- Banc d'essai à pannes injectées : 17 scénarios (16 pannes + le cas nominal) × 3 répétitions par
  version — 3.3.0 : 24 %, 3.4.0 : 41 %, **3.5.0 : 100 %** d'annonces complètes. Détail, chronologie
  du 10/10 et graphiques 3D : [rapport de fiabilité (PDF)](docs/Revendo-rapport-fiabilite-v3.5.0.pdf).

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
- **Zips** : fichiers à la racine. Avant, « Extraire tout » de Windows créait
  deux dossiers l'un dans l'autre et Chrome ne trouvait pas le manifeste.

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
