# WP01A: reproduzierbarer Paperclip-SDK-/Shared-Pin

Stand: 16. November 2026.

## HUM-285-Korrekturstand

Der Reviewpfad ist jetzt als fail-closed Gate implementiert. `gate-lib.mjs` prüft vor Zielausführung den exakt leeren Output von `git status --porcelain=v1 --untracked-files=all`, Commit, Tag, Tree, Origin, Sparse-Checkout, zusätzliche Worktrees und Submodule. Die Registryerwartung bindet SDK, Shared, zod und three jeweils an Version, URL, SRI, vollständiges Inhaltsmanifest und alle vier direkten Abhängigkeitskanten. Tarball-SRI wird vor Extraktion geprüft; erst danach wird in den verwerfbaren Scratch extrahiert, der vollständige Baum erneut geprüft, read-only gesetzt und genau dessen `dist/index.js` importiert.

Der maßgebliche Review-/CI-Pfad ist `.github/workflows/wp01-isolated-gate.yml`. Seine Ausführungsbasis ist `postgres:17.7-bookworm@sha256:e9243ab06e47223dedeb3c129fa9ece8d37f506bdc6ee943afb9335f98bb4854`; Node kommt aus `node:24.22.1-bookworm@sha256:0925478b811e8890f5508ad2a75135933310effd45492696ecf7c111c8339d02`. Debian-Pakete werden ausschließlich aus Snapshot `20260203T000000Z` bezogen. npm, Corepack, pnpm und node-gyp werden über feste Registry-URLs plus SHA-256 installiert. `verify-linux-contract.mjs` prüft vor Zielcode Node 24.22.1, npm 11.19.1, Corepack 0.34.5, pnpm 9.15.4, Git 2.39.5, Python 3.11.2, PostgreSQL 17.7, GCC/G++ 12.2.0, Make 4.3 und node-gyp 12.1.0.

Der Aufbau läuft mit Netzwerk in einem frischen Checkout, leerem pnpm-Store und leerem npm-Cache. Erst danach startet ein neuer Container mit `--network none`, leerem `env -i`, read-only Root/Repository/Quelle/Tarballs/Paketbaum/PostgreSQL-Standardvolume, UID/GID 999, `--cap-drop ALL`, `no-new-privileges` und genau einem beschreibbaren `/scratch`-Bind. `/tmp` und `/var/lib/postgresql/data` werden durch Schreibproben als nicht beschreibbar nachgewiesen; `/dev/shm` ist read-only. Docker erzwingt 2 CPUs, 3 GiB Speicher ohne Swap, 128 PIDs, 1024 offene Dateien und 1 GiB Dateigröße; `ulimit` begrenzt zusätzlich 150 CPU-Sekunden und der äußere `timeout` 180 Sekunden Wallclock. PostgreSQL lauscht nur auf Loopback im netzlosen Container. Fehlt eine Grenze oder Version, startet beziehungsweise besteht kein Zielcode.

`run-isolated-gate.ps1`/bubblewrap bleibt ein lokaler zusätzlicher Negativ-/Artefaktpfad. Der frühere direkte Hostrunner ist deaktiviert; er darf den Zielcode nicht ausführen.

Die isolierte Negativmatrix besteht aus einer expliziten Liste von 31 eindeutigen Fällen: untracked/staged/unstaged, uninitialisiertes Submodul, Sparse-/Worktreeabweichung, falscher Commit/Tag, jedes Version-/URL-/Integrity-Feld aller vier Pakete, alle vier Kanten sowie für jedes der vier Pakete ein real veränderter Tarball und ein real veränderter vorbereiteter Inhaltsbaum. CI leitet Sollzähler und Namen aus dieser Liste ab und vergleicht beides exakt mit TAP. Jeder Fall prüft zusätzlich, dass Extraktion beziehungsweise Zielimport nicht ausgeführt wurde. Der positive isolierte Artefaktpfad bestand gegen einen vollständigen frischen Checkout.

Der maschinenlesbare Windows-Vertrag steht in `runner-contract.json`; `verify-runner-contract.ps1` prüft Node 24.22.1, npm 11.19.1, Corepack 0.34.5, pnpm 9.15.4, Git 2.47.1.windows.2, Python 3.14.0, PostgreSQL 17, VS 2022/MSVC 14.44.35207, Windows SDK 10.0.26100.0, mindestens 6 GiB plus 2 GiB Reserve und den expliziten VS-Developer-Command-Pfad. Der Negativtest schleust ausschließlich für `corepack --version` die abweichende Version 0.34.4 ein und verlangt einen fail-closed Exit. `fresh-source-install.ps1` verlangt nicht vorhandene feste Pfade unter `F:\w`, initialisiert VS x64, trennt pnpm-Store, npm-Cache und Node-Header 24.22.1 und bricht bei Abweichungen ab.

Windows produziert reproduzierbar ausschließlich zwei optionale Native-Fehler: `cpu-features@0.0.10` erkennt den Compiler nicht; der in `ssh2@1.17.0` ausdrücklich optionale Crypto-Build scheitert in MSBuild FileTracker. `install-log-policy.mjs` akzeptiert Native-Diagnosen nur innerhalb dieser gestarteten, versionsgebundenen Lifecycleblöcke und nur wenn Lock-Integrity sowie `ssh2 -> cpu-features@0.0.10`/`optional: true` stimmen. `verify-optional-fallback.mjs` weist anschließend nach, dass das ssh2-Native-Binding nicht geladen wurde, der erwartete cpu-features-Requireversuch nicht erfolgreich geladen wurde und kein anderer Aufrufer beteiligt war. `npm error`, `npm ERR!`, `ERR_PNPM`, unscoped `ELIFECYCLE` und `Command failed with exit code …` brechen auch innerhalb eines optionalen Blocks sofort ab. Jede andere `gyp`, MSBuild-, npm-, pnpm- oder Installabweichung bricht ebenfalls ab.

### Aktuelle Nachweise

Der repositorygebundene Linux-Lauf `43813001303` auf Commit `471b747c4b4fe2862de840ab2cd61382dfab1b0e` bestand als erster vollständiger Lauf. Er enthält im Audit-Artefakt den frischen Install, die Toolversionen, 25/25 Negativfälle, den SRI-/Manifest-geprüften read-only SDK-Import, PostgreSQL 20/20, Typecheck, SDK 28/28, Offline-Gateway 0/0 und die Install-Policytests. Der abschließende Lauf auf dem Übergabecommit ist Bestandteil der Reviewübergabe.

Der integrierte Windows-Fresh-Install bestand danach mit 1104,62 GiB frei/8 GiB gefordert, leerem Store/Cache/Headerpfad, 1337 frisch wiederhergestellten Paketen, sichtbarem Policy-PASS, Fallback-PASS, vorhandenem Node-24.22.1-Headerbaum und leerem Porcelain-Status. SHA-256 des Installlogs: `924b2cda372dabe472002f0081020f1801b781492732071f929a344f888d9087`.

Trust Boundary: GitHub-hosted Ubuntu-Runner und Docker-Daemon sind vertrauenswürdige Orchestrierung. Netzwerk ist nur beim Image-/Quell-/Artefaktaufbau erlaubt; SRI, Inhaltsmanifest und vollständige Zieltests laufen danach offline. Die Grenzen beweisen keine Abwehr gegen einen kompromittierten GitHub-Host oder Docker-Daemon. Es gab keinen lokalen Docker-Desktop-Start, keine Systeminstallation, keine Paperclip-/Microsoft-Integration und keinen Zugriff auf echte Konten.

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
