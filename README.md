# KnockDoc

**Revir kapısından hekime: QR ile geliş bildirimi ve hekim yanıtı.**

İşyeri reviri için sade bir haberleşme uygulaması. Çalışan, revir kapısında hekimi bulamadığında QR kodu okutup tek dokunuşla geldiğini bildirir. Hekim telefonuna gelen bildirimle haberdar olur ve kısa bir yanıt yazar. Çalışan yanıtı aynı sayfada görür.

Ad, hekimin kapısını çalmaktan (*knock*) gelir. Uygulamanın ekranlarında **Revir Haberleşme** adıyla görünür.

> Bu depo, bir işyerinde gerçekten kullanılan uygulamanın **anonimleştirilmiş** sürümüdür. Kişi, kurum, telefon, e-posta, acil hat ve hesap bilgileri örnek değerlerle değiştirilmiştir. Uygulama klinik kayıt veya tanı sistemi değildir.

## Nasıl çalışır

1. Çalışan kapıdaki QR kodu okutur ve **Geldiğimi doktora bildir** düğmesine dokunur. Hesap, isim veya telefon gerekmez.
2. Hekimin telefonuna bir bildirim gider, örneğin **Pzt-3 yeni geliş bildirdi. (16.11)**. Bildirimde isim, telefon veya not bulunmaz.
3. Hekim kendi ekranından hazır bir yanıt seçer ya da kısa bir yanıt yazar.
4. Çalışan yanıtı açık sayfada yaklaşık 10 saniye içinde görür. Ardından **Burada bekliyorum** ya da **Ayrıldım, sonra geleceğim** seçeneğine dokunur; bu seçim de hekime bildirilir.

## Öne çıkan özellikler

- Tek dokunuşla geliş bildirimi; not, isim ve telefon isteğe bağlıdır.
- Her gün yeniden başlayan anonim takip kodları (Pzt-1, Pzt-2…). Gün sınırı İstanbul saatine göre belirlenir.
- Bağlantı koparsa işlem güvenle yeniden denenebilir: aynı işlem ikinci bir kayıt ya da ikinci bir bildirim üretmez.
- Hekim için iPhone ana ekranına eklenebilen bir web uygulaması ve şifreli telefon bildirimi (Web Push).
- Haftalık çalışma saatleri, **Bugün talep alımını kapat** düğmesi, tahmini dönüş saati ve hekim notu.
- Çalışan mevcut talebine kısa bir mesaj ekleyebilir; uygulamayla ilgili görüş ve hatalar için ayrı bir alan vardır.
- Telefona uygun arayüz: büyük düğmeler, kısa metinler, dar ekranlarda taşmayan düzen.

## Gizlilik ve güvenlik

- Çalışan hesabı yoktur. Talepler tarayıcı oturumuna bağlıdır ve 7 gün sonra silinir.
- Telefon bildirimi yalnız anonim kodu, günü ve olay türünü taşır; içerik cihazın kendi anahtarıyla şifrelenir.
- Hekim şifresi sunucuda saklanmaz; yalnız gizli bir sunucu anahtarıyla (pepper) hesaplanan HMAC doğrulama değeri tutulur. Hekim oturumu en fazla 8 saat sürer. Değişiklik yapan her istek CSRF ve aynı kaynak denetiminden geçer; giriş denemeleri sınırlandırılır.
- Sıkı güvenlik başlıkları kullanılır (CSP, çerçeve içine gömme engeli). Servis çalışanı özel veriyi çevrimdışı önbelleğe almaz.
- Ekranda kimlik numarası, tanı veya özel sağlık bilgisi yazılmaması istenir.

## Teknik yapı

| Bölüm | Kullanılan | Dosyalar |
| --- | --- | --- |
| Sunucu | Cloudflare Workers | `src/worker.mjs`, `src/store.mjs`, `src/rules.mjs`, `src/auth.mjs` |
| Veritabanı | Cloudflare D1 (SQLite) | `schema.sql` |
| Arayüz | Çerçevesiz HTML, CSS ve JavaScript | `public/` |
| Telefon bildirimi | Service Worker ve Web Push (RFC 8291 / RFC 8292), harici kütüphane yok | `public/sw.js`, `src/push.mjs`, `src/webpush-payload.mjs` |
| Temizlik | 15 dakikada bir çalışan zamanlanmış görev | `wrangler.jsonc` |

Çalışırken kullandığı hiçbir paket bağımlılığı yoktur; geliştirme için yalnız Wrangler ve Miniflare gerekir. Uygulama Cloudflare'in ücretsiz Workers ve D1 kotaları içinde çalışacak şekilde tasarlandı ve kart gerektirmez. Kotalar ve hizmet sürekliliği sağlayıcının koşullarına bağlıdır.

## Testler

235 otomatik test vardır ve `npm test` komutuyla çalışır. Testler bilgisayardaki yerel bir D1 kopyasını (Miniflare) kullanır; internete veya canlı bir hesaba bağlanmaz.

## Kurulum

Kodu kendi kurumunuzda kullanmak için yazılı izin gerekir (bkz. [LICENSE](LICENSE)). Aşağıdaki adımlar yapıyı incelemek ve izinli kurulum içindir. Node.js 22 veya üzeri gerekir.

```sh
npm ci
npm test
```

Örnek değerlerin yerine kendi bilgilerinizi yazmanız gereken yerler:

- `public/app.js`: `officialContact` (hekim adı, telefon, e-posta), WhatsApp bağlantısı ve `emergencyMarkup` içindeki acil hat bilgisi.
- `public/index.html`: alt bilgideki imza.
- `wrangler.jsonc`: `database_id` (kendi D1 veritabanınız) ve `DOCTOR_EMAIL`.
- `scripts/setup-push-key.mjs`: `VAPID_SUBJECT` e-postası.

Yayın adımları:

1. `npx wrangler login`
2. `npx wrangler d1 create revir-haberlesme --jurisdiction eu` komutunun verdiği kimliği `wrangler.jsonc` dosyasına yazın.
3. `npx wrangler d1 execute revir-haberlesme --remote --file=./schema.sql`
4. `node scripts/setup-doctor-key.mjs --ilk-kurulum` komutu hekim şifresini ve bildirim anahtarlarını oluşturur. Bu dosyalar depo klasörünün iki üst klasöründeki `work/` içinde oluşur. Onları paylaşmayın, Git'e eklemeyin ve güvenli bir yerde yedekleyin. Komutu yalnız ilk kurulumda bir kez çalıştırın: sonradan üretilen yeni bir anahtar hekim girişini ve telefon bildirimlerini geçersiz kılar.
5. `npm run build` ile yayın paketini denetleyin, ardından `npm run deploy` ile yayımlayın.
6. Hekim ekranı adresin sonuna `/doktor` eklenerek açılır. iPhone'da Safari'de **Paylaş → Ana Ekrana Ekle** yolunu izleyin, ana ekrandaki simgeden giriş yapın ve **Bildirimleri aç** düğmesine dokunun.

`migrations/` klasörü eski kurulumların güncellenmesi içindir. Yeni bir kurulumda yalnız `schema.sql` kullanılır.

## Sınırlar

- Uygulama acil durum aracı değildir. Bildirimler gecikebilir veya hiç ulaşmayabilir.
- Çalışanın telefonuna bildirim gitmez; çalışan yanıtı yalnız sayfa açıkken görür.
- Ücretsiz plan kotaları ve sağlayıcı kesintileri hizmeti etkileyebilir.
- Kişisel verilerin korunması (KVKK) ve veri aktarımı değerlendirmesini kurumunuzun ayrıca yapması gerekir.

## Geliştirme yöntemi

Fikir, gereksinimler, kullanım akışı, ekran metinleri ve gerçek kullanım denemeleri işyeri hekimi Dr. Mehmet Faruk Uçum'a aittir. Kod, onun yönlendirmesi ve onayıyla yapay zekâ kodlama araçlarına (OpenAI Codex ve Anthropic Claude) yazdırılmıştır.

## Haklar

© 2026 Dr. Mehmet Faruk Uçum. Tüm hakları saklıdır. Ayrıntılar için [LICENSE](LICENSE) dosyasına bakın.

---

## English summary

KnockDoc lets an employee knock on the door of an unattended workplace clinic without a single word typed. They scan a QR code at the door and report their arrival with one tap. The physician gets an encrypted phone notification that carries only an anonymous daily code, sends a short reply, and the employee sees it on the same page.

This repository is an anonymized version of an app in real use; people, organization, contact and account details have been replaced with placeholders. It runs on Cloudflare Workers, D1, plain HTML/CSS/JavaScript and Web Push, with no runtime dependencies, and includes 235 automated tests.

The idea, requirements, user flow and real-world testing are by occupational physician Dr. Mehmet Faruk Uçum; the code was written with AI coding tools (OpenAI Codex and Anthropic Claude) under his direction. © 2026 Dr. Mehmet Faruk Uçum. All rights reserved; see [LICENSE](LICENSE).
