import { create } from "zustand";

/**
 * Display language (VS Code's "Configure Display Language"): the workbench's
 * own words — menus, the activity bar, panel tabs, Settings — by their English
 * text. English is the source; a missing translation shows English.
 * French is complete for those parts; Kinyarwanda waits for a translator
 * (machine-made Kinyarwanda would mislead students), so it isn't offered yet.
 */

export type Locale = "en" | "fr";

export const LOCALES: { id: Locale; label: string; native: string }[] = [
  { id: "en", label: "English", native: "English" },
  { id: "fr", label: "French", native: "Français" },
];

const FR: Record<string, string> = {
  // ── menus ──
  TMCode: "TMCode",
  File: "Fichier",
  Edit: "Modifier",
  Selection: "Sélection",
  View: "Affichage",
  Go: "Atteindre",
  Run: "Exécuter",
  Terminal: "Terminal",
  Window: "Fenêtre",
  Help: "Aide",
  About: "À propos",
  "Activity Bar": "Barre d'activité",
  "Add Configuration...": "Ajouter une configuration...",
  "Add Cursor Above": "Ajouter un curseur au-dessus",
  "Add Cursor Below": "Ajouter un curseur en dessous",
  "Add Next Occurrence": "Ajouter l'occurrence suivante",
  "Auto Save": "Enregistrement automatique",
  Back: "Précédent",
  Breadcrumbs: "Barre de navigation",
  "Centered Layout": "Disposition centrée",
  "Check My Computer": "Vérifier mon ordinateur",
  "Check for Updates...": "Rechercher des mises à jour...",
  "Close Editor": "Fermer l'éditeur",
  "Close Folder": "Fermer le dossier",
  "Close Window": "Fermer la fenêtre",
  "Color Theme": "Thème de couleur",
  "Command Palette...": "Palette de commandes...",
  "Conditional Breakpoint...": "Point d'arrêt conditionnel...",
  "Configure Tasks...": "Configurer les tâches...",
  "Copy Line Down": "Copier la ligne en dessous",
  "Copy Line Up": "Copier la ligne au-dessus",
  "Editor Font Bigger": "Agrandir la police de l'éditeur",
  "Editor Font Smaller": "Réduire la police de l'éditeur",
  "Expand Selection": "Étendre la sélection",
  Explorer: "Explorateur",
  Find: "Rechercher",
  "Find in Files": "Rechercher dans les fichiers",
  "Find in Terminal": "Rechercher dans le terminal",
  "First Editor Group": "Premier groupe d'éditeurs",
  "Format Document": "Mettre en forme le document",
  Forward: "Suivant",
  "Full Screen": "Plein écran",
  "Go to Definition": "Atteindre la définition",
  "Go to File...": "Atteindre le fichier...",
  "Go to Line/Column...": "Atteindre la ligne/colonne...",
  "Go to Symbol in Editor...": "Atteindre le symbole dans l'éditeur...",
  "Go to Symbol in Workspace...": "Atteindre le symbole dans l'espace de travail...",
  Home: "Accueil",
  "Install Update and Restart": "Installer la mise à jour et redémarrer",
  "Keyboard Shortcuts": "Raccourcis clavier",
  "Logpoint...": "Point de journalisation...",
  Minimap: "Minimap",
  "Move Line Down": "Déplacer la ligne vers le bas",
  "Move Line Up": "Déplacer la ligne vers le haut",
  "Move Primary Side Bar": "Déplacer la barre latérale principale",
  "New File...": "Nouveau fichier...",
  "New Folder...": "Nouveau dossier...",
  "New Project from Starter...": "Nouveau projet à partir d'un projet de départ...",
  "New Terminal": "Nouveau terminal",
  "New Text File": "Nouveau fichier texte",
  "New Window": "Nouvelle fenêtre",
  "Next Change": "Modification suivante",
  "Next Editor": "Éditeur suivant",
  "Next Problem": "Problème suivant",
  "Open File...": "Ouvrir un fichier...",
  "Open Folder...": "Ouvrir un dossier...",
  "Open Recent...": "Ouvrir les éléments récents...",
  Output: "Sortie",
  "Previous Change": "Modification précédente",
  "Previous Editor": "Éditeur précédent",
  "Previous Problem": "Problème précédent",
  Problems: "Problèmes",
  "Quit TMCode": "Quitter TMCode",
  Redo: "Rétablir",
  "Remove All Breakpoints": "Supprimer tous les points d'arrêt",
  "Render Whitespace": "Afficher les espaces",
  "Reopen Closed Editor": "Rouvrir l'éditeur fermé",
  Replace: "Remplacer",
  "Reset Zoom": "Réinitialiser le zoom",
  Restart: "Redémarrer",
  "Revert File": "Rétablir le fichier",
  "Run Build Task...": "Exécuter la tâche de génération...",
  "Run Project": "Exécuter le projet",
  "Run Recent Command...": "Exécuter une commande récente...",
  "Run Selected Text": "Exécuter le texte sélectionné",
  "Run Task...": "Exécuter la tâche...",
  "Run Test Task...": "Exécuter la tâche de test...",
  "Run Tests": "Exécuter les tests",
  "Run Without Debugging": "Exécuter sans débogage",
  Save: "Enregistrer",
  "Save All": "Tout enregistrer",
  "Save As...": "Enregistrer sous...",
  Search: "Rechercher",
  "Second Editor Group": "Deuxième groupe d'éditeurs",
  "Select All": "Tout sélectionner",
  "Select All Occurrences": "Sélectionner toutes les occurrences",
  Settings: "Paramètres",
  "Settings...": "Paramètres...",
  "Show All Commands": "Afficher toutes les commandes",
  "Shrink Selection": "Réduire la sélection",
  "Simple Browser: Show": "Navigateur simple : afficher",
  "Split Editor": "Fractionner l'éditeur",
  "Start Debugging": "Démarrer le débogage",
  "Status Bar": "Barre d'état",
  "Sticky Scroll": "Défilement fixe",
  Stop: "Arrêter",
  "Switch Editor...": "Changer d'éditeur...",
  "Third Editor Group": "Troisième groupe d'éditeurs",
  "Toggle Breakpoint": "Basculer le point d'arrêt",
  "Toggle Developer Tools": "Basculer les outils de développement",
  "Toggle Line Comment": "Basculer le commentaire de ligne",
  "Toggle Panel": "Basculer le panneau",
  "Toggle Primary Side Bar Visibility": "Basculer la visibilité de la barre latérale principale",
  "Toggle Terminal": "Basculer le terminal",
  Undo: "Annuler",
  "Word Wrap": "Retour automatique à la ligne",
  "Zen Mode": "Mode Zen",
  "Zoom In": "Zoom avant",
  "Zoom Out": "Zoom arrière",
  // ── activity bar and panel ──
  Task: "Tâche",
  "Source Control": "Contrôle de code source",
  "Run and Debug": "Exécuter et déboguer",
  Testing: "Tests",
  "Task Mentor Projects": "Projets Task Mentor",
  Assignments: "Devoirs",
  Grading: "Notation",
  Extensions: "Extensions",
  Activity: "Activité",
  "Debug Console": "Console de débogage",
  "JavaScript Console": "Console JavaScript",
  // ── Settings ──
  Accessibility: "Accessibilité",
  Appearance: "Apparence",
  Application: "Application",
  "Files and Search": "Fichiers et recherche",
  Files: "Fichiers",
  Projects: "Projets",
  "Text Editor": "Éditeur de texte",
  "Search settings": "Rechercher dans les paramètres",
  User: "Utilisateur",
  Workspace: "Espace de travail",
  Modified: "Modifié",
  Reset: "Réinitialiser",
  "Font Size": "Taille de police",
  "Font Family": "Famille de polices",
  "Tab Size": "Taille de tabulation",
  "Line Height": "Hauteur de ligne",
  "Display Language": "Langue d'affichage",
  "File Icon Theme": "Thème d'icônes de fichiers",
  "Hot Exit": "Sortie à chaud",
  "Shell Integration": "Intégration du shell",
  "Coloured Prompt": "Invite colorée",
  "GPU Acceleration": "Accélération GPU",
  "Minimum Contrast Ratio": "Rapport de contraste minimal",
  "Default Profile": "Profil par défaut",
  "Panel: Position": "Panneau : position",
  // ── common buttons ──
  Cancel: "Annuler",
  "Don't Save": "Ne pas enregistrer",
  OK: "OK",
  Close: "Fermer",
  Open: "Ouvrir",
  "Reload Window": "Recharger la fenêtre",
  "Report a Problem...": "Signaler un problème...",
};

const DICTIONARIES: Record<Locale, Record<string, string>> = { en: {}, fr: FR };

export const useLocale = create<{ locale: Locale }>(() => ({ locale: "en" }));

export function setLocale(locale: string) {
  useLocale.setState({ locale: locale === "fr" ? "fr" : "en" });
  document.documentElement.lang = useLocale.getState().locale;
}

/** The English text in the display language (English when there's no translation). */
export function tr(english: string, locale: Locale = useLocale.getState().locale): string {
  return DICTIONARIES[locale][english] ?? english;
}

/** In React: re-renders when the language changes. */
export function useTr() {
  const locale = useLocale((s) => s.locale);
  return (english: string) => tr(english, locale);
}

/** For tests: how much of the English list a language covers. */
export function coverage(locale: Locale, english: string[]): number {
  if (locale === "en") return 1;
  const dict = DICTIONARIES[locale];
  return english.filter((e) => e in dict).length / Math.max(1, english.length);
}
