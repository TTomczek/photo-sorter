(() => {
  const german = new Map(Object.entries({
    'Your library stays on this computer.': 'Deine Bibliothek bleibt auf diesem Computer.',
    'Install app': 'App installieren',
    'Log out': 'Abmelden',
    'Local-network HTTP is not encrypted. Use only on a trusted LAN; never expose this service directly to the internet.':
      'HTTP im lokalen Netzwerk ist nicht verschlüsselt. Nur in einem vertrauenswürdigen LAN verwenden und niemals direkt dem Internet aussetzen.',
    'Password': 'Passwort',
    'Continue': 'Weiter',
    'Collection': 'Sammlung',
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
    'Use ←/swipe left for Delete, →/swipe right for Keep, and ↓/swipe down for Unsure. These actions only save a decision; they never move or delete a file.':
      '←/nach links wischen bedeutet Löschen, →/nach rechts wischen bedeutet Behalten und ↓/nach unten wischen bedeutet Unsicher. Diese Aktionen speichern nur eine Entscheidung und verschieben oder löschen keine Datei.',
    'Use the zoom controls or pinch on an image to zoom; drag a zoomed image to pan. Scroll the collection grid to browse large libraries.':
      'Verwende die Zoom-Steuerung oder ziehe zwei Finger auf einem Bild auseinander, um es zu vergrößern. Ziehe ein vergrößertes Bild zum Verschieben. Scrolle im Sammlungsraster, um große Bibliotheken zu durchsuchen.',
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
    'Use at least 12 characters. This password protects access to your local library.':
      'Verwende mindestens 12 Zeichen. Dieses Passwort schützt den Zugriff auf deine lokale Bibliothek.',
    'Set password': 'Passwort festlegen',
    'Cannot reach the local host': 'Der lokale Host ist nicht erreichbar',
    'Authentication required.': 'Anmeldung erforderlich.',
    'Incorrect password.': 'Falsches Passwort.',
    'Too many attempts. Try again later.': 'Zu viele Versuche. Bitte später erneut versuchen.',
    'Use a password of at least 12 characters.': 'Verwende ein Passwort mit mindestens 12 Zeichen.',
    'Password setup has already been completed.': 'Die Passworteinrichtung wurde bereits abgeschlossen.',
    'Collection not found.': 'Sammlung nicht gefunden.',
    'Root not found.': 'Ordner nicht gefunden.',
    'Media item not found.': 'Medienelement nicht gefunden.',
    'Invalid settings.': 'Ungültige Einstellungen.',
    'Invalid category.': 'Ungültige Kategorie.',
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
    'apply_completed': 'Anwendung abgeschlossen',
    'apply_failed': 'Anwendung fehlgeschlagen',
    'apply_recovered': 'Anwendung wiederhergestellt',
    'restore_completed': 'Wiederherstellung abgeschlossen',
    'passkey_added': 'Passkey hinzugefügt',
    'passkey_removed': 'Passkey entfernt',
    'audit_cleared': 'Audit-Protokoll geleert',
    'No items in this category.': 'Keine Elemente in dieser Kategorie.',
    'No items in this collection.': 'Keine Elemente in dieser Sammlung.',
    'Loading items…': 'Elemente werden geladen…',
    'Preview unavailable. This file can still be sorted.': 'Vorschau nicht verfügbar. Diese Datei kann trotzdem sortiert werden.',
    'Video preview unavailable. This file can still be sorted.':
      'Videovorschau nicht verfügbar. Diese Datei kann trotzdem sortiert werden.',
    'No LAN IPv4 address is currently available.': 'Derzeit ist keine LAN-IPv4-Adresse verfügbar.',
    'Remove': 'Entfernen',
    'Restore': 'Wiederherstellen',
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
    'Save settings.': 'Einstellungen gespeichert.',
    'Settings saved.': 'Einstellungen gespeichert.',
    'Sign-in startup setting updated.': 'Autostart-Einstellung aktualisiert.',
    'Folder registered; scanning has started.': 'Ordner registriert; der Scan wurde gestartet.',
    'Confirm reuse of the existing deleted/unsure folders before applying.':
      'Bestätige vor dem Anwenden die Wiederverwendung der vorhandenen Ordner „deleted“/„unsure“.',
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
