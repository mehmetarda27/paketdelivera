# Delivera Paket Mobile App

`Delivera Paket`, sadece kuryeler icin hazirlanan Android WebView/Capacitor uygulamasidir. Mevcut kurye panelini bozmadan su adresi yukler:

```text
https://paketdelivera-1.onrender.com/courier.html
```

## Kurulum

```bash
npm install
npm run build
npm run mobile:sync
```

Android Studio ile `android/` klasorunu acin. Ilk acilista Gradle senkronizasyonunun bitmesini bekleyin.

## APK Alma

Debug APK icin:

```bash
cd android
./gradlew assembleDebug
```

Windows PowerShell icin:

```powershell
cd android
.\gradlew.bat assembleDebug
```

APK yolu:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Release APK/AAB icin Android Studio'da `Build > Generate Signed Bundle / APK` menusu kullanilir. Keystore dosyasini repo icine koymayin.

## URL Degistirme

Ana URL `capacitor.config.ts` icindeki `courierUrl` sabitinden degistirilir.

Degisimden sonra:

```bash
npm run mobile:sync
```

Uygulama icinde sadece asagidaki domainler WebView'de calisir:

```text
paketdelivera-1.onrender.com
google.com ve alt domainleri
google.com.tr ve alt domainleri
googleapis.com
gstatic.com
googleusercontent.com
firebaseio.com
firebaseapp.com
```

Rastgele dis linkler uygulama icinde acilmaz; Android'in guvenli dis uygulama/tarayici akisi ile acilir.

## Logo Degistirme

Mevcut ikon yesil/siyah Delivera Paket temali native vector kaynagidir:

```text
android/app/src/main/res/drawable/ic_delivera_paket_foreground.xml
android/app/src/main/res/drawable/ic_delivera_paket_monochrome.xml
```

Adaptif launcher ikonlari:

```text
android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml
android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml
```

Splash gorselleri Capacitor tarafindan `android/app/src/main/res/drawable*/splash.png` olarak uretilir. Yeni splash/ikon seti icin Android Studio `Image Asset` araci veya Capacitor asset pipeline kullanilabilir.

## Konum Izni

Manifest izinleri:

```text
ACCESS_FINE_LOCATION
ACCESS_COARSE_LOCATION
ACCESS_NETWORK_STATE
INTERNET
```

Uygulama acilisinda konum izni istenir. WebView icinde kurye paneli `navigator.geolocation` kullandiginda Capacitor'un geolocation izin akisi korunur. Kullanici izni kapatirsa mesai, GPS ve rota islemleri icin anlasilir uyari gosterilir.

## Bildirim Izni

Android 13 ve uzeri cihazlarda `POST_NOTIFICATIONS` izni uygulama acilisinda istenir.

Web paneli `Notification` API kullandiginda Android WebView icinde native bridge devreye girer ve bildirimi Android notification olarak gosterir. Bildirime basinca uygulama kurye panelini acar.

Uygulama kapaliyken veya arka planda server push almak icin Firebase Cloud Messaging kurulumu gerekir. Hazirlik adimlari:

1. Firebase Console'da Android app olusturun.
2. Paket adi olarak `com.delivera.paket` girin.
3. `google-services.json` dosyasini indirin.
4. Dosyayi `android/app/google-services.json` konumuna koyun.
5. Gerekli backend FCM bilgilerini production secret olarak tutun.

`.env.example` icindeki opsiyonel alanlar:

```text
FCM_PROJECT_ID=
FCM_VAPID_PUBLIC_KEY=
FCM_SERVICE_ACCOUNT_JSON=
```

FCM credentials repo icine commit edilmemelidir.

## Harita

Kurye panelindeki Google Maps linkleri Android'de once Google Maps uygulamasina gonderilir. Google Maps yuklu degilse cihazdaki tarayiciya duser.

Harita on izlemesi web panelde Google Maps Embed API ile calisir. API key:

```text
GOOGLE_MAPS_EMBED_API_KEY=
```

## Oturum Koruma

WebView'de JavaScript, DOM storage ve cookie destegi aciktir. Kurye login token/cookie/local storage verileri uygulama kapanip acildiginda korunur.

## Baglanti Yok Ekrani

Internet yoksa uygulama su mesaji gosteren native WebView hata ekranina duser:

```text
Internet baglantisi yok. Lutfen baglantinizi kontrol edin.
```

Ekranda `Tekrar dene` butonu vardir. Render free instance uyanirken sayfa yuklenene kadar WebView baglanmaya devam eder.

## Sik Hata Cozumleri

`Android SDK not found`

Android Studio'yu acip SDK Manager'dan Android SDK ve platform tools kurun. `ANDROID_HOME` veya `ANDROID_SDK_ROOT` ortam degiskenini kontrol edin.

`Gradle build failed`

Android Studio Gradle sync ekranindaki ilk hataya bakin. Java surumu, Android Gradle Plugin ve SDK lisanslari en sik sebeplerdir.

`Konum calismiyor`

Cihaz ayarlarindan uygulama konum iznini `Precise` / `Hassas` olarak acin. Emulator kullaniliyorsa emulator location ayarlarindan test koordinati gonderin.

`Bildirim gelmiyor`

Android 13+ icin bildirim iznini kontrol edin. Native push icin Firebase kurulumu ve backend FCM gonderimi tamamlanmis olmalidir.

`Haritada Ac` tarayiciya dusuyor

Google Maps uygulamasi kurulu degilse beklenen davranis budur. Kuruluysa Android app defaults/varsayilan uygulama ayarlari kontrol edilmelidir.

## Test Listesi

- Android emulator veya gercek cihazda uygulama aciliyor.
- Splash screen gorunuyor ve kurye paneli yukleniyor.
- Kurye login mobilde calisiyor.
- Uygulama kapanip acilinca oturum korunuyor.
- Konum izni isteniyor ve hassas konum ile GPS ozellikleri calisiyor.
- Mesai baslatma/bitirme konum hatasi vermiyor.
- Haritada Ac Google Maps uygulamasini, yoksa tarayiciyi aciyor.
- Bildirim izni isteniyor.
- Internet kapaliyken ozel hata ekrani ve `Tekrar dene` calisiyor.
- Android geri tusu WebView gecmisinde geri gidiyor, gecmis yoksa uygulamadan cikiyor.
