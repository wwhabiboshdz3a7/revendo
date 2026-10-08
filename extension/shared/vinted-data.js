/**
 * Revendo — données Vinted (libellés EXACTS du formulaire « Vends ton article »,
 * relevés en direct). Partagé entre l'extension (PC) et le dashboard mobile.
 */

/** Rayons racines du sélecteur de catégorie Vinted. */
export const RAYONS = [
  'Femmes',
  'Hommes',
  'Enfants',
  'Maison',
  'Électronique',
  'Livres et médias',
  'Loisirs et collections',
  'Sport',
  'Animaux',
];

export const CONDITIONS = [
  { name: 'Neuf avec étiquette', desc: 'Jamais porté, étiquettes' },
  { name: 'Neuf sans étiquette', desc: 'Jamais porté, sans étiquette' },
  { name: 'Très bon état', desc: 'Peu porté, légers défauts' },
  { name: 'Bon état', desc: "Porté, signes d'usure" },
  { name: 'Satisfaisant', desc: 'Très porté, défauts visibles' },
];

/** Pastilles couleur Vinted (2 max). rgb = approximation pour la détection locale. */
export const COLORS = [
  { name: 'Noir', hex: '#000000', rgb: [20, 20, 22] },
  { name: 'Gris', hex: '#919191', rgb: [140, 140, 140] },
  { name: 'Blanc', hex: '#ffffff', rgb: [248, 248, 246] },
  { name: 'Crème', hex: '#f4f1dc', rgb: [240, 232, 210] },
  { name: 'Beige', hex: '#e8d8c3', rgb: [214, 192, 160] },
  { name: 'Abricot', hex: '#ffcc98', rgb: [250, 196, 150] },
  { name: 'Orange', hex: '#ffa500', rgb: [245, 130, 20] },
  { name: 'Corail', hex: '#ff7f50', rgb: [250, 120, 90] },
  { name: 'Rouge', hex: '#cc3300', rgb: [200, 30, 35] },
  { name: 'Bordeaux', hex: '#9c2a3a', rgb: [120, 25, 40] },
  { name: 'Fuchsia', hex: '#ff0080', rgb: [230, 30, 130] },
  { name: 'Rose', hex: '#ffc0cb', rgb: [245, 175, 190] },
  { name: 'Violet', hex: '#800080', rgb: [110, 40, 130] },
  { name: 'Lila', hex: '#d8bfd8', rgb: [195, 165, 210] },
  { name: 'Bleu clair', hex: '#89cff0', rgb: [140, 190, 230] },
  { name: 'Bleu', hex: '#007bc4', rgb: [30, 90, 190] },
  { name: 'Marine', hex: '#1f2c5c', rgb: [30, 38, 75] },
  { name: 'Turquoise', hex: '#40e0d0', rgb: [50, 190, 190] },
  { name: 'Menthe', hex: '#98ff98', rgb: [170, 225, 200] },
  { name: 'Vert', hex: '#369a3d', rgb: [50, 140, 60] },
  { name: 'Vert foncé', hex: '#006400', rgb: [25, 70, 40] },
  { name: 'Kaki', hex: '#86814a', rgb: [115, 110, 70] },
  { name: 'Marron', hex: '#663300', rgb: [100, 65, 40] },
  { name: 'Moutarde', hex: '#e1ad01', rgb: [205, 160, 30] },
  { name: 'Jaune', hex: '#fff200', rgb: [250, 220, 40] },
  { name: 'Argenté', hex: '#c0c0c0', rgb: null },
  { name: 'Doré', hex: '#d4af37', rgb: null },
  { name: 'Multicolore', hex: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)', rgb: null },
];

export const COLOR_NAMES = COLORS.map((c) => c.name);

/** Noms courants (FR/EN) → pastille Vinted. Testés AVANT la correspondance directe. */
export const COLOR_SYNONYMS = [
  [['bleu marine', 'marine', 'navy', 'bleu nuit', 'dark blue'], 'Marine'],
  [['bleu clair', 'bleu ciel', 'ciel', 'light blue', 'sky blue', 'baby blue'], 'Bleu clair'],
  [['vert fonce', 'vert sapin', 'dark green', 'forest green', 'emeraude'], 'Vert foncé'],
  [['kaki', 'khaki', 'olive', 'vert olive', 'vert kaki'], 'Kaki'],
  [['ecru', 'ivoire', 'ivory', 'off white', 'blanc casse', 'cream', 'creme'], 'Crème'],
  [['camel', 'cognac', 'chocolat', 'brown', 'marron', 'brun', 'taupe'], 'Marron'],
  [['bordeaux', 'burgundy', 'lie de vin', 'prune', 'wine'], 'Bordeaux'],
  [['anthracite', 'gris chine', 'grey', 'gray', 'gris'], 'Gris'],
  [['or', 'gold', 'dore'], 'Doré'],
  [['argent', 'silver', 'argente'], 'Argenté'],
  [['multicolor', 'multicolore', 'multi', 'imprime', 'print'], 'Multicolore'],
  [['rose pale', 'pink', 'rose poudre', 'nude'], 'Rose'],
  [['lilas', 'lavande', 'lila'], 'Lila'],
  [['moutarde', 'mustard', 'ocre'], 'Moutarde'],
  [['corail', 'coral', 'saumon'], 'Corail'],
  [['abricot', 'peche', 'peach'], 'Abricot'],
  [['turquoise', 'turquoise', 'teal'], 'Turquoise'],
  [['menthe', 'mint', 'vert d eau'], 'Menthe'],
  [['noir', 'black'], 'Noir'],
  [['blanc', 'white'], 'Blanc'],
  [['beige', 'sable', 'sand'], 'Beige'],
  [['rouge', 'red'], 'Rouge'],
  [['bleu', 'blue', 'bleu roi', 'royal blue', 'denim'], 'Bleu'],
  [['vert', 'green'], 'Vert'],
  [['jaune', 'yellow'], 'Jaune'],
  [['orange'], 'Orange'],
  [['violet', 'purple', 'mauve'], 'Violet'],
  [['fuchsia', 'magenta', 'rose fluo'], 'Fuchsia'],
];

/** Liste « Matériau (recommandé) » de Vinted. */
export const MATERIALS = [
  'Acier', 'Acrylique', 'Alpaga', 'Argent', 'Bambou', 'Bois', 'Cachemire', 'Caoutchouc', 'Carton',
  'Coton', 'Cuir', 'Cuir synthétique', 'Cuir verni', 'Céramique', 'Daim', 'Denim', 'Dentelle', 'Duvet',
  'Fausse fourrure', 'Feutre', 'Flanelle', 'Jute', 'Laine', 'Latex', 'Lin', 'Maille', 'Mohair', 'Mousse',
  'Mousseline', 'Mérinos', 'Métal', 'Nylon', 'Néoprène', 'Or', 'Paille', 'Papier', 'Peluche', 'Pierre',
  'Plastique', 'Polaire', 'Polyester', 'Porcelaine', 'Rotin', 'Satin', 'Sequin', 'Silicone', 'Soie',
  'Toile', 'Tulle', 'Tweed', 'Velours', 'Velours côtelé', 'Verre', 'Viscose', 'Élasthanne',
];

/** Mots d'étiquette de composition (FR/EN/ES/IT/DE) → matériau Vinted. */
export const MATERIAL_SYNONYMS = [
  [['velours cotele', 'corduroy'], 'Velours côtelé'],
  [['cuir synthetique', 'simili cuir', 'similicuir', 'faux leather', 'pu leather'], 'Cuir synthétique'],
  [['cuir verni', 'patent leather'], 'Cuir verni'],
  [['fausse fourrure', 'faux fur'], 'Fausse fourrure'],
  [['coton', 'cotton', 'algodon', 'cotone', 'baumwolle'], 'Coton'],
  [['polyester', 'poliester', 'poliestere'], 'Polyester'],
  [['elasthanne', 'elastane', 'elasthan', 'elastan', 'spandex', 'lycra', 'elastomere'], 'Élasthanne'],
  [['laine', 'wool', 'lana', 'wolle'], 'Laine'],
  [['viscose', 'viscosa', 'rayon'], 'Viscose'],
  [['nylon', 'polyamide', 'polyamid', 'poliamida', 'poliammide'], 'Nylon'],
  [['linen', 'leinen', 'lino'], 'Lin'],
  [['soie', 'silk', 'seda', 'seta', 'seide'], 'Soie'],
  [['cachemire', 'cashmere', 'kaschmir'], 'Cachemire'],
  [['cuir', 'leather', 'piel', 'pelle', 'leder'], 'Cuir'],
  [['acrylique', 'acrylic', 'acrilico', 'acryl'], 'Acrylique'],
  [['mohair'], 'Mohair'],
  [['alpaga', 'alpaca'], 'Alpaga'],
  [['merinos', 'merino'], 'Mérinos'],
  [['denim'], 'Denim'],
  [['velours', 'velvet'], 'Velours'],
  [['daim', 'suede'], 'Daim'],
  [['polaire', 'fleece'], 'Polaire'],
  [['satin'], 'Satin'],
  [['dentelle', 'lace'], 'Dentelle'],
  [['duvet', 'down'], 'Duvet'],
  [['tweed'], 'Tweed'],
  [['tulle'], 'Tulle'],
  [['bambou', 'bamboo'], 'Bambou'],
  [['jute'], 'Jute'],
];

/** Formats de colis (vêtements → Petit/Moyen/Grand, objets → kg). */
export const PACKAGES = {
  Petit: ['Petit', '2 kg', 'Small'],
  Moyen: ['Moyen', '5 kg', 'Medium'],
  Grand: ['Grand', '10 kg', '20 kg', 'Large'],
};

/**
 * Catégories courantes. kw = mot tapé dans « Trouver une catégorie » (libellé
 * Vinted, au pluriel) ; title = mot pour le titre ; match = mots déclencheurs.
 */
export const CATEGORY_DEFS = [
  { kw: 'Pulls', title: 'Pull', match: ['pull', 'tricot', 'col roule', 'sweater', 'jumper'], emoji: '🧶', package: 'Moyen', tags: ['pull', 'pullover', 'maille', 'tricot'] },
  { kw: 'Sweats', title: 'Sweat', match: ['sweat', 'hoodie', 'capuche', 'sweatshirt'], emoji: '🧥', package: 'Moyen', tags: ['sweat', 'hoodie', 'sweatshirt', 'streetwear'] },
  { kw: 'Gilets', title: 'Gilet', match: ['gilet', 'cardigan'], emoji: '🧶', package: 'Petit', tags: ['gilet', 'cardigan', 'maille'] },
  { kw: 'T-shirts', title: 'T-shirt', match: ['t-shirt', 'tshirt', 'tee shirt', 'tee-shirt'], emoji: '👕', package: 'Petit', tags: ['tshirt', 'teeshirt', 'tee', 'basique'] },
  { kw: 'Polos', title: 'Polo', match: ['polo'], emoji: '👕', package: 'Petit', tags: ['polo', 'chic', 'casual'] },
  { kw: 'Débardeurs', title: 'Débardeur', match: ['debardeur', 'caraco'], emoji: '👕', package: 'Petit', tags: ['debardeur', 'top', 'ete'] },
  { kw: 'Tops', title: 'Top', match: ['top ', 'crop top', 'body'], emoji: '👚', package: 'Petit', tags: ['top', 'croptop', 'tendance'] },
  { kw: 'Chemises', title: 'Chemise', match: ['chemise', 'chemisier', 'blouse'], emoji: '👔', package: 'Petit', tags: ['chemise', 'chemisier', 'chic'] },
  { kw: 'Robes', title: 'Robe', match: ['robe'], emoji: '👗', package: 'Petit', tags: ['robe', 'robeete', 'robelongue', 'robecourte'] },
  { kw: 'Jupes', title: 'Jupe', match: ['jupe'], emoji: '👗', package: 'Petit', tags: ['jupe', 'jupelongue', 'jupecourte', 'jupeplissee'] },
  { kw: 'Combinaisons', title: 'Combinaison', match: ['combinaison', 'salopette', 'combishort'], emoji: '👗', package: 'Petit', tags: ['combinaison', 'salopette', 'combishort'] },
  { kw: 'Jeans', title: 'Jean', match: ['jean', 'denim'], emoji: '👖', package: 'Moyen', tags: ['jean', 'jeans', 'denim', 'jeanslim', 'jeanmom'] },
  { kw: 'Pantalons', title: 'Pantalon', match: ['pantalon', 'chino', 'cargo', 'tailleur pantalon'], emoji: '👖', package: 'Petit', tags: ['pantalon', 'chino', 'cargo'] },
  { kw: 'Joggings', title: 'Jogging', match: ['jogging', 'survetement', 'bas de surv', 'jogger'], emoji: '🏃', package: 'Petit', tags: ['jogging', 'survetement', 'sport', 'confort'] },
  { kw: 'Shorts', title: 'Short', match: ['short', 'bermuda'], emoji: '🩳', package: 'Petit', tags: ['short', 'bermuda', 'ete'] },
  { kw: 'Leggings', title: 'Legging', match: ['legging'], emoji: '🏃', package: 'Petit', tags: ['legging', 'sport', 'fitness', 'yoga'] },
  { kw: 'Manteaux', title: 'Manteau', match: ['manteau', 'parka', 'trench', 'caban'], emoji: '🧥', package: 'Grand', tags: ['manteau', 'parka', 'trench', 'hiver'] },
  { kw: 'Doudounes', title: 'Doudoune', match: ['doudoune', 'puffer'], emoji: '🧥', package: 'Moyen', tags: ['doudoune', 'hiver', 'pufferjacket'] },
  { kw: 'Vestes', title: 'Veste', match: ['veste', 'blouson', 'perfecto', 'teddy', 'bomber', 'coupe-vent', 'coupe vent'], emoji: '🧥', package: 'Moyen', tags: ['veste', 'blouson', 'perfecto', 'bomber'] },
  { kw: 'Blazers', title: 'Blazer', match: ['blazer', 'costume', 'tailleur'], emoji: '🤵', package: 'Moyen', tags: ['blazer', 'costume', 'tailleur', 'chic'] },
  { kw: 'Baskets', title: 'Baskets', match: ['basket', 'sneaker', 'tennis', 'air force', 'air max', 'stan smith'], emoji: '👟', shoes: true, package: 'Moyen', tags: ['baskets', 'sneakers', 'sneakerhead', 'chaussures'] },
  { kw: 'Bottes', title: 'Bottes', match: ['botte', 'bottine', 'boots', 'santiag'], emoji: '👢', shoes: true, package: 'Moyen', tags: ['bottes', 'bottines', 'boots', 'chaussures'] },
  { kw: 'Sandales', title: 'Sandales', match: ['sandale', 'claquette', 'tong', 'mule'], emoji: '🩴', shoes: true, package: 'Petit', tags: ['sandales', 'claquettes', 'ete', 'chaussures'] },
  { kw: 'Escarpins', title: 'Escarpins', match: ['escarpin', 'talon'], emoji: '👠', shoes: true, package: 'Moyen', tags: ['escarpins', 'talons', 'chaussures'] },
  { kw: 'Mocassins', title: 'Mocassins', match: ['mocassin', 'derby', 'derbies', 'richelieu'], emoji: '👞', shoes: true, package: 'Moyen', tags: ['mocassins', 'derbies', 'chaussures'] },
  { kw: 'Ballerines', title: 'Ballerines', match: ['ballerine'], emoji: '🥿', shoes: true, package: 'Petit', tags: ['ballerines', 'chaussures'] },
  { kw: 'Sacs à main', title: 'Sac à main', match: ['sac a main', 'sac main', 'cabas'], emoji: '👜', package: 'Moyen', tags: ['sacamain', 'sac', 'maroquinerie'] },
  { kw: 'Sacs à dos', title: 'Sac à dos', match: ['sac a dos', 'backpack'], emoji: '🎒', package: 'Moyen', tags: ['sacados', 'sac', 'backpack'] },
  { kw: 'Sacs bandoulière', title: 'Sac bandoulière', match: ['bandouliere', 'besace', 'pochette', 'banane'], emoji: '👜', package: 'Petit', tags: ['sacbandouliere', 'pochette', 'besace'] },
  { kw: 'Ceintures', title: 'Ceinture', match: ['ceinture'], emoji: '🪢', package: 'Petit', tags: ['ceinture', 'accessoire'] },
  { kw: 'Casquettes', title: 'Casquette', match: ['casquette', 'bob '], emoji: '🧢', package: 'Petit', tags: ['casquette', 'bob', 'accessoire'] },
  { kw: 'Bonnets', title: 'Bonnet', match: ['bonnet'], emoji: '🧢', package: 'Petit', tags: ['bonnet', 'hiver', 'accessoire'] },
  { kw: 'Écharpes', title: 'Écharpe', match: ['echarpe', 'foulard', 'snood'], emoji: '🧣', package: 'Petit', tags: ['echarpe', 'foulard', 'accessoire'] },
  { kw: 'Montres', title: 'Montre', match: ['montre'], emoji: '⌚', package: 'Petit', tags: ['montre', 'watch', 'accessoire'] },
  { kw: 'Lunettes de soleil', title: 'Lunettes de soleil', match: ['lunette'], emoji: '🕶️', package: 'Petit', tags: ['lunettesdesoleil', 'sunglasses', 'accessoire'] },
  { kw: 'Bijoux', title: 'Bijou', match: ['bijou', 'collier', 'bague', 'bracelet', 'boucles d oreilles', 'boucles'], emoji: '💍', package: 'Petit', tags: ['bijoux', 'collier', 'bracelet', 'bague'] },
  { kw: 'Maillots de bain', title: 'Maillot de bain', match: ['maillot de bain', 'bikini'], emoji: '👙', package: 'Petit', tags: ['maillotdebain', 'bikini', 'plage', 'ete'] },
  { kw: 'Pyjamas', title: 'Pyjama', match: ['pyjama', 'nuisette'], emoji: '🛌', package: 'Petit', tags: ['pyjama', 'nuisette', 'homewear'] },
  { kw: 'Soutiens-gorge', title: 'Soutien-gorge', match: ['soutien gorge', 'soutien-gorge', 'brassiere'], emoji: '👙', package: 'Petit', tags: ['lingerie', 'soutiengorge'] },
  { kw: 'Bodies', title: 'Body bébé', match: ['body bebe', 'grenouillere'], emoji: '🍼', package: 'Petit', tags: ['bebe', 'body', 'naissance'] },
  { kw: 'Jouets', title: 'Jouet', match: ['jouet', 'peluche', 'lego', 'playmobil', 'poupee'], emoji: '🧸', package: 'Moyen', tags: ['jouet', 'enfant', 'jeu'] },
  { kw: 'Jeux vidéo', title: 'Jeu vidéo', match: ['jeu video', 'ps4', 'ps5', 'switch', 'xbox'], emoji: '🎮', package: 'Petit', tags: ['jeuvideo', 'gaming', 'console'] },
  { kw: 'Livres', title: 'Livre', match: ['livre', 'roman', 'bd ', 'manga'], emoji: '📚', package: 'Petit', tags: ['livre', 'lecture', 'roman'] },
  { kw: 'Décoration', title: 'Décoration', match: ['deco', 'vase', 'cadre', 'bougie'], emoji: '🏠', package: 'Moyen', tags: ['deco', 'maison', 'interieur'] },
];

/** Marques fréquentes (détection par OCR des étiquettes en mode gratuit). */
export const BRANDS = [
  'Nike', 'Adidas', 'Zara', 'H&M', 'Shein', 'Mango', 'Bershka', 'Pull&Bear', 'Stradivarius', 'Kiabi',
  'Jennyfer', 'Promod', 'Camaïeu', 'Naf Naf', "Levi's", 'Lacoste', 'Ralph Lauren', 'Polo Ralph Lauren',
  'Tommy Hilfiger', 'Calvin Klein', 'Guess', 'The North Face', 'Puma', 'New Balance', 'Converse', 'Vans',
  'Asics', 'Reebok', 'Jordan', 'Champion', 'Carhartt', 'Dickies', 'Stone Island', 'Moncler', 'Gucci',
  'Louis Vuitton', 'Chanel', 'Dior', 'Prada', 'Balenciaga', 'Saint Laurent', 'Yves Saint Laurent',
  'Michael Kors', 'Longchamp', 'Sandro', 'Maje', 'Claudie Pierlot', 'The Kooples', 'Ba&sh', 'Sézane',
  'Rouje', 'Petit Bateau', 'Jacadi', 'Okaïdi', 'Vertbaudet', 'DPAM', "Tape à l'œil", 'Cyrillus',
  'Bonpoint', 'Zadig & Voltaire', 'Comptoir des Cotonniers', 'Uniqlo', 'Primark', 'Asos', 'Boohoo',
  'PrettyLittleThing', 'Monki', 'Weekday', 'COS', 'Arket', '& Other Stories', 'Massimo Dutti', 'Celio',
  'Jules', 'Brice', 'Kaporal', 'Le Temps des Cerises', 'Teddy Smith', 'Superdry', 'Jack & Jones', 'Only',
  'Vero Moda', 'Pieces', 'Vila', 'Object', 'Selected', 'Esprit', 'S.Oliver', 'Tom Tailor', 'Gap',
  'Abercrombie & Fitch', 'Hollister', 'American Eagle', 'Urban Outfitters', 'Brandy Melville', 'Lululemon',
  'Gymshark', 'Under Armour', 'Decathlon', 'Quechua', 'Kalenji', 'Domyos', 'Salomon', 'Columbia',
  'Patagonia', 'Napapijri', 'Timberland', 'Dr. Martens', 'UGG', 'Birkenstock', 'Clarks', 'Geox', 'Kickers',
  'Minelli', 'San Marina', 'Eram', 'Bocage', 'Jonak', 'Veja', 'Le Coq Sportif', 'Fila', 'Kappa', 'Ellesse',
  'Umbro', 'Sergio Tacchini', 'Lyle & Scott', 'Fred Perry', 'Burberry', 'Hugo Boss', 'Boss', 'Armani',
  'Emporio Armani', 'Armani Exchange', 'Versace', 'Dolce & Gabbana', 'Fendi', 'Valentino', 'Givenchy',
  'Hermès', 'Celine', 'Chloé', 'Kenzo', 'Lanvin', 'Isabel Marant', 'A.P.C.', 'Ami Paris', 'Jacquemus',
  'Off-White', 'Palm Angels', 'Supreme', 'Stüssy', 'Palace', 'Corteiz', 'Trapstar', 'Represent',
  'Fear of God', 'Essentials', 'Desigual', 'Diesel', 'G-Star Raw', 'Pepe Jeans', 'Wrangler', 'Lee',
  'Replay', 'Scotch & Soda', 'Barbour', 'Bensimon', 'Repetto', 'Swarovski', 'Pandora', 'Fossil', 'Casio',
  'Daniel Wellington', 'Ray-Ban', 'Oakley', 'Eastpak', 'Herschel', 'Fjällräven', 'Kipling', 'Lancel',
  'Le Tanneur', 'Furla', 'Coach', 'Kate Spade', 'Marc Jacobs', 'Tory Burch', 'Polène', 'Sessùn',
  'Des Petits Hauts', 'Grain de Malice', 'Cache Cache', 'Bonobo', 'Pimkie', 'Morgan', 'Etam', 'Undiz',
  'Darjeeling', 'Calzedonia', 'Intimissimi', 'Tezenis', "Victoria's Secret", 'C&A', 'Gemo', 'La Halle',
  'IKKS', 'Sergent Major', 'Catimini', 'Absorba', 'Orchestra', 'Benetton', 'United Colors of Benetton',
  'Disney', 'Lego', 'Playmobil', 'Fisher-Price', 'Vtech', 'Apple', 'Samsung', 'Sony', 'Nintendo',
  'Salsa', 'Jott', 'Schott', 'Redskins', 'Ünkut', 'Sinsay', 'Reserved', 'New Look', 'River Island',
  'Topshop', 'Mister K', 'Jacquemus', 'Golden Goose', 'Alexander McQueen', 'Miu Miu', 'Bottega Veneta',
];

export const RAYON_TAGS = {
  Femmes: ['femme', 'modefemme', 'dressingfemme'],
  Hommes: ['homme', 'modehomme', 'dressinghomme'],
  Enfants: ['enfant', 'modeenfant', 'vetementsenfant'],
  Sport: ['sport', 'sportswear'],
  Maison: ['maison', 'deco'],
};

export const GENERIC_HASHTAGS = [
  'vinted', 'vintedfrance', 'secondemain', 'videdressing', 'viedressing', 'dressing', 'mode', 'fashion',
  'style', 'look', 'outfit', 'ootd', 'tendance', 'friperie', 'frip', 'vintage', 'occasion', 'bonneaffaire',
  'bonplan', 'petitprix', 'shopping', 'shoppingenligne', 'modedurable', 'ecoresponsable', 'slowfashion',
  'achatresponsable', 'consommationresponsable', 'upcycling', 'zerodechet', 'secondevie', 'tridressing',
  'declutter', 'envoirapide', 'envoisoigne', 'colisrapide', 'qualite', 'authentique', 'original',
  'pieceunique', 'coupdecoeur', 'cadeau', 'ideecadeau', 'preloved', 'thrift', 'thriftfind',
  'sustainablefashion', 'secondhand', 'wardrobe', 'closet', 'streetstyle', 'instamode', 'modeaddict',
  'fashionaddict', 'modefrancaise', 'stylefrancais', 'bonsplans', 'promo', 'soldes', 'dealdujour',
  'aprixmini', 'commeneuf', 'rentree', 'printemps', 'automne', 'hiver', 'ete', 'basique', 'indispensable',
  'garderobe', 'capsulewardrobe', 'minimalisme', 'lookdujour', 'tenue', 'dressingdeseconde', 'pepite',
];
