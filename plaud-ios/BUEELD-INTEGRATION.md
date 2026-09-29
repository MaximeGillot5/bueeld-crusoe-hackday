# Compagnon iPhone Plaud pour BUEELD

Ce projet adapte le [starter iOS officiel Plaud](https://github.com/Plaud-AI/plaud-sdk-public) pour le relier au site BUEELD. Le site reste le produit principal ; cette app sert seulement à associer le NotePin S et à synchroniser son enregistrement.

## Préparer Plaud et BUEELD

1. Sur [portal.plaud.ai](https://portal.plaud.ai), créer une **Embedded SDK App**, puis une clé dans **App Settings → API Keys**. Garder le Client Secret et la clé privés. [Guide officiel](https://docs.plaud.ai/plaud-embedded/quickstart)
2. Configurer **le serveur BUEELD** avec le Client ID, le Client Secret et la clé API Plaud, puis démarrer le site en HTTPS. Depuis le site, créer un code de jumelage Plaud pour la session du projet.
3. Aucun identifiant Plaud n'est à inscrire dans l'app iPhone ni dans `PartnerConfig.local.xcconfig`. Le jeton utilisateur arrive via le jumelage BUEELD ; le Client Secret et la clé API restent exclusivement sur le serveur.

## Compiler et installer sur l'iPhone

```sh
cd ios
xcodegen generate
open PlaudTemplateApp.xcodeproj
```

Dans Xcode, choisir une équipe de signature personnelle et un identifiant de bundle unique si nécessaire, brancher l'iPhone, sélectionner l'iPhone comme destination et lancer l'app. Le simulateur ne convient pas au SDK Plaud. Ce projet a été compilé pour iPhone avec Xcode 27 ; la cible iOS du starter a été portée à iOS 15, minimum accepté par ce Xcode. [Guide iOS officiel](https://docs.plaud.ai/plaud-embedded/ios-starter-app)

### Variante de signature Bluetooth uniquement

Si Xcode refuse les capacités **Hotspot Configuration** ou **Wi-Fi Info** pour l'équipe Apple disponible, générer le projet de démo Bluetooth :

```sh
cd ios
python3 generate-ble-only.py
open PlaudTemplateApp.xcodeproj
```

Cette commande retire ces deux droits du **projet Xcode généré**, régénère `Info.plist` sans les permissions Wi-Fi, cache le bouton *Fast Transfer* et bloque le démarrage du transfert Wi-Fi. La synchronisation Bluetooth normale, l'envoi vers Plaud et le pont BUEELD restent prévus. Elle ne modifie pas `project.yml`. Pour restaurer le projet et `Info.plist` complets :

```sh
cd ios
xcodegen generate
```

Le Bluetooth peut être plus lent pour une longue prise de son. Cette variante requiert toujours une équipe de signature valide et un iPhone physique ; elle ne remplace pas ces prérequis. [Apple : droit Hotspot Configuration](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.hotspotconfiguration)

## Démo

1. Ouvrir **BUEELD Capture** sur l'iPhone, saisir l'URL HTTPS du site BUEELD et le code de jumelage affiché par le site. Le code est sensible à la casse.
2. Associer le NotePin S prêté dans l'app temporaire. Ne pas l'associer en parallèle à l'app Plaud grand public.
3. Enregistrer un entretien avec l'accord de la personne, synchroniser le fichier, ouvrir sa fiche et toucher **Send to BUEELD**. L'app transfère l'audio vers le stockage Plaud avec le jeton utilisateur, puis envoie l'URL temporaire du fichier au serveur BUEELD. Le serveur crée la tâche de transcription Plaud, la rattache au projet et récupère ses segments pour le site.
4. Après l'accusé de réception, rafraîchir le site BUEELD pour suivre l'état et consulter la transcription. Si le site redémarre ou refuse le jeton, créer un nouveau code sur le site, toucher **Settings → Re-pair**, puis revenir au fichier et toucher **Send to BUEELD** à nouveau.
5. **Dissocier le NotePin S dans l'app avant de la supprimer ou de rendre l'appareil.** [Consigne officielle](https://docs.plaud.ai/plaud-embedded/ios-starter-app)

## Contrat HTTP avec BUEELD

- `POST /api/plaud/pairings/exchange` avec `{"code":"..."}` retourne `{"userAccessToken":"...","ingestToken":"..."}` (des champs supplémentaires sont acceptés).
- `POST /api/plaud/transcriptions` avec `Authorization: Bearer <ingestToken>` et `{"fileUrl":"<DownloadUrl Plaud>","title":"...","recordedAt":"...","externalId":"..."}`. Le serveur valide l'URL HTTPS temporaire de Plaud, crée la tâche avec sa propre clé API et l'associe au projet BUEELD. Il répond `202` si Plaud traite encore l'audio, éventuellement `201` si le résultat est déjà prêt.

Le jeton utilisateur Plaud et le jeton d'import BUEELD sont stockés dans le Keychain de l'iPhone. L'URL du site et l'état d'envoi local sont stockés dans `UserDefaults`. L'URL temporaire du fichier est envoyée au seul serveur BUEELD ; elle n'est pas conservée dans l'app. Aucune clé API Plaud n'est incluse dans le binaire iPhone.
