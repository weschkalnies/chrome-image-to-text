# Entwicklerdokumentation

Diese Verzeichnis ist der einzige versionierte Ablageort für Dokumentation,
die Entwicklung, Architektur, Sicherheit, Tests oder Releases betrifft.
Solche Dokumente gehören nicht nach `src/`, `deploy/` oder `tests/`, damit sie
nicht Teil der auslieferbaren Erweiterung oder generierter Build-Artefakte
werden.

## Dokumente

- [Projektüberblick](project_overview.md) – Architektur und zentrale
  Projektentscheidungen.
- [Projekt-Wissensbasis](PROJECT_KNOWLEDGE.md) – Kontext und bekannte
  Fallstricke für die Weiterentwicklung.
- [Sicherheits-Audit](SECURITY_AUDIT.md) – Bedrohungsmodell, Maßnahmen und
  verbleibende Risiken.
- [Implementierungsbericht](IMPLEMENTATION_REPORT.md) – aktueller technischer
  Stand und Verifikationsschritte.
- [Tesseract-Vendor-Dateien](TESSERACT_VENDOR.md) – Herkunft und Update-
  Prozedur der lokalen OCR-Ressourcen.
- [Verbesserungsplan](improvements-plan.md) – priorisierte technische
  Verbesserungen und ihr Status.
- [Ursprüngliche Spezifikation](chrome_ocr_extension_spec.md) – historischer
  Ausgangspunkt des Projekts.

## Regel für neue Dokumentation

Neue Entwicklerdokumentation wird als Markdown-Datei in `docs/` angelegt und
von der Root-[README](../README.md) oder diesem Index aus verlinkt. Laufzeit-
und Nutzungsinformationen, die mit der entpackten Erweiterung ausgeliefert
werden sollen, dürfen dagegen bei `src/README.md` bleiben.
