# WP01A: reproduzierbarer Paperclip-SDK-/Shared-Pin

Stand: 16. November 2026.

## HUM-285-Korrekturstand

Der Reviewpfad ist jetzt als fail-closed Gate implementiert. `gate-lib.mjs` prüft vor Zielausführung den exakt leeren Output von `git status --porcelain=v1 --untracked-files=all`, Commit, Tag, Tree, Origin, Sparse-Checkout, zusätzliche Worktrees und Submodule. Die Registryerwartung bindet SDK, Shared, zod und three jeweils an Version, URL, SRI, vollständiges Inhaltsmanifest und alle vier direkten Abhängigkeitskanten. Tarball-SRI wird vor Extraktion geprüft; erst danach wird in den verwerfbaren Scratch extrahiert, der vollständige Baum erneut geprüft, read-only gesetzt und genau dessen `dist/index.js` importiert.

`run-isolated-gate.ps1` startet den Zielpfad über WSL2 und bubblewrap mit getrennten User-, PID-, Netzwerk-, IPC- und UTS-Namespaces, leerer Environment-Allowlist, read-only Root/Repository/Quelle/Toolchain und genau einem beschreibbaren Scratch-Mount. `prlimit` und `timeout` erzwingen 150 CPU-Sekunden, 3 GiB virtuellen Adressraum, 128 Prozesse, 1024 offene Dateien, 1 GiB Dateigröße und 180 Sekunden Wallclock. Ist WSL2, bubblewrap, prlimit, timeout oder Node 24.22.1 nicht verfügbar, startet kein Zielcode.

Die isolierte Negativmatrix besteht aus 25 Fällen: untracked/staged/unstaged, uninitialisiertes Submodul, Sparse-/Worktreeabweichung, falscher Commit/Tag, fehlendes oder SRI-verändertes Artefakt, jedes Version-/URL-/Integrity-Feld aller vier Pakete, alle vier Kanten und ein real verändertes `dist/index.js`. Jeder Fall prüft zusätzlich, dass der Zielmarker nicht ausgeführt wurde. Der positive isolierte Artefaktpfad bestand gegen einen vollständigen frischen Checkout.

Der maschinenlesbare Windows-Vertrag steht in `runner-contract.json`; `verify-runner-contract.ps1` prüft Node 24.22.1, npm 11.19.1, pnpm 9.15.4, Git 2.47.1.windows.2, Python 3.14.0, PostgreSQL 17, VS 2022/MSVC 14.44.35207, Windows SDK 10.0.26100.0, mindestens 6 GiB plus 2 GiB Reserve und den expliziten VS-Developer-Command-Pfad. `fresh-source-install.ps1` verlangt nicht vorhandene feste Pfade unter `F:\w`, initialisiert VS x64, trennt pnpm-Store, npm-Cache und Node-Header 24.22.1 und bricht bei Abweichungen ab.

### Noch blockierendes Plattformgate

Der vollständige Linux-x64-Folgelauf ist **nicht bestanden**: Die vorhandene WSL2-Distribution kann die Isolation erzwingen, enthält aber noch kein PostgreSQL 17 und keinen vollständig gepinnten Linux-Buildtoolstand. Daher werden PostgreSQL 20/20, Typecheck und SDK 28/28 in diesem Korrekturlauf nicht als isoliert grün behauptet. Der WP01-Scaffold bleibt entsprechend gesperrt. Docker Desktop ist installiert, die Engine war jedoch gestoppt und wurde nicht eigenmächtig neu gestartet.

## Ergebnis des ursprünglichen Pins

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

## Ausgeführte Prüfungen des ursprünglichen Pins

| Prüfung | Ergebnis |
| --- | --- |
| Fingerprint für Repository, Tag, Commit, Tree, sauberen Diff, Quell-Lock, Registry-Lock, SDK/Shared-Integrity, Runner und relevante Dateien | PASS |
| `npm ci --ignore-scripts` aus dem Registry-Lock in leerem Verzeichnis | PASS, 4 Pakete installiert, Audit 0 Findings |
| PostgreSQL-17-Vertragsprobe mit installiertem Registry-SDK | PASS, 20/20 Assertions |
| Offline-Gateway-Negativprobe | PASS, `networkCalls: 0`, `dispatches: 0`, fünf Negativfälle fail closed |
| Typecheck der Vertragsprobe | PASS |
| SDK `testing-actions.test.ts` und `worker-rpc-host.test.ts` am Quell-Pin | PASS, 28/28 Tests |

Diese ursprünglichen Prüfungen verwendeten ausschließlich synthetische Daten. Sie sind historische Hostnachweise und werden nicht als isolierter HUM-285-Gesamtlauf umgedeutet. Es gab keine Microsoft-Verbindung, keine echte Paperclip-Installation, keinen Host-Gateway-Aufruf oder Deployment.

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
