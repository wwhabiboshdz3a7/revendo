# Revendo

Revendo prépare des **brouillons d'annonces Vinted** à partir du téléphone :
tu prends les photos, tu tapes le prix, tu choisis le compte… et le PC crée
le brouillon tout seul (catégorie, marque, taille, couleurs, état, titre,
description). Il ne publie **jamais** à ta place : tu relis et publies
toi-même depuis « Mes brouillons ».

Ce dépôt contient à la fois le **code** (extension Chrome + dashboard
téléphone) et la **base de données** qui les relie.

## Télécharger

| Quoi | Où ça va | Fichier |
| --- | --- | --- |
| Extension (le « robot » du PC) | Chrome / Brave, dans chaque profil | [`dist/revendo-extension-v3.3.0.zip`](dist/revendo-extension-v3.3.0.zip) |
| Dashboard téléphone | Netlify | [`dist/revendo-web-v3.3.0.zip`](dist/revendo-web-v3.3.0.zip) |

Les mêmes fichiers sont aussi dans les dossiers [`extension/`](extension) et [`web/`](web).

### Installer l'extension

1. Dézippe `revendo-extension-v3.3.0.zip`.
2. Ouvre `chrome://extensions` (ou `brave://extensions`) et active **Mode développeur**.
3. **Charger l'extension non empaquetée** → choisis le dossier `revendo-extension-v3.3.0`
   (celui qui contient `manifest.json`).
   Pour mettre à jour une ancienne version : remplace ses fichiers puis clique 🔄
   sur la carte de l'extension (les réglages sont gardés).
4. Recommence dans **chaque profil Chrome** : un profil = un compte Vinted connecté.
5. Dans le dashboard de l'extension → **Réglages** :
   - relais GitHub : `wwhabiboshdz3a7` / `revendo` / `main` + un token GitHub
     « fine-grained » limité à ce dépôt avec **Contents : Read and write** ;
   - **IA** : colle une clé Gemini gratuite ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)).
     Sans clé, le mode gratuit (couleur + lecture des étiquettes) reconnaît
     beaucoup moins bien la marque et la catégorie ;
   - **Générer le code de connexion** et colle-le dans les autres profils.

### Mettre le dashboard téléphone sur Netlify

- **Le plus simple** : dézippe `revendo-web-v3.3.0.zip` et glisse le dossier
  `revendo-web-v3.3.0` sur [app.netlify.com/drop](https://app.netlify.com/drop)
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
                                  status/<id>.json  ◀──────────écrit───────   reconnaît l'article (IA ou OCR)
 suivi en direct  ◀───lit──────   accounts/<login>.json ◀── « en ligne » ──   ouvre vinted.fr/items/new, remplit,
                                                                              « Sauvegarder le brouillon »
                                                                              écrit le résultat, supprime les photos
```

- **Relais GitHub** (`shared/relay.js`) : chaque écriture est un commit
  atomique (blobs → arbre → commit → mise à jour de la branche). Si deux
  appareils écrivent en même temps, GitHub refuse le second et on recommence :
  un job n'est jamais pris par deux PC.
- **Reconnaissance** (`shared/ai.js`, `background/recognize.js`) : l'IA lit
  d'abord les étiquettes (texte transcrit), puis remplit la fiche avec les
  valeurs exactes de Vinted. Si la marque ou la taille manque, une seconde
  passe envoie seulement les photos d'étiquette en haute définition. Le mode
  gratuit (OCR Tesseract + couleur dominante) complète ce que l'IA n'a pas
  trouvé.
- **Remplissage** (`content/vinted-fill.js`) : photos → titre → description
  → prix → catégorie → marque → taille → état → couleurs → matières → colis,
  puis « Sauvegarder le brouillon ». Le bouton « Ajouter » (publier) n'est
  jamais cliqué, et le compte connecté est revérifié avant d'enregistrer.

## Nouveautés de la v3.3.0

- **Envoi depuis le téléphone bien plus rapide** : Safari encodait les photos
  à ~95 % (~900 Ko chacune). Elles sont maintenant visées à ~300 Ko et
  partent **en arrière-plan dès qu'on les choisit** ; « Envoyer » ne fait plus
  qu'un commit.
- **Photos fiables sur Vinted** : on attend vraiment la fin des envois
  (avant : 20 s fixes, d'où « Photos 0/7 » ; sans photos, Vinted ne propose
  aucune catégorie et tout le reste échouait). Repli photo par photo si la
  zone refuse les lots, sans doublon.
- **Lecture des étiquettes réparée** : l'OCR du mode gratuit ne démarrait
  jamais (bloqué par la sécurité des extensions Chrome).
- **IA plus juste** : lecture d'étiquette d'abord, règles de catégorie, marque
  ramenée à l'orthographe Vinted (+119 marques), seconde passe HD, raison
  affichée quand l'IA n'a pas pu être utilisée (quota, clé…).
- **Nouveau design** du dashboard téléphone et du dashboard PC (clair/sombre).

## Arborescence

```
extension/          extension Chrome (Manifest V3) — à charger « non empaquetée »
  background/       service worker : robot, reconnaissance, clics « réels » (CDP)
  content/          remplissage du formulaire Vinted
  dashboard/        dashboard plein écran de l'extension
  offscreen/        OCR Tesseract (lecture des étiquettes)
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
