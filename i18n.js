// Per-server language for the bot's Discord-facing messages. A server admin
// picks English, German, or French from the dashboard's Server tab (stored
// as guildConfig.language); every message built through t() below then comes
// out in that language automatically, with no other code changes needed.
//
// Scope: this covers the messages regular server members actually see and
// interact with — the ticket system, the verification gate, giveaways, and
// the counting game. It does NOT (yet) cover the ~100 staff chat commands or
// the admin dashboard UI itself, both much larger jobs on their own; this is
// a deliberate first slice, not an oversight. Adding a language: extend
// LANGS and add a matching key set to DICTS — t() falls back to English for
// any key missing in a language, so a partial translation never breaks.
const guildConfig = require('./guildConfig');

const LANGS = ['en', 'de', 'fr'];

const DICTS = {
  en: {
    'ticket.panelGone': '🚫 This ticket panel is no longer configured — ask staff to re-post it.',
    'ticket.maxOpen': '🚫 You already have {count} open ticket(s) here (max {max}). Close one first.',
    'ticket.createFailed': '❌ Could not create ticket channel: {error}',
    'ticket.created': '✅ Ticket created: {channel}',
    'ticket.embedTitle': '🎫 Ticket #{number} — {panel}',
    'ticket.footerOpenedBy': 'Opened by {tag}',
    'ticket.closedTitle': '🔒 Ticket #{number} closed',
    'ticket.closedDesc': 'Closed by **{by}**. The original opener ({user}) can no longer see this channel.',
    'ticket.reopenedTitle': '🔓 Ticket #{number} reopened',
    'ticket.reopenedDesc': '{userMention} can see this ticket again.',
    'ticket.notOpen': 'This is not an open ticket.',
    'ticket.notClosed': 'This is not a closed ticket.',
    'ticket.noRecord': 'No ticket record for this channel.',
    'ticket.confirmClose': '⚠️ Close this ticket?',
    'ticket.confirmDelete': '⚠️ Permanently delete this ticket channel? This cannot be undone.',
    'ticket.transcriptTitle': '📄 Transcript for ticket **#{number}**',
    'ticket.error': '❌ {message}',
    'ticket.btnClose': 'Close',
    'ticket.btnConfirmClose': 'Confirm Close',
    'ticket.btnCancel': 'Cancel',
    'ticket.btnReopen': 'Reopen',
    'ticket.btnTranscript': 'Transcript',
    'ticket.btnDelete': 'Delete',
    'ticket.btnPermanentlyDelete': 'Permanently Delete',

    'verify.notConfigured': 'Verification is not fully configured on this server yet — ask an admin to set the Member Role in the dashboard.',
    'verify.success': '✅ Verified! Welcome.',
    'verify.failed': 'Could not verify you: {error}',
    'verify.embedTitle': '✅ Verify to get access',
    'verify.embedDesc': 'Click the button below to verify and unlock the rest of the server.',
    'verify.button': 'Verify',

    'giveaway.winners': 'Winner{plural}: {list}',
    'giveaway.noWinners': 'No valid entries — no winner could be picked.',
    'giveaway.active': 'React with 🎉 to enter!\nWinners: **{count}**\nEnds: {endsAt}',
    'giveaway.congrats': '🎉 Congratulations {list}! You won **{prize}**!',
    'giveaway.noEntries': '😔 No one entered the giveaway for **{prize}**.',

    'counting.doubleUp': "❌ {user}, you can't count twice in a row! Back to **1**.",
    'counting.wrongNumber': '❌ {user} broke the count! Expected **{expected}**, but got **{got}**. Back to **1**.',

    'command.unknownWithSuggestion': '❓ Unknown command `{prefix}{cmd}` — did you mean `{prefix}{suggestion}`?',
    'command.unknownNoSuggestion': '❓ Unknown command `{prefix}{cmd}`. Try `{prefix}help` to see all commands.',
  },

  de: {
    'ticket.panelGone': '🚫 Dieses Ticket-Panel ist nicht mehr konfiguriert — bitte das Team, es neu zu posten.',
    'ticket.maxOpen': '🚫 Du hast hier bereits {count} offene(s) Ticket(s) (max. {max}). Schließe erst eins.',
    'ticket.createFailed': '❌ Ticket-Kanal konnte nicht erstellt werden: {error}',
    'ticket.created': '✅ Ticket erstellt: {channel}',
    'ticket.embedTitle': '🎫 Ticket #{number} — {panel}',
    'ticket.footerOpenedBy': 'Eröffnet von {tag}',
    'ticket.closedTitle': '🔒 Ticket #{number} geschlossen',
    'ticket.closedDesc': 'Geschlossen von **{by}**. Der ursprüngliche Ersteller ({user}) kann diesen Kanal nicht mehr sehen.',
    'ticket.reopenedTitle': '🔓 Ticket #{number} wieder geöffnet',
    'ticket.reopenedDesc': '{userMention} kann dieses Ticket wieder sehen.',
    'ticket.notOpen': 'Das ist kein offenes Ticket.',
    'ticket.notClosed': 'Das ist kein geschlossenes Ticket.',
    'ticket.noRecord': 'Kein Ticket-Eintrag für diesen Kanal.',
    'ticket.confirmClose': '⚠️ Dieses Ticket schließen?',
    'ticket.confirmDelete': '⚠️ Diesen Ticket-Kanal endgültig löschen? Das kann nicht rückgängig gemacht werden.',
    'ticket.transcriptTitle': '📄 Verlauf für Ticket **#{number}**',
    'ticket.error': '❌ {message}',
    'ticket.btnClose': 'Schließen',
    'ticket.btnConfirmClose': 'Schließen bestätigen',
    'ticket.btnCancel': 'Abbrechen',
    'ticket.btnReopen': 'Wieder öffnen',
    'ticket.btnTranscript': 'Verlauf',
    'ticket.btnDelete': 'Löschen',
    'ticket.btnPermanentlyDelete': 'Endgültig löschen',

    'verify.notConfigured': 'Die Verifizierung ist auf diesem Server noch nicht vollständig eingerichtet — bitte ein Admin-Team-Mitglied, die Mitgliedsrolle im Dashboard festzulegen.',
    'verify.success': '✅ Verifiziert! Willkommen.',
    'verify.failed': 'Verifizierung fehlgeschlagen: {error}',
    'verify.embedTitle': '✅ Verifizieren für Zugriff',
    'verify.embedDesc': 'Klicke auf den Button unten, um dich zu verifizieren und den Rest des Servers freizuschalten.',
    'verify.button': 'Verifizieren',

    'giveaway.winners': 'Gewinner{plural}: {list}',
    'giveaway.noWinners': 'Keine gültigen Teilnahmen — es konnte kein Gewinner ermittelt werden.',
    'giveaway.active': 'Reagiere mit 🎉, um teilzunehmen!\nGewinner: **{count}**\nEndet: {endsAt}',
    'giveaway.congrats': '🎉 Herzlichen Glückwunsch {list}! Du hast **{prize}** gewonnen!',
    'giveaway.noEntries': '😔 Niemand hat am Gewinnspiel für **{prize}** teilgenommen.',

    'counting.doubleUp': '❌ {user}, du kannst nicht zweimal hintereinander zählen! Zurück auf **1**.',
    'counting.wrongNumber': '❌ {user} hat die Zählung unterbrochen! Erwartet war **{expected}**, aber es kam **{got}**. Zurück auf **1**.',

    'command.unknownWithSuggestion': '❓ Unbekannter Befehl `{prefix}{cmd}` — meintest du `{prefix}{suggestion}`?',
    'command.unknownNoSuggestion': '❓ Unbekannter Befehl `{prefix}{cmd}`. Probier `{prefix}help`, um alle Befehle zu sehen.',
  },

  fr: {
    'ticket.panelGone': "🚫 Ce panneau de ticket n'est plus configuré — demandez au staff de le republier.",
    'ticket.maxOpen': '🚫 Vous avez déjà {count} ticket(s) ouvert(s) ici (max {max}). Fermez-en un d\'abord.',
    'ticket.createFailed': '❌ Impossible de créer le salon du ticket : {error}',
    'ticket.created': '✅ Ticket créé : {channel}',
    'ticket.embedTitle': '🎫 Ticket #{number} — {panel}',
    'ticket.footerOpenedBy': 'Ouvert par {tag}',
    'ticket.closedTitle': '🔒 Ticket #{number} fermé',
    'ticket.closedDesc': 'Fermé par **{by}**. La personne qui l\'a ouvert ({user}) ne peut plus voir ce salon.',
    'ticket.reopenedTitle': '🔓 Ticket #{number} rouvert',
    'ticket.reopenedDesc': '{userMention} peut de nouveau voir ce ticket.',
    'ticket.notOpen': "Ce n'est pas un ticket ouvert.",
    'ticket.notClosed': "Ce n'est pas un ticket fermé.",
    'ticket.noRecord': "Aucun ticket enregistré pour ce salon.",
    'ticket.confirmClose': '⚠️ Fermer ce ticket ?',
    'ticket.confirmDelete': '⚠️ Supprimer définitivement ce salon de ticket ? Cette action est irréversible.',
    'ticket.transcriptTitle': '📄 Transcription du ticket **#{number}**',
    'ticket.error': '❌ {message}',
    'ticket.btnClose': 'Fermer',
    'ticket.btnConfirmClose': 'Confirmer la fermeture',
    'ticket.btnCancel': 'Annuler',
    'ticket.btnReopen': 'Rouvrir',
    'ticket.btnTranscript': 'Transcription',
    'ticket.btnDelete': 'Supprimer',
    'ticket.btnPermanentlyDelete': 'Supprimer définitivement',

    'verify.notConfigured': "La vérification n'est pas encore entièrement configurée sur ce serveur — demandez à un admin de définir le rôle Membre dans le dashboard.",
    'verify.success': '✅ Vérifié ! Bienvenue.',
    'verify.failed': 'Impossible de vous vérifier : {error}',
    'verify.embedTitle': "✅ Vérifiez-vous pour accéder au serveur",
    'verify.embedDesc': 'Cliquez sur le bouton ci-dessous pour vérifier votre compte et débloquer le reste du serveur.',
    'verify.button': 'Vérifier',

    'giveaway.winners': 'Gagnant{plural} : {list}',
    'giveaway.noWinners': "Aucune participation valide — aucun gagnant n'a pu être tiré au sort.",
    'giveaway.active': 'Réagissez avec 🎉 pour participer !\nGagnants : **{count}**\nSe termine : {endsAt}',
    'giveaway.congrats': '🎉 Félicitations {list} ! Vous avez gagné **{prize}** !',
    'giveaway.noEntries': "😔 Personne n'a participé au concours pour **{prize}**.",

    'counting.doubleUp': "❌ {user}, tu ne peux pas compter deux fois de suite ! Retour à **1**.",
    'counting.wrongNumber': '❌ {user} a interrompu le compte ! **{expected}** était attendu, mais **{got}** a été reçu. Retour à **1**.',

    'command.unknownWithSuggestion': '❓ Commande inconnue `{prefix}{cmd}` — vouliez-vous dire `{prefix}{suggestion}` ?',
    'command.unknownNoSuggestion': '❓ Commande inconnue `{prefix}{cmd}`. Essayez `{prefix}help` pour voir toutes les commandes.',
  },
};

function getLang(guildId) {
  const lang = guildConfig.getConfig(guildId)?.language;
  return LANGS.includes(lang) ? lang : 'en';
}

function t(guildId, key, vars = {}) {
  const lang = getLang(guildId);
  let str = DICTS[lang]?.[key] ?? DICTS.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replaceAll(`{${k}}`, String(v));
  }
  return str;
}

module.exports = { t, getLang, LANGS };
