# WP01A: reproduzierbarer Paperclip-SDK-/Shared-Pin

Stand: 16. November 2026.

## Ergebnis

Paperclip M365 bindet den ersten WP01-Stand an die veröffentlichten Pakete `@paperclipai/plugin-sdk@2026.1106.0` und `@paperclipai/shared@2026.1106.0` sowie an das öffentliche Paperclip-Tag `v2026.1106.0`. Das Tag zeigt auf den sauberen Commit `d69631b01b9c658f80bf8bed389863dce82643e1`. Die vollständige synthetische WP00-Probe ist gegen die aus der Registry installierte SDK-Ausgabe und die Hostvalidatoren dieses Commits grün.

Der frühere lokale Dirty-Checkout `c645b7795b5665eaafb3a30fe23e2deb0811dc6e` bleibt historische WP00-Evidenz, ist aber kein WP01-Pin mehr. Es wurde kein Featurecode, Manifest, Worker, UI-Scaffold, Plugininstallationsversuch oder Paperclip-Core-Änderung begonnen.

## Quellen-, Pin- und Integritätstabelle

| Artefakt | Quelle und exakter Pin | Integritätsnachweis | Verwendung |
| --- | --- | --- | --- |
| Paperclip-Quelle | `https://github.com/paperclipai/paperclip.git`, Tag `v2026.1106.0`, Commit `d69631b01b9c658f80bf8bed389863dce82643e1`, Tree `1955a72d50a89ef05295791948b78c93e36615a6` | leerer tracked Diff `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`; relevante Dateihashes in `expected-host-fingerprint.json` | Hostvalidatoren, SDK-Quelltests und reproduzierbarer Buildpfad |
| Quell-Lock | `pnpm-lock.yaml` aus demselben Commit; `pnpm@9.15.4` | SHA-256 `242f0f08eb06fb2add28773f85a91d5e00a7ff8d71288d2d12a1163bee62d4e5` | vollständige Quellwiederherstellung mit `--frozen-lockfile` |
| Plugin SDK | npm `@paperclipai/plugin-sdk@2026.1106.0` | `sha512-dmRBcyEIsqKAxBfrqwVGNxnARCwsGCt2bhrch49E0jhGzo0wwn501W9B3YADggSTSbm81FxMu8/G9z/jDrNeKA==` | tatsächlich von der 20er-Vertragsprobe geladenes `dist`-Artefakt |
| Shared | npm `@paperclipai/shared@2026.1106.0`, vom SDK exakt verlangt | `sha512-fleBeHYbmnwdvEuzyQ4ABUFbHzqft47ni/ZktF1jWQsFkyfHmHBz5xFm3nfD3WZQ9UGnVZmXfEhfk+nizpeGEQ==` | transitive SDK-Laufzeitabhängigkeit |
| Registry-Transitive | `three@0.185.1`, `zod@4.6.7` | vollständige `resolved`-/`integrity`-Einträge in `experiments/wp00/registry-pin/package-lock.json` | deterministischer `npm ci`-Stand |
| Test-Runner | `tsx@4.23.15` aus dem Quell-Lock | SHA-256 der Paketmetadaten und CLI im Fingerprint | TypeScript-Ausführung der WP00-Probe |

Der öffentliche Quellbaum führt intern weiterhin SDK `1.0.0` und Shared `0.3.1`; die Release-Pipeline veröffentlicht beide als `2026.1106.0`. Deshalb prüft der Fingerprint Quell- und veröffentlichte Version getrennt. Registry-Metadaten enthalten für diese Version kein `gitHead`; die Kompatibilität wird nicht daraus abgeleitet, sondern durch die Probe mit dem installierten Registry-SDK plus den exakt gepinnten Hostvalidatoren nachgewiesen.

## Frische Wiederherstellung

Die positive Probe verwendete zwei zuvor nicht vorhandene Verzeichnisse und keinen bestehenden `node_modules`-Stand:

```powershell
git clone --filter=blob:none --no-checkout https://github.com/paperclipai/paperclip.git F:\tmp\hum282-pin\src
git -C F:\tmp\hum282-pin\src sparse-checkout init --cone
git -C F:\tmp\hum282-pin\src sparse-checkout set packages/plugins/sdk packages/shared packages/db packages/adapter-utils packages/google-sheets-mcp-server packages/mcp-server packages/adapters/claude-local packages/adapters/codex-local packages/adapters/cursor-local packages/adapters/hermes-gateway packages/adapters/hermes packages/adapters/openclaw-gateway packages/adapters/opencode-local packages/adapters/pi-local server scripts patches ui cli
git -C F:\tmp\hum282-pin\src checkout d69631b01b9c658f80bf8bed389863dce82643e1
corepack pnpm@9.15.4 install --dir F:\tmp\hum282-pin\src --frozen-lockfile

New-Item -ItemType Directory F:\tmp\hum282-registry
Copy-Item experiments\wp00\registry-pin\package*.json F:\tmp\hum282-registry
npm ci --ignore-scripts --prefix F:\tmp\hum282-registry
```

Ein Voll-Checkout beziehungsweise pnpm-Store unter dem langen Runner-Scratch-Prefix scheiterte auf Windows reproduzierbar mit `Filename too long` beziehungsweise `ENAMETOOLONG`. Der kurze Pfad und der Sparse-Checkout sind deshalb eine dokumentierte Windows-Buildvoraussetzung, keine Änderung an Commit oder Lockfile. Auf Dateisystemen ohne diese Grenze kann derselbe Commit vollständig ausgecheckt werden.

## Ausgeführte Prüfungen

| Prüfung | Ergebnis |
| --- | --- |
| Fingerprint für Repository, Tag, Commit, Tree, sauberen Diff, Quell-Lock, Registry-Lock, SDK/Shared-Integrity, Runner und relevante Dateien | PASS |
| `npm ci --ignore-scripts` aus dem Registry-Lock in leerem Verzeichnis | PASS, 4 Pakete installiert, Audit 0 Findings |
| PostgreSQL-17-Vertragsprobe mit installiertem Registry-SDK | PASS, 20/20 Assertions |
| Offline-Gateway-Negativprobe | PASS, `networkCalls: 0`, `dispatches: 0`, fünf Negativfälle fail closed |
| Typecheck der Vertragsprobe | PASS |
| SDK `testing-actions.test.ts` und `worker-rpc-host.test.ts` am Quell-Pin | PASS, 28/28 Tests |

Alle Prüfungen verwendeten ausschließlich synthetische Daten. Es gab keine Microsoft-Verbindung, keine echte Paperclip-Installation, keinen Host-Gateway-Aufruf, kein Deployment und keine Mutation außerhalb temporärer lokaler Testverzeichnisse.

## Restschätzung und kritischer Pfad

| Paket | Restaufwand | Annahme |
| --- | --- | --- |
| WP01 | 1–2 PT | Pin-Gate ist erledigt; Scaffold, Build, CI, Paketinhalt und isolierte Installationsprobe bleiben separat gesperrt bis Doppelreview. |
| WP02 | 4–6 PT | Tenant-Prüfung und MSAL-/Cache-Arbeit unverändert. |
| WP03 | 4–6 PT | Human-Entscheid, Auditkorrelation und separater Executor bleiben harte Gates. |
| WP04 | 3–4 PT | Graph-Transport und Betriebsmetriken unverändert. |
| WP05 | 2–3 PT | Mail-Lesepfad und Entwürfe unverändert. |
| WP06 | 2–3 PT | Versand-/Löschambiguität unverändert. |
| WP07 | 2–3 PT | Zeitzonen- und Kalenderkonkurrenz unverändert. |
| WP08 | 3–5 PT | 4-MiB-Grenzen, Speicher und OneDrive-Konflikte unverändert. |
| WP09 | 3–4 PT | vollständige serverseitige Autorisierungswiederholung unverändert. |
| WP10 | 4–5 PT | echte Agenten-/Hostintegration, Betriebsnachweise und unabhängige Reviews unverändert. |
| WP11 | 2–5 PT | Paket-, Restore-, Migrations-, Beobachtungs- und Rollbackdrill unverändert. |
| **WP01–WP11 gesamt verbleibend** | **30–46 PT** | ohne Tenant-/Admin-Wartezeit und optionale WP12–WP15 |

Kritischer Pfad: Doppelreview dieses Pins → restliches WP01-Scaffold → WP02, WP03 und WP04 → Funktionspakete WP05–WP08 → WP09 → WP10 → WP11. Neue technische Abhängigkeiten sind der kurze Windows-Buildpfad für den Paperclip-Monorepo-Quelltest und die getrennte Prüfung von Quell- und Releaseversion. Die Rücknahme besteht aus dem Revert dieses Nachweisstands; es wurden weder Pluginzustand noch Schema, Secrets oder externe Systeme verändert.
