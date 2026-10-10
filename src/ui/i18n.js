(() => {
  const german = new Map(Object.entries({
    'Your library stays on this computer.': 'Deine Bibliothek bleibt auf diesem Computer.',
    'Install app': 'App installieren',
    'Log out': 'Abmelden',
    'Local-network HTTP is not encrypted. Use only on a trusted LAN; never expose this service directly to the internet.':
      'HTTP im lokalen Netzwerk ist nicht verschlüsselt. Nur in einem vertrauenswürdigen LAN verwenden und niemals direkt dem Internet aussetzen.',
    'Dismiss network warning': 'Netzwerk-Warnung ausblenden',
    'Dismiss': 'Ausblenden',
    'Password': 'Passwort',
    'Change password': 'Passwort ändern',
    'Current password': 'Aktuelles Passwort',
    'New password': 'Neues Passwort',
    'Confirm new password': 'Neues Passwort bestätigen',
    'Changing your password signs out other devices.': 'Beim Ändern des Passworts werden andere Geräte abgemeldet.',
    'Use at least 12 characters, including uppercase and lowercase letters, a number, and a special character.':
      'Verwende mindestens 12 Zeichen mit Groß- und Kleinbuchstaben, einer Zahl und einem Sonderzeichen.',
    'New passwords do not match.': 'Die neuen Passwörter stimmen nicht überein.',
    'Current password is incorrect.': 'Das aktuelle Passwort ist falsch.',
    'Password changed. Other devices have been signed out.':
      'Passwort geändert. Andere Geräte wurden abgemeldet.',
    'Continue': 'Weiter',
    'Collection': 'Sammlung',
    'Collections': 'Sammlungen',
    'Browse': 'Durchsuchen',
    'Apply / restore': 'Anwenden / Wiederherstellen',
    'History': 'Verlauf',
    'Help': 'Hilfe',
    'Photo info': 'Fotoinformationen',
    'Pause review': 'Überprüfung pausieren',
    'Open menu': 'Menü öffnen',
    'Collapse navigation': 'Navigation einklappen',
    'Expand navigation': 'Navigation ausklappen',
    'Close menu': 'Menü schließen',
    'Active collection': 'Aktive Sammlung',
    'Apply decisions': 'Entscheidungen anwenden',
    'Refresh history': 'Verlauf aktualisieren',
    'Photo': 'Foto',
    'File': 'Datei',
    'Date': 'Datum',
    'All items': 'Alle Elemente',
    'Filename or folder starts with': 'Dateiname oder Ordner beginnt mit',
    'From date': 'Ab Datum',
    'To date': 'Bis Datum',
    'Media type': 'Medientyp',
    'All media': 'Alle Medien',
    'Images': 'Bilder',
    'Videos': 'Videos',
    'Folder': 'Ordner',
    'All folders': 'Alle Ordner',
    'Apply filters': 'Filter anwenden',
    'Clear filters': 'Filter löschen',
    'Folder scan status': 'Ordnerscan-Status',
    'Retry scan': 'Scan wiederholen',
    'Scan failed': 'Scan fehlgeschlagen',
    'Not scanned yet': 'Noch nicht gescannt',
    'Recursive watching is unavailable; this folder is rescanned periodically.':
      'Rekursives Überwachen ist nicht verfügbar; dieser Ordner wird regelmäßig erneut gescannt.',
    'File watching is retrying.': 'Die Dateiüberwachung wird erneut versucht.',
    'No unseen or unsure items. Browse your collection or add more photos.':
      'Keine ungesehenen oder unsicheren Fotos. Durchsuche deine Sammlung oder füge weitere Fotos hinzu.',
    'All unseen and unsure photos are resolved. Browse the collection or apply your decisions.':
      'Alle ungesehenen und unsicheren Fotos sind erledigt. Durchsuche die Sammlung oder wende deine Entscheidungen an.',
    'Review paused. Your current place is saved.':
      'Überprüfung pausiert. Deine aktuelle Position wurde gespeichert.',
    'Choose a folder to start building this collection.':
      'Wähle einen Ordner aus, um diese Sammlung aufzubauen.',
    'Create or choose a collection before reviewing photos.':
      'Erstelle oder wähle eine Sammlung aus, bevor du Fotos überprüfst.',
    'Saved review position could not be read. Starting at the beginning.':
      'Die gespeicherte Überprüfungsposition konnte nicht gelesen werden. Beginn am Anfang.',
    'Saved review position is invalid. Starting at the beginning.':
      'Die gespeicherte Überprüfungsposition ist ungültig. Beginn am Anfang.',
    'New collection name': 'Name der neuen Sammlung',
    'New collection': 'Neue Sammlung',
    'Create': 'Erstellen',
    'Sort': 'Sortierung',
    'Capture date ↑': 'Aufnahmedatum ↑',
    'Capture date ↓': 'Aufnahmedatum ↓',
    'Filename': 'Dateiname',
    'Choose folder': 'Ordner auswählen',
    'Archive collection': 'Sammlung archivieren',
    'Settings': 'Einstellungen',
    'Default sort order': 'Standardsortierung',
    'Preview cache limit (MB; 0 disables caching)': 'Vorschau-Cache-Limit (MB; 0 deaktiviert den Cache)',
    'Theme': 'Darstellung',
    'System': 'System',
    'Light': 'Hell',
    'Dark': 'Dunkel',
    'Grid columns': 'Spalten im Raster',
    'Automatic': 'Automatisch',
    'Language': 'Sprache',
    'Passkeys': 'Passkeys',
    'Sign in with a passkey': 'Mit einem Passkey anmelden',
    'Add a passkey': 'Passkey hinzufügen',
    'Save settings': 'Einstellungen speichern',
    'Start Photo Sorter when I sign in': 'Photo Sorter bei der Anmeldung starten',
    'Manage collection folders': 'Sammlungsordner verwalten',
    'Archived collections': 'Archivierte Sammlungen',
    'Connect a phone on this local network': 'Telefon mit diesem lokalen Netzwerk verbinden',
    'Loading local addresses…': 'Lokale Adressen werden geladen…',
    'Media category': 'Medienkategorie',
    'Custom category': 'Benutzerdefinierte Kategorie',
    'Choose category…': 'Kategorie auswählen…',
    'Manage categories': 'Kategorien verwalten',
    '↑ Category': '↑ Kategorie',
    'Choose a custom category': 'Benutzerdefinierte Kategorie auswählen',
    'Choose a custom category (ArrowUp)': 'Benutzerdefinierte Kategorie auswählen (Pfeil nach oben)',
    'Choose a category': 'Kategorie auswählen',
    'No custom categories yet. Create one to categorize this photo.':
      'Noch keine benutzerdefinierten Kategorien. Erstelle eine Kategorie, um dieses Foto einzuordnen.',
    'Create category': 'Kategorie erstellen',
    'New category': 'Neue Kategorie',
    'Category name': 'Kategoriename',
    'Use up to 80 characters. Names must be unique and cannot contain path separators or reserved folder names.':
      'Bis zu 80 Zeichen. Namen müssen eindeutig sein und dürfen keine Pfadtrenner oder reservierten Ordnernamen enthalten.',
    'Save category': 'Kategorie speichern',
    'Save changes': 'Änderungen speichern',
    'Rename category': 'Kategorie umbenennen',
    'Rename': 'Umbenennen',
    'No custom categories yet.': 'Noch keine benutzerdefinierten Kategorien.',
    'Done': 'Fertig',
    'Reassign assigned photos to': 'Zugewiesene Fotos neu zuordnen zu',
    'Choose a destination…': 'Ziel auswählen…',
    'Unseen (clear decision)': 'Nicht gesichtet (Entscheidung zurücksetzen)',
    'Delete category': 'Kategorie löschen',
    'Reassign and delete': 'Neu zuordnen und löschen',
    'Any file moves remain staged until you review and confirm Apply.':
      'Dateiverschiebungen bleiben vorgemerkt, bis du sie prüfst und das Anwenden bestätigst.',
    'Photo Health': 'Fotoanalyse',
    'Photo Health analysis progress': 'Fortschritt der Fotoanalyse',
    'Find exact duplicates, very similar photo copies, and clearly blurry photos. Reviewing findings only changes decisions; it never moves files.':
      'Finde exakte Duplikate, sehr ähnliche Fotokopien und deutlich unscharfe Fotos. Die Prüfung ändert nur Entscheidungen und verschiebt keine Dateien.',
    'Enable analysis': 'Analyse aktivieren',
    'Pause analysis': 'Analyse pausieren',
    'Resume analysis': 'Analyse fortsetzen',
    'Analysis is not enabled.': 'Die Analyse ist nicht aktiviert.',
    'Analysis is not enabled for this collection.': 'Die Analyse ist für diese Sammlung nicht aktiviert.',
    'Choose a collection to use Photo Health.': 'Wähle eine Sammlung für die Fotoanalyse aus.',
    'This recognized file format could not be analyzed': 'Dieses erkannte Dateiformat konnte nicht analysiert werden',
    'Analysis failed': 'Analyse fehlgeschlagen',
    'Finding type': 'Fundtyp',
    'Duplicates and blur': 'Duplikate und Unschärfe',
    'Duplicates': 'Duplikate',
    'Blur': 'Unschärfe',
    'Review state': 'Prüfstatus',
    'Needs review': 'Zu prüfen',
    'Handled, including Unsure': 'Erledigt, einschließlich „Unsicher“',
    'All findings': 'Alle Funde',
    'Exact file match': 'Exakte Dateiübereinstimmung',
    'Exact match': 'Exakte Übereinstimmung',
    'Exact file match · Exact match': 'Exakte Dateiübereinstimmung · Exakte Übereinstimmung',
    'Very similar image framing and content': 'Sehr ähnlicher Bildausschnitt und Bildinhalt',
    'Close comparison': 'Vergleich schließen',
    'Compare and review': 'Vergleichen und prüfen',
    'Compare the files side by side, then choose one or more photos to keep. Every other group member will be staged as Deleted; no files are moved.':
      'Vergleiche die Dateien nebeneinander und wähle anschließend ein oder mehrere Fotos zum Behalten aus. Alle übrigen Gruppenmitglieder werden als gelöscht vorgemerkt; Dateien werden nicht verschoben.',
    'Clearly blurry photo': 'Deutlich unscharfes Foto',
    'Preview unavailable; the decision is still available.':
      'Vorschau nicht verfügbar; die Entscheidung ist weiterhin möglich.',
    'Stage as Deleted': 'Als gelöscht vormerken',
    'Handled · decision is shared with other views.':
      'Erledigt · die Entscheidung wird mit anderen Ansichten geteilt.',
    'No findings match these filters.': 'Keine Funde entsprechen diesen Filtern.',
    'Enable analysis to discover findings.': 'Aktiviere die Analyse, um Funde zu entdecken.',
    'Previous members': 'Vorherige Elemente',
    'Next members': 'Nächste Elemente',
    'Keep selected; stage the rest as Deleted': 'Ausgewählte behalten; übrige als gelöscht vormerken',
    'Save duplicate decisions': 'Duplikatentscheidungen speichern',
    'This only changes review decisions. No files will be moved or deleted.':
      'Dies ändert nur die Prüfentscheidungen. Es werden keine Dateien verschoben oder gelöscht.',
    'Save decisions': 'Entscheidungen speichern',
    'Left comparison': 'Linker Vergleich',
    'Right comparison': 'Rechter Vergleich',
    'photo_health_state_changed': 'Fotoanalyse-Status geändert',
    'photo_health_group_decided': 'Duplikatentscheidungen gespeichert',
    'Invalid Photo Health action.': 'Ungültige Aktion für die Fotoanalyse.',
    'Invalid Photo Health finding type.': 'Ungültiger Fundtyp für die Fotoanalyse.',
    'Invalid handled filter.': 'Ungültiger Prüfstatusfilter.',
    'Invalid Photo Health page.': 'Ungültige Seite der Fotoanalyse.',
    'Duplicate group not found in this collection.': 'Duplikatgruppe in dieser Sammlung nicht gefunden.',
    'Choose between one and 100 photos to keep.': 'Wähle zwischen einem und 100 Fotos zum Behalten aus.',
    'Every selected photo must belong to this duplicate group.':
      'Jedes ausgewählte Foto muss zu dieser Duplikatgruppe gehören.',
    'A photo in this duplicate group is being reviewed on another device.':
      'Ein Foto dieser Duplikatgruppe wird gerade auf einem anderen Gerät überprüft.',
    'File changed before analysis. Rescan the collection to update its index.':
      'Die Datei wurde vor der Analyse geändert. Scanne die Sammlung erneut, um den Index zu aktualisieren.',
    'File changed during analysis. Rescan the collection to update its index.':
      'Die Datei wurde während der Analyse geändert. Scanne die Sammlung erneut, um den Index zu aktualisieren.',
    'All': 'Alle',
    'Unseen': 'Nicht gesichtet',
    'Keep': 'Behalten',
    'Delete': 'Löschen',
    'Unsure': 'Unsicher',
    'unseen': 'nicht gesichtet',
    'keep': 'behalten',
    'delete': 'löschen',
    'unsure': 'unsicher',
    'Review': 'Überprüfung',
    'Enter fullscreen': 'Vollbild öffnen',
    'Exit fullscreen': 'Vollbild schließen',
    'Image zoom controls': 'Bildzoom-Steuerung',
    'Zoom out': 'Verkleinern',
    'Reset zoom': 'Zoom zurücksetzen',
    'Zoom in': 'Vergrößern',
    'Collection grid': 'Sammlungsraster',
    'Create a collection, then choose a folder from the host desktop app.':
      'Erstelle eine Sammlung und wähle anschließend einen Ordner in der Desktop-App des Hosts aus.',
    'Previous': 'Zurück',
    'Next': 'Weiter',
    'Rescan roots': 'Ordner erneut scannen',
    'Review and apply moves': 'Verschiebungen prüfen und anwenden',
    'Classification complete': 'Kategorisierung abgeschlossen',
    'All unseen and unsure items have been processed. Review and apply your categories now?':
      'Alle ungesehenen und unsicheren Elemente wurden bearbeitet. Möchtest du deine Kategorien jetzt prüfen und anwenden?',
    'Restore latest apply': 'Letzte Anwendung wiederherstellen',
    'Audit log': 'Audit-Protokoll',
    'Previous page': 'Vorherige Seite',
    'Next page': 'Nächste Seite',
    'Export audit log': 'Audit-Protokoll exportieren',
    'Clear audit log': 'Audit-Protokoll löschen',
    'Batch ID': 'Gruppen-ID',
    'Collection ID': 'Sammlungs-ID',
    'Credential ID': 'Anmeldeschlüssel-ID',
    'Media ID': 'Medien-ID',
    'Raw JSON': 'Rohdaten (JSON)',
    'Read only': 'Schreibgeschützt',
    'Retry in ms': 'Erneuter Versuch in ms',
    'Root ID': 'Ordner-ID',
    'Quick help and safety': 'Kurzanleitung und Sicherheit',
    'Confirm': 'Bestätigen',
    'Cancel': 'Abbrechen',
    'Confirm move': 'Verschiebung bestätigen',
    'Use ←/swipe left for Delete, →/swipe right for Keep, ↓/swipe down for Unsure, and ↑/swipe up for a custom category. Press 1–9 or choose a category; selection saves and advances. Decisions never move files until you explicitly Apply.':
      '←/nach links wischen bedeutet Löschen, →/nach rechts wischen bedeutet Behalten, ↓/nach unten wischen bedeutet Unsicher und ↑/nach oben wischen öffnet eine benutzerdefinierte Kategorie. Drücke 1–9 oder wähle eine Kategorie; die Auswahl wird gespeichert und fährt fort. Entscheidungen verschieben Dateien erst, wenn du sie ausdrücklich anwendest.',
    'Create, rename, and delete custom categories in Browse. Apply shows a move summary first, then requires a separate confirmation; category files move to category-named folders while preserving subfolders. Nothing is permanently deleted.':
      'Erstelle, benenne um und lösche benutzerdefinierte Kategorien unter „Durchsuchen“. Beim Anwenden wird zuerst eine Verschiebungsübersicht angezeigt und eine separate Bestätigung verlangt. Dateien werden in Ordner mit dem jeweiligen Kategorienamen verschoben; Unterordner bleiben erhalten. Nichts wird endgültig gelöscht.',
    'Photo Health can find exact duplicates, near-identical photo copies, and clearly blurry photos. Analysis can be paused across devices; its review decisions never move files.':
      'Die Fotoanalyse findet exakte Duplikate, nahezu identische Fotokopien und deutlich unscharfe Fotos. Die Analyse kann auf allen Geräten pausiert werden; Prüfentscheidungen verschieben keine Dateien.',
    'Use the zoom controls or pinch on an image to zoom; drag a zoomed image to pan. Scroll the collection grid to browse large libraries.':
      'Verwende die Zoom-Steuerung oder ziehe zwei Finger auf einem Bild auseinander, um es zu vergrößern. Ziehe ein vergrößertes Bild zum Verschieben. Scrolle im Sammlungsraster, um große Bibliotheken zu durchsuchen.',
    'Use the zoom controls or pinch on an image to zoom; drag a zoomed image to pan. Scroll the collection grid to browse large libraries. Enter fullscreen to focus on categorizing; press Escape or use the close button to leave.':
      'Verwende die Zoom-Steuerung oder ziehe zwei Finger auf einem Bild auseinander, um es zu vergrößern. Ziehe ein vergrößertes Bild zum Verschieben. Scrolle im Sammlungsraster, um große Bibliotheken zu durchsuchen. Öffne den Vollbildmodus zum Kategorisieren; drücke Escape oder verwende die Schließen-Schaltfläche, um ihn zu verlassen.',
    'Use the zoom controls or pinch on an image to zoom; drag a zoomed image to pan. Scroll the collection grid to browse large libraries. Press Escape to pause review.':
      'Verwende die Zoom-Steuerung oder ziehe zwei Finger auf einem Bild auseinander, um es zu vergrößern. Ziehe ein vergrößertes Bild zum Verschieben. Scrolle im Sammlungsraster, um große Bibliotheken zu durchsuchen. Drücke Escape, um die Überprüfung zu pausieren.',
    'Apply shows a move summary first, then requires a separate confirmation. Delete-category files move into a':
      'Vor dem Anwenden wird eine Zusammenfassung angezeigt und eine separate Bestätigung verlangt. Dateien der Kategorie „Löschen“ werden in den Ordner',
    'folder; nothing is permanently deleted.': 'verschoben; nichts wird endgültig gelöscht.',
    'Restore moves the latest apply batch back when the original paths are free. Conflicts are never overwritten.':
      'Die letzte angewendete Gruppe wird wiederhergestellt, sofern die ursprünglichen Pfade frei sind. Konflikte werden niemals überschrieben.',
    'Unsupported image/video previews can still be categorized. Video playback depends on codecs available in your operating system.':
      'Nicht unterstützte Bild- und Videovorschauen können trotzdem kategorisiert werden. Die Videowiedergabe hängt von den verfügbaren Codecs des Betriebssystems ab.',
    'Only use trusted local networks, or put the service behind your own HTTPS/VPN proxy. Do not expose it publicly.':
      'Nur in vertrauenswürdigen lokalen Netzwerken verwenden oder den Dienst über einen eigenen HTTPS-/VPN-Proxy betreiben. Nicht öffentlich zugänglich machen.',
    'PWA installation and passkeys require a secure HTTPS origin; passkeys also need host configuration.':
      'PWA-Installation und Passkeys benötigen einen sicheren HTTPS-Ursprung; Passkeys erfordern außerdem eine Host-Konfiguration.',
    'App data contains your password hash, decisions, apply history, and audit log. There are no automatic backups. Uninstalling the application keeps app data; manually removing it deletes this history, not your original media.':
      'Die App-Daten enthalten Passwort-Hash, Entscheidungen, Anwendungsverlauf und Audit-Protokoll. Es gibt keine automatischen Sicherungen. Bei der Deinstallation bleibt der App-Datenordner erhalten; beim manuellen Entfernen gehen Verlauf und Einstellungen verloren, nicht jedoch deine Originalmedien.',
    'Waiting for host setup': 'Warte auf die Einrichtung des Hosts',
    'The host desktop app must set the account password before other devices can connect.':
      'Die Desktop-App des Hosts muss das Kontopasswort festlegen, bevor andere Geräte eine Verbindung herstellen können.',
    'Log in': 'Anmelden',
    'Create your password': 'Passwort erstellen',
    'Your session ends when the host service restarts.': 'Deine Sitzung endet beim Neustart des Hostdienstes.',
    'Set password': 'Passwort festlegen',
    'Cannot reach the local host': 'Der lokale Host ist nicht erreichbar',
    'Authentication required.': 'Anmeldung erforderlich.',
    'Incorrect password.': 'Falsches Passwort.',
    'Too many attempts. Try again later.': 'Zu viele Versuche. Bitte später erneut versuchen.',
    'Use a password of at least 12 characters.': 'Verwende ein Passwort mit mindestens 12 Zeichen.',
    'Password must not exceed 1024 bytes.': 'Das Passwort darf höchstens 1024 Byte lang sein.',
    'Password must include an uppercase letter, a lowercase letter, a number, and a special character.':
      'Das Passwort muss einen Großbuchstaben, einen Kleinbuchstaben, eine Zahl und ein Sonderzeichen enthalten.',
    'Password setup has already been completed.': 'Die Passworteinrichtung wurde bereits abgeschlossen.',
    'Collection not found.': 'Sammlung nicht gefunden.',
    'Root not found.': 'Ordner nicht gefunden.',
    'Media item not found.': 'Medienelement nicht gefunden.',
    'Invalid settings.': 'Ungültige Einstellungen.',
    'Invalid category.': 'Ungültige Kategorie.',
    'Category name must be text.': 'Der Kategoriename muss Text sein.',
    'Choose a unique category name that is also a safe folder name.':
      'Wähle einen eindeutigen Kategorienamen, der auch als sicherer Ordnername geeignet ist.',
    'A category with that name already exists in this collection.':
      'In dieser Sammlung gibt es bereits eine Kategorie mit diesem Namen.',
    'Category not found.': 'Kategorie nicht gefunden.',
    'Deleting a category requires explicit confirmation.':
      'Zum Löschen einer Kategorie ist eine ausdrückliche Bestätigung erforderlich.',
    'Choose a different category or Unseen for the assigned photos.':
      'Wähle für die zugewiesenen Fotos eine andere Kategorie oder „Nicht gesichtet“.',
    'A photo in this category is being reviewed on another device. Try again after that review finishes.':
      'Ein Foto dieser Kategorie wird gerade auf einem anderen Gerät überprüft. Versuche es erneut, wenn die Überprüfung abgeschlossen ist.',
    'Invalid review position.': 'Ungültige Position in der Überprüfung.',
    'This item is being reviewed on another device.': 'Dieses Element wird auf einem anderen Gerät überprüft.',
    'Apply requires explicit confirmation.': 'Zum Anwenden ist eine ausdrückliche Bestätigung erforderlich.',
    'Cross-volume moves are not supported.': 'Verschiebungen zwischen Laufwerken werden nicht unterstützt.',
    'Preview is unavailable.': 'Vorschau nicht verfügbar.',
    'Passkey is not registered.': 'Passkey ist nicht registriert.',
    'Passkey authentication could not be verified.': 'Die Passkey-Anmeldung konnte nicht verifiziert werden.',
    'Passkey registration could not be verified.': 'Die Passkey-Registrierung konnte nicht verifiziert werden.',
    'No passkeys are registered.': 'Es sind keine Passkeys registriert.',
    'account_created': 'Konto erstellt',
    'collection_created': 'Sammlung erstellt',
    'collection_archived': 'Sammlung archiviert',
    'collection_restored': 'Sammlung wiederhergestellt',
    'root_added': 'Ordner hinzugefügt',
    'root_readded': 'Ordner erneut hinzugefügt',
    'root_removed': 'Ordner entfernt',
    'scan_completed': 'Scan abgeschlossen',
    'scan_failed': 'Scan fehlgeschlagen',
    'watch_error': 'Überwachungsfehler',
    'decision_changed': 'Entscheidung geändert',
    'decision_undone': 'Entscheidung rückgängig gemacht',
    'decision_redone': 'Entscheidung wiederholt',
    'category_created': 'Kategorie erstellt',
    'category_renamed': 'Kategorie umbenannt',
    'category_deleted': 'Kategorie gelöscht',
    'apply_completed': 'Anwendung abgeschlossen',
    'apply_failed': 'Anwendung fehlgeschlagen',
    'apply_recovered': 'Anwendung wiederhergestellt',
    'restore_completed': 'Wiederherstellung abgeschlossen',
    'passkey_added': 'Passkey hinzugefügt',
    'passkey_removed': 'Passkey entfernt',
    'audit_cleared': 'Audit-Protokoll geleert',
    'No items in this category.': 'Keine Elemente in dieser Kategorie.',
    'No media matches these filters.': 'Keine Medien entsprechen diesen Filtern.',
    'queued': 'in Warteschlange',
    'running': 'läuft',
    'No items in this collection.': 'Keine Elemente in dieser Sammlung.',
    'Loading items…': 'Elemente werden geladen…',
    'Preview unavailable. This file can still be sorted.': 'Vorschau nicht verfügbar. Diese Datei kann trotzdem sortiert werden.',
    'Video preview unavailable. This file can still be sorted.':
      'Videovorschau nicht verfügbar. Diese Datei kann trotzdem sortiert werden.',
    'No LAN IPv4 address is currently available.': 'Derzeit ist keine LAN-IPv4-Adresse verfügbar.',
    'Remove': 'Entfernen',
    'Restore': 'Wiederherstellen',
    'Clear decision': 'Entscheidung zurücksetzen',
    'No folders are registered.': 'Es sind keine Ordner registriert.',
    'No archived collections.': 'Keine archivierten Sammlungen.',
    'I reviewed the existing folders and explicitly approve reusing them.':
      'Ich habe die vorhandenen Ordner geprüft und stimme ihrer Wiederverwendung ausdrücklich zu.',
    'There are no delete/unsure moves to apply.': 'Es gibt keine Lösch- oder Unsicher-Verschiebungen zum Anwenden.',
    'No file will be permanently deleted. A failure stops the batch.':
      'Keine Datei wird endgültig gelöscht. Bei einem Fehler wird die Gruppe angehalten.',
    'Existing deleted/unsure folder(s) are not marked as app-owned; inspect and approve reuse to continue.':
      'Vorhandene Ordner „deleted“/„unsure“ sind nicht als app-eigen markiert. Prüfe sie und bestätige die Wiederverwendung.',
    'This will perform {count} file operation(s): {moves} new move(s), {recategorized} recategorization(s), and {restored} restore(s). {skipped} item(s) on read-only roots will be skipped.':
      'Es werden {count} Dateioperationen ausgeführt: {moves} neue Verschiebungen, {recategorized} Neukategorisierungen und {restored} Wiederherstellungen. {skipped} Elemente auf schreibgeschützten Ordnern werden übersprungen.',
    'There is no apply batch to restore.': 'Es gibt keine Anwendung, die wiederhergestellt werden kann.',
    'Saving settings.': 'Einstellungen werden gespeichert.',
    'Settings saved.': 'Einstellungen gespeichert.',
    'Sign-in startup setting updated.': 'Autostart-Einstellung aktualisiert.',
    'Folder registered; scanning has started.': 'Ordner registriert; der Scan wurde gestartet.',
    'Confirm reuse of the existing deleted/unsure folders before applying.':
      'Bestätige vor dem Anwenden die Wiederverwendung der vorhandenen Ordner „deleted“/„unsure“.',
    'Confirm reuse of the existing category folders before applying.':
      'Bestätige vor dem Anwenden die Wiederverwendung der vorhandenen Kategorieordner.',
    'Apply plan is outdated because a category changed; create a new summary.':
      'Der Anwendungsplan ist veraltet, weil eine Kategorie geändert wurde. Erstelle eine neue Zusammenfassung.',
    'Apply these moves': 'Diese Dateien verschieben',
    'Review file moves': 'Dateiverschiebungen prüfen',
    'Archive this collection? Its decisions and indexed history will be kept. Its folders can then be registered by another active collection.':
      'Diese Sammlung archivieren? Entscheidungen und Indexverlauf bleiben erhalten. Ihre Ordner können danach einer anderen aktiven Sammlung zugeordnet werden.',
    'Remove folder from collection': 'Ordner aus Sammlung entfernen',
    'Restore batch': 'Gruppe wiederherstellen',
    'Permanently remove the current audit entries? A single audit_cleared event will be retained.':
      'Aktuelle Audit-Einträge endgültig entfernen? Ein einzelner Eintrag „audit_cleared“ bleibt erhalten.',
    'Scanning {folders} folder(s); {items} media item(s) indexed so far.':
      'Scanne {folders} Ordner; bisher {items} Medienelemente indiziert.',
    'Scanning complete: {items} media item(s) indexed.': 'Scan abgeschlossen: {items} Medienelemente indiziert.',
    'Started scanning {folders} folder(s).': 'Scan für {folders} Ordner gestartet.',
    'Scanning failed: {message}': 'Scan fehlgeschlagen: {message}',
    'Saved {category} decision.': 'Entscheidung „{category}“ gespeichert.',
    'Unable to start installation: {message}': 'Installation kann nicht gestartet werden: {message}',
    'Offline install support unavailable: {message}': 'Offline-Installation nicht verfügbar: {message}',
    'Cleared {count} audit event(s).': '{count} Audit-Einträge gelöscht.',
    'Applied {moves} move(s), {recategorized} recategorization(s), and {restored} restore(s). Batch {batchId} can be restored.':
      '{moves} Verschiebungen, {recategorized} Neukategorisierungen und {restored} Wiederherstellungen angewendet. Gruppe {batchId} kann wiederhergestellt werden.',
    'Restore finished with {restored} restored and {conflicts} conflict(s).':
      'Wiederherstellung abgeschlossen: {restored} wiederhergestellt, {conflicts} Konflikte.',
    'offline': 'offline',
    'read-only': 'schreibgeschützt',
    'Passkey registered.': 'Passkey registriert.',
    'Passkey added {date}': 'Passkey hinzugefügt am {date}',
    'Passkey(s) registered. Password sign-in remains available.':
      'Passkey(s) registriert. Die Anmeldung mit Passwort bleibt verfügbar.',
    'Passkeys require a configured HTTPS origin and relying-party domain.':
      'Passkeys benötigen einen konfigurierten HTTPS-Ursprung und eine Relying-Party-Domain.',
  }));
  const originals = new WeakMap();
  const attributeOriginals = new WeakMap();
  let language = 'en';

  function translate(value) {
    if (typeof value !== 'string' || language !== 'de') return value;
    const exact = german.get(value.trim());
    if (exact !== undefined) {
      const start = value.match(/^\s*/)[0];
      const end = value.match(/\s*$/)[0];
      return `${start}${exact}${end}`;
    }
    const eventSeparator = value.lastIndexOf(' · ');
    if (eventSeparator >= 0) {
      const action = value.slice(eventSeparator + 3);
      const translatedAction = german.get(action);
      if (translatedAction) return `${value.slice(0, eventSeparator + 3)}${translatedAction}`;
    }
    return value.replace(/Scanning (\d+) folder\(s\); (\d+) media item\(s\) indexed so far\./,
      (_, folders, items) => `Scanne ${folders} Ordner; bisher ${items} Medienelemente indiziert.`)
      .replace(/Scanning complete: (\d+) media item\(s\) indexed\./,
        (_, items) => `Scan abgeschlossen: ${items} Medienelemente indiziert.`)
      .replace(/^(queued|running): (\d+) indexed of (\d+) visited · watcher: (.*)$/,
        (_, status, indexed, visited, mode) =>
          `${translate(status)}: ${indexed} indiziert, ${visited} durchsucht · Überwachung: ${translate(mode)}`)
      .replace(/^Scan complete: (\d+) indexed · watcher: (.*)$/,
        (_, indexed, mode) => `Scan abgeschlossen: ${indexed} indiziert · Überwachung: ${translate(mode)}`)
      .replace(/^Scan failed · watcher: (.*)$/,
        (_, mode) => `Scan fehlgeschlagen · Überwachung: ${translate(mode)}`)
      .replace(/Recursive watching is unavailable; this folder is rescanned periodically\. (.*)/,
        (_, message) => `Rekursives Überwachen ist nicht verfügbar; dieser Ordner wird regelmäßig erneut gescannt. ${message}`)
      .replace(/File watching is retrying\. (.*)/,
        (_, message) => `Die Dateiüberwachung wird erneut versucht. ${message}`)
      .replace(/(\w+): (\d+) indexed of (\d+) visited/,
        (_, status, indexed, visited) => `${translate(status)}: ${indexed} indiziert, ${visited} durchsucht`)
      .replace(/Scan complete: (\d+) indexed/,
        (_, indexed) => `Scan abgeschlossen: ${indexed} indiziert`)
      .replace(/watcher: polling/,
        'Überwachung: regelmäßiger Scan')
      .replace(/watcher: recursive/,
        'Überwachung: rekursiv')
      .replace(/Folder attention needed: (.*)\. Open Browse to inspect errors or retry a folder\./,
        (_, details) => `Ordner erfordern Aufmerksamkeit: ${details}. Öffne Durchsuchen, um Fehler zu prüfen oder einen neuen Scan zu starten.`)
      .replace(/(\d+) scan\(s\) failed/,
        (_, count) => `${count} Scan(s) fehlgeschlagen`)
      .replace(/(\d+) path error\(s\)/,
        (_, count) => `${count} Pfadfehler`)
      .replace(/(\d+) folder\(s\) use periodic scan recovery/,
        (_, count) => `${count} Ordner verwenden regelmäßige Scan-Wiederherstellung`)
      .replace(/^polling$/, 'regelmäßiger Scan')
      .replace(/^recursive$/, 'rekursiv')
      .replace(/^retrying$/, 'wird erneut versucht')
      .replace(/^starting$/, 'wird gestartet')
      .replace(/Showing (\d+) of (\d+) path errors\./,
        (_, shown, total) => `${shown} von ${total} Pfadfehlern werden angezeigt.`)
      .replace(/Started scanning (\d+) folder\(s\)\./,
        (_, folders) => `Scan für ${folders} Ordner gestartet.`)
      .replace(/There are no delete\/unsure moves to apply\./,
        'Es gibt keine Lösch- oder Unsicher-Verschiebungen zum Anwenden.')
      .replace(/This will perform (\d+) file operation\(s\): (\d+) new move\(s\), (\d+) recategorization\(s\), and (\d+) restore\(s\)\. (\d+) item\(s\) on read-only roots will be skipped\./,
        (_, count, moves, recategorized, restored, skipped) =>
          `Es werden ${count} Dateioperationen ausgeführt: ${moves} neue Verschiebungen, ${recategorized} Neukategorisierungen und ${restored} Wiederherstellungen. ${skipped} Elemente auf schreibgeschützten Ordnern werden übersprungen.`)
      .replace(/(\d+) restore destination\(s\) are already occupied and will not be overwritten\./,
        (_, count) => `${count} Wiederherstellungsziel(e) sind bereits belegt und werden nicht überschrieben.`)
      .replace(/And (\d+) more…/,
        (_, count) => `Und ${count} weitere…`)
      .replace(/Stopped after (\d+) move\(s\), (\d+) recategorization\(s\), and (\d+) restore\(s\)\. Failure: (.*)/,
        (_, moved, recategorized, restored, error) =>
          `Nach ${moved} Verschiebungen, ${recategorized} Neukategorisierungen und ${restored} Wiederherstellungen angehalten. Fehler: ${error}`)
      .replace(/Applied (\d+) move\(s\), (\d+) recategorization\(s\), and (\d+) restore\(s\)\. Batch (.*) can be restored\./,
        (_, moved, recategorized, restored, batchId) =>
          `${moved} Verschiebungen, ${recategorized} Neukategorisierungen und ${restored} Wiederherstellungen angewendet. Gruppe ${batchId} kann wiederhergestellt werden.`)
      .replace(/Restore finished with (\d+) restored and (\d+) conflict\(s\)\./,
        (_, restored, conflicts) =>
          `Wiederherstellung abgeschlossen: ${restored} wiederhergestellt, ${conflicts} Konflikte.`)
      .replace(/Cleared (\d+) audit event\(s\)\./,
        (_, count) => `${count} Audit-Einträge gelöscht.`)
      .replace(/Undid decision: (.*)\./,
        (_, category) => `Entscheidung rückgängig gemacht: ${translate(category)}.`)
      .replace(/Redid decision: (.*)\./,
        (_, category) => `Entscheidung wiederholt: ${translate(category)}.`)
      .replace(/Saved (keep|delete|unsure|unseen) decision\./,
        (_, category) => `Entscheidung „${translate(category)}“ gespeichert.`)
      .replace(/^Saved (.*) decision\.$/,
        (_, category) => `Entscheidung „${category}“ gespeichert.`)
      .replace(/^Created category (.*)\.$/,
        (_, category) => `Kategorie „${category}“ erstellt.`)
      .replace(/^Renamed category to (.*)\.$/,
        (_, category) => `Kategorie in „${category}“ umbenannt.`)
      .replace(/^Deleted category (.*)\.$/,
        (_, category) => `Kategorie „${category}“ gelöscht.`)
      .replace(/^This will reassign (\d+) photo\(s\) before deleting (.*)\. This action cannot be undone\.$/,
        (_, count, category) =>
          `Vor dem Löschen von „${category}“ werden ${count} Foto(s) neu zugeordnet. Diese Aktion kann nicht rückgängig gemacht werden.`)
      .replace(/^Delete (.*)\? This action cannot be undone\.$/,
        (_, category) => `Kategorie „${category}“ löschen? Diese Aktion kann nicht rückgängig gemacht werden.`)
      .replace(/^(.*) · (\d+) photo\(s\)$/,
        (_, category, count) => `${category} · ${count} Foto(s)`)
      .replace(/^Analysis paused · (\d+) of (\d+) items analyzed\.$/,
        (_, processed, total) => `Analyse pausiert · ${processed} von ${total} Elementen analysiert.`)
      .replace(/^Analysis complete · (\d+) items checked · (\d+) blur finding\(s\)\.$/,
        (_, total, blurry) => `Analyse abgeschlossen · ${total} Elemente geprüft · ${blurry} unscharfe Fotos gefunden.`)
      .replace(/^Analysis running · (\d+) of (\d+) items analyzed · (\d+) pending\.$/,
        (_, processed, total, pending) =>
          `Analyse läuft · ${processed} von ${total} Elementen analysiert · ${pending} ausstehend.`)
      .replace(/^Analysis failed — (.*)$/,
        (_, message) => `Analyse fehlgeschlagen — ${message}`)
      .replace(/: This recognized file format could not be analyzed/,
        ': Dieses erkannte Dateiformat konnte nicht analysiert werden')
      .replace(/: Analysis failed/,
        ': Analyse fehlgeschlagen')
      .replace(/^Duplicate group · (\d+) photos$/,
        (_, count) => `Duplikatgruppe · ${count} Fotos`)
      .replace(/^Exact file match · Exact match$/,
        'Exakte Dateiübereinstimmung · Exakte Übereinstimmung')
      .replace(/^Very similar image framing and content · Similarity strength (\d+)%$/,
        (_, strength) => `Sehr ähnlicher Bildausschnitt und Bildinhalt · Ähnlichkeit: ${strength}%`)
      .replace(/ · Low edge sharpness \(score ([^)]+)\)$/,
        (_, score) => ` · Geringe Kantenschärfe (Wert ${score})`)
      .replace(/^Current decision: (keep|delete|unsure|unseen)$/,
        (_, category) => `Aktuelle Entscheidung: ${translate(category)}`)
      .replace(/^(\d+) finding\(s\) · (\d+) unsupported · (\d+) analysis failure\(s\)$/,
        (_, findings, unsupported, failed) =>
          `${findings} Ergebnisse · ${unsupported} nicht unterstützte Dateien · ${failed} Analysefehler`)
      .replace(/^(\d+) of (\d+)$/,
        (_, current, total) => `${current} von ${total}`)
      .replace(/^Showing (\d+)–(\d+) of (\d+)$/,
        (_, start, end, total) => `${start}–${end} von ${total} werden angezeigt`)
      .replace(/^Keep (\d+) selected photo\(s\) and stage (\d+) other group member\(s\) as Deleted\?$/,
        (_, kept, staged) => {
          const keptPhotos = kept === '1' ? '1 ausgewähltes Foto' : `${kept} ausgewählte Fotos`;
          const stagedPhotos = staged === '1' ? '1 weiteres Foto' : `${staged} weitere Fotos`;
          return `${keptPhotos} behalten und ${stagedPhotos} der Gruppe als gelöscht vormerken?`;
        })
      .replace(/^Saved (keep|delete|unsure|unseen) decision\. No files were moved\.$/,
        (_, category) => `Entscheidung „${translate(category)}“ gespeichert. Es wurden keine Dateien verschoben.`)
      .replace(/^Saved duplicate decisions: (\d+) kept and (\d+) staged as Deleted\. No files were moved\.$/,
        (_, kept, deleted) =>
          `Duplikatentscheidungen gespeichert: ${kept} behalten und ${deleted} als gelöscht vorgemerkt. Es wurden keine Dateien verschoben.`)
      .replace(/^Photo Health analysis enabled for this collection\.$/,
        'Fotoanalyse für diese Sammlung aktiviert.')
      .replace(/(\d+) root\(s\) are currently offline\./,
        (_, count) => `${count} Ordner sind derzeit offline.`)
      .replace(/Unable to start installation: (.*)/,
        (_, message) => `Installation kann nicht gestartet werden: ${message}`)
      .replace(/Offline install support unavailable: (.*)/,
        (_, message) => `Offline-Installation nicht verfügbar: ${message}`)
      .replace(/Request failed \((\d+)\)\./,
        (_, status) => `Anfrage fehlgeschlagen (${status}).`)
      .replace(/(\d+) passkey\(s\) registered\. Password sign-in remains available\./,
        (_, count) => `${count} Passkey${count === '1' ? '' : 's'} registriert. Die Anmeldung mit Passwort bleibt verfügbar.`)
      .replace(/Passkey added (.*)/,
        (_, date) => `Passkey hinzugefügt am ${date}`)
      .replace(/^(Unseen|Keep|Delete|Unsure) items$/,
        (_, category) => `${translate(category)}-Elemente`)
      .replace(/^(\d+) items$/,
        (_, count) => `${count} Elemente`)
      .replace(/ · offline/g, ' · offline')
      .replace(/ · read-only/g, ' · schreibgeschützt')
      .replace(/ · (keep|delete|unsure|unseen)$/i,
        (_, category) => ` · ${translate(category.toLowerCase())}`);
  }

  function translateNode(node) {
    if (node.parentElement?.closest('[translate="no"]')) return;
    if (!originals.has(node)) originals.set(node, node.nodeValue);
    const source = originals.get(node);
    const next = translate(source);
    if (node.nodeValue !== next) node.nodeValue = next;
  }

  function translateAttributes(element) {
    const attributes = ['placeholder', 'aria-label', 'title'];
    let saved = attributeOriginals.get(element);
    if (!saved) {
      saved = new Map();
      attributeOriginals.set(element, saved);
    }
    for (const name of attributes) {
      if (!element.hasAttribute(name)) continue;
      if (!saved.has(name)) saved.set(name, element.getAttribute(name));
      const source = saved.get(name);
      const next = translate(source);
      if (element.getAttribute(name) !== next) element.setAttribute(name, next);
    }
  }

  function translateTree(root = document.body) {
    if (root.nodeType === Node.ELEMENT_NODE && root.closest('[translate="no"]')) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeValue.trim()) translateNode(node);
    }
    if (root.nodeType === Node.ELEMENT_NODE) translateAttributes(root);
    for (const child of root.querySelectorAll?.('*') || []) translateAttributes(child);
  }

  function setLanguage(nextLanguage) {
    language = nextLanguage === 'de' ? 'de' : 'en';
    document.documentElement.lang = language;
    localStorage.setItem('photo-sorter-language', language);
    translateTree();
  }

  window.photoSorterI18n = Object.freeze({ setLanguage, translate });
  const savedLanguage = localStorage.getItem('photo-sorter-language');
  const initialLanguage = savedLanguage === 'de' || savedLanguage === 'en'
    ? savedLanguage : (navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en');
  setLanguage(initialLanguage);
  document.getElementById('language').value = initialLanguage;

  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') translateNode(record.target);
      for (const node of record.addedNodes || []) {
        if (node.nodeType === Node.TEXT_NODE && node.nodeValue.trim()) translateNode(node);
        else if (node.nodeType === Node.ELEMENT_NODE) translateTree(node);
      }
    }
  }).observe(document.body, { childList: true, characterData: true, subtree: true });
})();
