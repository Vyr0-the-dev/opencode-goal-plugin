# opencode-goal-plugin

Persistent, evidence-checked goals for OpenCode — the `/goal` feature.

A prompt asks for one result and waits. A **goal** gives the agent one durable
objective and lets it keep working until that objective is verifiably true, or
until it is honestly blocked. It is the same idea as `/goal` in OpenAI Codex
(0.128.0+), Claude Code, and Hermes, built on OpenCode v2's native plugin API.

You drive it with `/goal`. OpenCode itself drives it with the `goal_create`,
`goal_status`, and `goal_update` tools. Neither can touch another session's
goal, and a goal never widens the authority your permissions already granted.

---

## Kurulum (Installation)

### macOS, Linux, WSL ve Git Bash (POSIX)
```sh
sh install.sh
```

### Windows PowerShell
```powershell
.\install.ps1
```

### Windows Command Prompt (`cmd.exe`)
```cmd
install.cmd
```

Her installer scripti paketi global OpenCode eklentiler dizinine (`~/.config/opencode/plugins/opencode-goal-plugin` veya `$XDG_CONFIG_HOME/opencode/plugins/...`) kurar, TUI bağımlılıklarını (`solid-js`, `@opentui/*`) OpenCode yapılandırmasının `node_modules` dizinine kopyalar ve eski tek dosyalık loader kalıntılarını temizler.

Yeniden çalıştırmak kopyayı tazeler; dizini silmek eklentiyi kaldırır. `opencode reload` ile sunucu yarısı, TUI'yi yeniden başlatınca terminal yarısı yüklenir.

### Neden Bir Dizin Olarak Kurulur?

OpenCode bir eklenti paketinin `exports` hedeflerini **paket köküne göre** çözümler. Bu mimari nedeniyle:
* Tek dosyalık bir loader (`goal.ts`) sadece sunucu yarısını yükleyebilir; yanındaki paket haritası olmadığı için host `./tui` hedefini çözümleyemez ve terminal arayüzü sessizce devre dışı kalır.
* Entrypoint'leri doğrudan `./src` veya `./dist` altında olan paketler host tarafından atlanır.

Bu nedenle eklenti kök dizininde `index.js`, `tui.tsx` ve `rpc.ts` re-export shim dosyaları yer alır.

Eklentinin devrede olduğunu doğrulamak için:
```sh
opencode api get /api/plugin
```
`opencode.goal` girdisinin `{"server": true, "tui": true, "rpc": true}` döndüğünü doğrulayabilirsiniz.

---

## Desteklenen Ortamlar ve Platformlar

Eklentinin durum ve kontrol mantığı sunucu tarafında çalıştığı için OpenCode'un desteklediği tüm istemcilerde tutarlı çalışır:

| Ortam / Arayüz | `/goal` Komutu | `goal_*` Araçları | Durum Takibi | Ek Terminal UI |
| --- | --- | --- | --- | --- |
| **OpenCode TUI** | Evet | Evet | RPC + Transkript | Durum rozeti, ilerleme çubuğu, dashboard panel (`<leader>p`), klavye katmanı |
| **Web Arayüzü** | Evet | Evet | RPC + Transkript | — |
| **Masaüstü Uygulaması** | Evet | Evet | RPC + Transkript | — |
| **IDE Eklentileri (VS Code, Cursor)** | Evet | Evet | RPC + Transkript | — |
| **ACP İstemcileri (Zed, vb.)** | Evet | Evet | RPC + Transkript | — |
| **`opencode run` (Headless/CI)** | Evet | Evet | RPC + Transkript | Non-interactive ve TTY fallback |
| **`opencode mini`** | Evet | Evet | RPC + Transkript | — |
| **Üçüncü Parti API İstemcileri** | Evet | Evet | RPC + Transkript | — |

### Platformlar ve Shell Desteği
* **İşletim Sistemleri:** macOS (Intel/Apple Silicon), Linux (x64/arm64), Windows 10/11 (x64/arm64)
* **Shell'ler:** Bash, Zsh, Fish, PowerShell 5.1/7+, Windows Command Prompt (`cmd.exe`)
* **Terminal Uyumluluğu:**
  - Modern terminaller (Windows Terminal, iTerm2, WezTerm, Alacritty, VS Code Terminal): Tam Unicode blok karakterleri (`█` / `─`).
  - Sınırlı / Eski terminaller (`TERM=dumb`, legacy console): Otomatik ASCII fallback (`#` / `-`).
  - Dar terminaller (< 70 sütun): Kompakt composer satırı ve dinamik daraltılmış ilerleme çubuğu.
  - CI / Pipe / Non-interactive: `NO_COLOR` standartlarına tam uyum ve kontrollü loglama (ekran bozulmasını engelleme).

---

## Kullanım Rehberi

### Temel Komut
```
/goal Reduce p95 checkout latency below 120 ms, verified by the checkout
      benchmark, while keeping the correctness suite green. Use only the
      checkout service and its tests. Between iterations, record what changed,
      what the benchmark showed, and the next best experiment. If the benchmark
      cannot run, stop and report the blocker.
```

Bu metin hem görevi hem de tamamlanma koşulunu (finish line) belirler. Oturum boşta kaldığında hedef aktif ve bütçe dahilindeyse ajan otomatik olarak uyandırılır, kanıtları denetler ve bir sonraki adımı yürütür.

### Komut Tablosu

| Komut | Açıklama |
| --- | --- |
| `/goal <hedef>` | Hedefi başlatır (veya değiştirir) ve çalışmaya başlar |
| `/goal` veya `/goal status` | Mevcut hedefi, sözleşmeyi, kalan bütçeyi ve defteri gösterir |
| `/goal pause` (veya `stop`) | Döngüyü duraklatır; hedef metni ve ilerleme korunur |
| `/goal resume` (veya `continue`) | Duraklatılmış hedefi kaldığı yerden devam ettirir |
| `/goal clear` (veya `reset`) | Hedefi oturumdan tamamen kaldırır |
| `/goal history` | İlerleme defterini (ledger) ve durum geçişlerini listeler |
| `/goal edit <yeni metin>` | Hedef sözleşmesini koruyarak sadece hedef cümlesini günceller |
| `/goal budget <sayı>` | Otomatik tur bütçesini günceller |
| `/goal draft <konu>` | Modellerin güçlü bir hedef sözleşmesi taslağı yazmasını sağlar |
| `/goal help` | Yardım ve kullanım detaylarını listeler |

Bir yaşam döngüsü kelimesi (`pause`, `stop`, `clear`, vb.) yalnızca girdinin **tamamı** olduğunda komut sayılır. Bu sayede hedef metniniz herhangi bir kelimeyle başlayabilir:
```
/goal stop the flaky checkout test     <- Yeni hedef başlatır
/goal stop                             <- Mevcut hedefi duraklatır
```

### Sözleşme Bayrakları (Flags)

| Bayrak | Anlamı |
| --- | --- |
| `--turns N` | Otomatik tur bütçesi (varsayılan: 25) |
| `--minutes N` | Duvar saati tavan süresi (dakika, varsayılan: 180) |
| `--verify "…"` | Doğrulama yüzeyi: sonucu kanıtlayan test, benchmark veya komut |
| `--constraints "…"` | Gerilememesi (regress etmemesi) gereken kriterler |
| `--boundaries "…"` | Kapsam dahilindeki dosya, servis veya veri sınırları |
| `--iterate "…"` | Her denemeden sonraki adım seçim kuralı |
| `--blocked "…"` | Hangi koşulda devam etmeyip kullanıcıya rapor verileceği |
| `--no-start` | Hedefi oturuma kurar ancak hemen bir model turu başlatmaz |
| `--no-continue` | Hedefi aktif kurar ancak otomatik devam etmesini engeller |

---

## Terminal ve TUI Davranışı

1. **Footer Rozeti:** Prompt'un sağ alt footer alanında canlı durum: `GOAL 3/25`.
2. **Composer Üstü Satırı:**
   - Geniş ekran: `GOAL [██████──────] 3/25 turns · 12m/3h · Hedef Başlığı · <leader>p pause`
   - Dar ekran (< 70 sütun): `GOAL [███---] 3/25t · Hedef Başlığı`
   - ASCII terminaller: `GOAL [######------]`
3. **Dashboard Paneli (`<leader>p` veya komut paletinden *Goal: open dashboard*):**
   - `p`: Duraklat (pause)
   - `r`: Devam et (resume)
   - `R`: Yenile (refresh)
   - `c`: Hedefi temizle (clear)
   - `f`: Tam ekran aç/kapat (fullscreen)
4. **Klavye Kısayolu:** Varsayılan `<leader>p` (`ctrl+x` ardından `p`). `cli.json` dosyasında özelleştirilebilir:
   ```json
   {
     "keybinds": {
       "opencode.goal.toggle": "<leader>o"
     }
   }
   ```

---

## Model Araçları (Model-facing Tools)

Model long-running hedefleri şu araçlarla yönlendirir:

* `goal_create`: Kullanıcı hedefi sohbet içinde tarif ettiğinde model tarafından hedefi oluşturmak için kullanılır.
* `goal_status`: Aktif hedefi, kalan bütçeyi ve son adımları okur (salt okunur).
* `goal_update`: İlerlemeyi kaydeder (`working`), kanıt sunarak tamamlar (`complete`), veya engel durumunu bildirir (`blocked`). Kanıt olmadan tamamlama veya engel sebebi belirtilmeden bloklama reddedilir.

---

## RPC Arayüzü

Eklenti, tüm istemcilerin hedefi yönetebilmesi için standart bir RPC arayüzü sunar:

```ts
import { OpenCode } from "@opencode/client"
import { GoalRpc } from "opencode-goal-plugin/rpc"

const client = OpenCode.make({ baseUrl: "http://localhost:4096" })
const api = client.rpc(GoalRpc)

// Hedef durumunu oku
const status = await api.get({ sessionID: "ses_123" })

// Hedefi duraklat veya devam ettir
await api.act({ sessionID: "ses_123", action: "pause", origin: "external" })

// Değişiklikleri dinle
api.events.on("changed", (event) => {
  console.log(`Oturum ${event.data.sessionID} durumu: ${event.data.status}`)
})
```

---

## Konfigürasyon (`goal.config.json`)

Seçenekler `goal.config.json` dosyasından veya yerel override için `goal.config.local.json` dosyasından okunur. Ayrıca `opencode.json(c)` içindeki plugin `options` alanı en yüksek önceliğe sahiptir.

```json
{
  "enabled": true,
  "commandName": "goal",
  "defaultMaxTurns": 25,
  "defaultMaxMinutes": 180,
  "continuationDelayMs": 750,
  "pauseOnInterrupt": true,
  "skipAgents": ["plan"],
  "injectGoal": true,
  "maxNotes": 40,
  "maxNoToolStreak": 2,
  "postLifecycleNotices": true,
  "mirrorToSessionMetadata": true,
  "answerLifecycleImmediately": true
}
```

---

## Geliştirme, Test ve Kalite Kontrolleri

Projede Bun ve TypeScript kullanılmaktadır.

```sh
# Bağımlılıkları yükle
bun install

# Tip kontrolü (TypeScript strict mode)
bun run typecheck

# Lint kontrolü
bun run lint

# Birim, entegrasyon ve terminal testleri (258+ test)
bun test

# Dağıtım ve paketleme smoke testleri
bun run smoke

# Sunucu bundle'ını derle
bun run build

# Tüm yayın öncesi adımları doğrula
bun run prepublishOnly
```

### CI/CD Doğrulaması
GitHub Actions iş akışı (`.github/workflows/ci.yml`), Ubuntu, macOS ve Windows runner'ları üzerinde:
- Bağımlılık kurulumu
- Typecheck & Lint
- Test paketinin tamamı
- Build derlemesi
- Smoke testleri
- `npm pack --dry-run` paketleme denetimini
otomatik olarak yürütür.

---

## Bilinen Sınırlamalar ve Sorun Giderme

1. **Session Metadata Yansıtma (OpenCode 2.0.16):**
   - OpenCode 2.0.16 sürümünde `session.update({ metadata })` çağrısı host tarafından sessizce göz ardı edilebilir. Eklenti her yazmayı doğrulayarak test eder; desteklenmiyorsa bir uyarı verip bu kanalı kapatır. Transkript ve RPC kanalları bu durumdan etkilenmez. Uyarıyı kapatmak için `"mirrorToSessionMetadata": false` yapabilirsiniz.
2. **Karakter Kodlama / Garip Karakter Sorunları:**
   - Eski Windows cmd konsollarında blok karakterler düzgün görünmüyorsa terminal Unicode desteklemiyor olarak algılanır ve ASCII moduna (`#` ve `-`) geçilir. Gerekirse `LANG=en_US.UTF-8` ayarlayabilir veya Windows Terminal kullanabilirsiniz.
3. **Session ID Güvenliği:**
   - Oturum kimlikleri path traversal (`..`, `/`, `\`) ve zararlı karakter denetiminden geçer; geçersiz kimliklerle yapılan çağrılar güvenli biçimde yok sayılır.

---

## Ek Dokümantasyon

* **Model & Sağlayıcı Uyumluluğu:** [`docs/providers.md`](docs/providers.md) (Claude, GPT, DeepSeek, Qwen ve katı şablonlu yerel LLM modelleri)
* **Uyumluluk Politikası:** [`docs/compatibility.md`](docs/compatibility.md) (Desteklenen çalışma zamanları, paket önbellekleme ve platform matrisi)
* **Güvenlik Politikası:** [`SECURITY.md`](SECURITY.md) (Güvenlik mimarisi, tehdit modeli ve güvenlik açığı bildirme süreci)

---

## Lisans

MIT

